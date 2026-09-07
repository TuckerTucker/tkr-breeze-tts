/**
 * Slice 5 — the gate in front of every route that carries data.
 *
 * The central assertion is the asymmetry: `/api/*` is refused without a
 * session, and the static shell is served without one. Both halves are pinned,
 * because the shell exemption is a decision someone will later be tempted to
 * "fix" into a hole-free-looking gate that nobody can log into.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer, type GatewayServer } from '../src/index.js';
import { ModalProxy } from '../src/proxy.js';
import { AsrProxy } from '../src/asr.js';
import { ClipCache } from '../src/cache.js';
import { VoiceStore } from '../src/voices.js';
import { ScriptStore } from '../src/script.js';
import { ReferenceStore } from '../src/references.js';
import { RateLimiter } from '../src/auth/rate-limit.js';
import { SessionStore } from '../src/auth/session.js';
import {
  SESSION_COOKIE,
  readCookie,
  requiresSession,
  resolveClientKey,
  sessionCookie,
} from '../src/auth/plugin.js';
import { silentLogger, stubConfig, stubFetch } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

interface Harness {
  app: GatewayServer;
  clock: { now: () => number; advance: (ms: number) => void };
  dir: string;
}

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

/**
 * Build a real server with the gate enabled and a built UI on disk.
 *
 * @param overrides - Configuration to change, e.g. to disable the gate.
 * @returns The server, its clock, and the temp directory to clean up.
 */
async function harness(
  overrides: Parameters<typeof stubConfig>[0] = {},
  limiter = new RateLimiter(),
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'breeze-gate-'));
  const uiDir = join(dir, 'ui');
  await mkdir(uiDir, { recursive: true });
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>console</title>', 'utf8');
  await writeFile(join(uiDir, 'pcm-processor.js'), '// worklet', 'utf8');

  const passwordHash = await hash(PASSWORD);
  const config = stubConfig({
    passwordHash,
    uiDir,
    clipCacheDir: join(dir, 'clips'),
    voiceStoreDir: join(dir, 'voices'),
    scriptStoreDir: join(dir, 'scripts'),
    referenceStoreDir: join(dir, 'references'),
    findingsDir: join(dir, 'findings'),
    ...overrides,
  });

  const logger = silentLogger();
  const clock = fakeClock();
  const ffmpeg = { available: true, version: 'stub', remedy: null } as const;
  const cache = new ClipCache({
    dir: config.clipCacheDir,
    maxBytes: config.clipCacheMaxBytes,
    logger,
  });
  const voices = new VoiceStore({ dir: config.voiceStoreDir, logger });
  const scripts = new ScriptStore({ dir: config.scriptStoreDir, logger });
  const references = new ReferenceStore({
    dir: config.referenceStoreDir,
    maxAgeMs: config.referenceMaxAgeMs,
    logger,
    ffmpeg,
  });
  await Promise.all([cache.load(), voices.load(), scripts.load(), references.load()]);

  const app = createServer({
    config,
    logger,
    proxy: new ModalProxy({ config, logger, fetchImpl: stubFetch([{}]) }),
    asr: new AsrProxy({ config, logger }),
    cache,
    voices,
    scripts,
    references,
    ffmpeg,
    sessions: new SessionStore({ now: clock.now }),
    limiter,
  });
  await app.ready();
  return { app, clock, dir };
}

/** Log in and return the cookie value a browser would then send. */
async function login(app: GatewayServer, password = PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/session',
    payload: { password },
  });
  expect(response.statusCode).toBe(204);
  const setCookie = response.headers['set-cookie'] as string;
  return readCookie(setCookie.split(';')[0], SESSION_COOKIE)!;
}

describe('requiresSession', () => {
  it('gates every API route', () => {
    expect(requiresSession('GET', '/api/health')).toBe(true);
    expect(requiresSession('GET', '/api/voices')).toBe(true);
    expect(requiresSession('GET', '/api/clips/abc?format=wav')).toBe(true);
    expect(requiresSession('POST', '/api/speech')).toBe(true);
  });

  it('exempts the login exchange and nothing else under /api', () => {
    expect(requiresSession('POST', '/api/session')).toBe(false);
    expect(requiresSession('DELETE', '/api/session')).toBe(false);
    // A GET to the same path is not the exchange and stays gated, so the
    // exemption cannot be widened by changing verb.
    expect(requiresSession('GET', '/api/session')).toBe(true);
  });

  it('exempts the static shell, which is what renders the password field', () => {
    expect(requiresSession('GET', '/')).toBe(false);
    expect(requiresSession('GET', '/index.html')).toBe(false);
    expect(requiresSession('GET', '/assets/index-a1b2c3.js')).toBe(false);
    expect(requiresSession('GET', '/pcm-processor.js')).toBe(false);
  });
});

describe('sessionCookie', () => {
  it('is HttpOnly and SameSite=Lax, and Secure only when exposed', () => {
    expect(sessionCookie('abc', true)).toContain('Secure');
    // A Secure cookie is never sent over plain http, so a gate enabled on a
    // loopback listener would otherwise be impossible to log into.
    expect(sessionCookie('abc', false)).not.toContain('Secure');
    for (const cookie of [sessionCookie('abc', true), sessionCookie('abc', false)]) {
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
    }
  });

  it('clears with Max-Age=0', () => {
    expect(sessionCookie(null, true)).toContain('Max-Age=0');
  });
});

describe('resolveClientKey', () => {
  it('uses the socket address when the listener is not behind a proxy', () => {
    expect(resolveClientKey('10.0.0.9', '1.1.1.1', false)).toBe('10.0.0.9');
  });

  it('takes the right-most forwarded hop, which the adjacent proxy wrote', () => {
    // Left-most is attacker-supplied: a client sends its own X-Forwarded-For
    // and the proxy appends to it. Trusting that would defeat the limiter with
    // a header.
    expect(resolveClientKey('10.0.0.1', '9.9.9.9, 203.0.113.7', true)).toBe('203.0.113.7');
  });

  it('does not let a forged header separate one attacker into many keys', () => {
    const forged = ['1.1.1.1, 203.0.113.7', '2.2.2.2, 203.0.113.7', '3.3.3.3, 203.0.113.7'];
    const keys = new Set(forged.map((header) => resolveClientKey('10.0.0.1', header, true)));
    expect(keys).toEqual(new Set(['203.0.113.7']));
  });

  it('falls back to the socket address when no header is present', () => {
    expect(resolveClientKey('10.0.0.1', undefined, true)).toBe('10.0.0.1');
    expect(resolveClientKey(undefined, undefined, true)).toBe('unknown');
  });
});

describe('the gate over a real server', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.app.close();
    await rm(h.dir, { recursive: true, force: true });
  });

  it('refuses API routes without a session, with the typed auth envelope', async () => {
    for (const url of ['/api/health', '/api/voices', '/api/clips']) {
      const response = await h.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { type: 'auth' } });
    }
  });

  it('serves the static shell without a session, so the gate can render', async () => {
    for (const url of ['/', '/index.html', '/pcm-processor.js']) {
      const response = await h.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
    }
  });

  it('leaks neither the credential nor the upstream URL in the public shell', async () => {
    // The shell being public is a decision, so the reason it is safe is
    // asserted rather than assumed.
    const response = await h.app.inject({ method: 'GET', url: '/' });
    expect(response.body).not.toMatch(/wk-|ws-/);
    expect(response.body).not.toContain('modal.run');
  });

  it('serves API routes once a session exists', async () => {
    const session = await login(h.app);
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('authenticates a plain GET carrying only the cookie, as <audio src> does', async () => {
    // This is the constraint that chose cookies over bearer tokens. A
    // regression here is silent until someone presses play.
    const session = await login(h.app);
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/clips',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a wrong password without saying anything about it', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { password: 'wrong' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    const message = response.json().error.message as string;
    expect(message).not.toMatch(/length|character|short|long/i);
  });

  it('refuses a forged session id', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: `${SESSION_COOKIE}=made-up` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses an expired session, driven by the injected clock', async () => {
    const session = await login(h.app);
    h.clock.advance(61 * 60 * 1000);
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { type: 'auth' } });
  });

  it('ends a session on sign-out', async () => {
    const session = await login(h.app);
    const out = await h.app.inject({
      method: 'DELETE',
      url: '/api/session',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(out.statusCode).toBe(204);

    const after = await h.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('rate-limits repeated failures with 429 and no hint about correctness', async () => {
    const limited = await harness({}, new RateLimiter({ maxAttempts: 3 }));
    try {
      for (let i = 0; i < 3; i += 1) {
        const response = await limited.app.inject({
          method: 'POST',
          url: '/api/session',
          payload: { password: 'wrong' },
        });
        expect(response.statusCode).toBe(401);
      }

      // Even the right password is refused once the window is spent, so the
      // limiter cannot be used as an oracle for password correctness.
      const blocked = await limited.app.inject({
        method: 'POST',
        url: '/api/session',
        payload: { password: PASSWORD },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: { type: 'auth' } });
    } finally {
      await limited.app.close();
      await rm(limited.dir, { recursive: true, force: true });
    }
  });

  it('refuses a non-string password without throwing', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { password: { toString: 'not a string' } },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('with no password hash configured', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness({ passwordHash: null });
  });
  afterEach(async () => {
    await h.app.close();
    await rm(h.dir, { recursive: true, force: true });
  });

  it('behaves exactly as the local demo always has', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
  });

  it('registers no login route at all, rather than an open one', async () => {
    // An explicit branch, not an accident of empty configuration.
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { password: 'anything' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('never sets a session cookie', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
