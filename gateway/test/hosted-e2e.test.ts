/**
 * Slice 9 — the hosted seams, over a real listening socket.
 *
 * `auth-plugin.test.ts` drives the same gate through `app.inject()`, which is
 * the right tool for the routing rules. These tests exist because two of the
 * properties hosting depends on are properties of a real HTTP client and cannot
 * be observed through an injected request:
 *
 * - a browser decides for itself whether to send a cookie, and an `<audio src>`
 *   sends nothing else at all;
 * - `Secure` is the attribute that decides whether a real client will send that
 *   cookie over plain http.
 *
 * Nothing here needs a GPU, an external network, or a deployment. The socket is
 * an ephemeral one on 127.0.0.1, the same deliberate exception the stream-abort
 * tests already take.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer, type GatewayServer } from '../src/index.js';
import { ModalProxy } from '../src/proxy.js';
import { AsrProxy } from '../src/asr.js';
import { ClipCache } from '../src/cache.js';
import { VoiceStore } from '../src/voices.js';
import { ScriptStore } from '../src/script.js';
import { ReferenceStore } from '../src/references.js';
import { RateLimiter } from '../src/auth/rate-limit.js';
import { SessionStore } from '../src/auth/session.js';
import { DEFAULT_HOST, isExposedHost } from '../src/config.js';
import { silentLogger, stubConfig, stubFetch } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

interface Deployment {
  base: string;
  server: GatewayServer;
  dir: string;
  advance: (ms: number) => void;
}

/**
 * Start a real gateway with the gate enabled.
 *
 * @param exposed - Whether to simulate the hosted listener, which decides
 *   whether the session cookie is marked Secure.
 * @returns The running deployment.
 */
async function deploy(exposed = false): Promise<Deployment> {
  const dir = await mkdtemp(join(tmpdir(), 'breeze-e2e-'));
  const uiDir = join(dir, 'ui');
  await mkdir(uiDir, { recursive: true });
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>console</title>', 'utf8');

  let current = 1_000_000;
  const logger = silentLogger();
  const config = stubConfig({
    passwordHash: await hash(PASSWORD),
    // 0.0.0.0 is what the hosted image passes; the cookie's Secure attribute
    // follows from it, so this is how the hosted shape is reproduced locally.
    host: exposed ? '0.0.0.0' : DEFAULT_HOST,
    uiDir,
    clipCacheDir: join(dir, 'clips'),
    voiceStoreDir: join(dir, 'voices'),
    scriptStoreDir: join(dir, 'scripts'),
    referenceStoreDir: join(dir, 'references'),
    findingsDir: join(dir, 'findings'),
  });

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

  const server = createServer({
    config,
    logger,
    proxy: new ModalProxy({ config, logger, fetchImpl: stubFetch([{}]) }),
    asr: new AsrProxy({ config, logger }),
    cache,
    voices,
    scripts,
    references,
    ffmpeg,
    sessions: new SessionStore({ now: () => current }),
    limiter: new RateLimiter({ now: () => current }),
  });

  // Always loopback for the listener itself: `config.host` describes the
  // deployment being simulated, not where a test may bind.
  await server.listen({ port: 0, host: '127.0.0.1' });
  const { port } = server.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    dir,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Extract the session cookie a real client would store and resend. */
function sessionCookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
}

describe('the hosted gate over a real socket', () => {
  let local: Deployment;
  let hosted: Deployment;

  beforeAll(async () => {
    [local, hosted] = await Promise.all([deploy(false), deploy(true)]);
  });

  afterAll(async () => {
    await Promise.all([local.server.close(), hosted.server.close()]);
    await Promise.all([
      rm(local.dir, { recursive: true, force: true }),
      rm(hosted.dir, { recursive: true, force: true }),
    ]);
  });

  it('refuses an API route to a real unauthenticated client', async () => {
    const response = await fetch(`${local.base}/api/voices`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe('auth');
  });

  it('serves the shell to a real unauthenticated client', async () => {
    // The deliberate exemption. A browser must be able to load the bundle that
    // renders the password field.
    const response = await fetch(`${local.base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<!doctype html>');
  });

  it('puts no credential or upstream URL in the shell it serves to strangers', async () => {
    const body = await (await fetch(`${local.base}/`)).text();
    expect(body).not.toMatch(/\b(wk|ws)-[A-Za-z0-9_-]{4,}/);
    expect(body).not.toContain('.modal.run');
  });

  it('completes the login exchange and then serves the API', async () => {
    const login = await fetch(`${local.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(204);

    const cookie = sessionCookieFrom(login);
    expect(cookie).toContain('breeze_session=');

    const authed = await fetch(`${local.base}/api/voices`, { headers: { cookie } });
    expect(authed.status).toBe(200);
  });

  it('authenticates a media request carrying only the cookie, as <audio src> does', async () => {
    // This is the constraint that chose cookies over bearer tokens: an audio
    // element and a download link send no custom headers, so a regression here
    // is silent until someone presses play.
    const login = await fetch(`${local.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = sessionCookieFrom(login);

    const media = await fetch(`${local.base}/api/clips`, {
      method: 'GET',
      headers: { cookie },
    });
    expect(media.status).toBe(200);
  });

  it('refuses once the session has expired', async () => {
    const login = await fetch(`${local.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = sessionCookieFrom(login);

    local.advance(61 * 60 * 1000);
    const after = await fetch(`${local.base}/api/voices`, { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it('rate-limits a real client and stops being an oracle for the password', async () => {
    const attempt = (password: string): Promise<Response> =>
      fetch(`${hosted.base}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });

    let sawLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const response = await attempt('wrong');
      if (response.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);

    // Even the correct password is refused while the window is spent.
    expect((await attempt(PASSWORD)).status).toBe(429);
    hosted.advance(10 * 60 * 1000);
  });
});

describe('both configuration paths', () => {
  it('marks the cookie Secure when hosted and not when loopback', async () => {
    // A default only one path exercises is a default that drifts — and a Secure
    // cookie over plain http is never sent, which would make a gate enabled on
    // a loopback listener impossible to log into.
    const [local, hosted] = await Promise.all([deploy(false), deploy(true)]);
    try {
      const body = JSON.stringify({ password: PASSWORD });
      const headers = { 'content-type': 'application/json' };

      const localLogin = await fetch(`${local.base}/api/session`, { method: 'POST', headers, body });
      const hostedLogin = await fetch(`${hosted.base}/api/session`, { method: 'POST', headers, body });

      expect(localLogin.headers.get('set-cookie')).not.toContain('Secure');
      expect(hostedLogin.headers.get('set-cookie')).toContain('Secure');
      for (const login of [localLogin, hostedLogin]) {
        expect(login.headers.get('set-cookie')).toContain('HttpOnly');
        expect(login.headers.get('set-cookie')).toContain('SameSite=Lax');
      }
    } finally {
      await Promise.all([local.server.close(), hosted.server.close()]);
      await Promise.all([
        rm(local.dir, { recursive: true, force: true }),
        rm(hosted.dir, { recursive: true, force: true }),
      ]);
    }
  });

  it('agrees with the host classification the startup log and cookie both read', () => {
    expect(isExposedHost(DEFAULT_HOST)).toBe(false);
    expect(isExposedHost('0.0.0.0')).toBe(true);
  });
});

describe('a request body the route does not need', () => {
  /**
   * The defect this covers shipped and broke only in production.
   *
   * `POST /api/wake` takes no payload, and a browser's
   * `fetch(url, {method:'POST'})` sends neither a body nor a content-type.
   * Straight to the local listener Fastify tolerated that; the same request
   * through Modal's proxy arrived shaped so that Fastify answered 415, which
   * the error handler then flattened into a 500 labelled 'upstream' — a
   * content-type mistake wearing the costume of a GPU failure.
   *
   * Nothing caught it because every test drove the route with a well-formed
   * request, and the browser is the one caller that does not.
   */
  let d: Deployment;

  beforeAll(async () => {
    d = await deploy(false);
  });
  afterAll(async () => {
    await d.server.close();
    await rm(d.dir, { recursive: true, force: true });
  });

  async function session(): Promise<string> {
    const login = await fetch(`${d.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    return sessionCookieFrom(login);
  }

  /**
   * Issue a request with framing `fetch` will not let us choose.
   *
   * undici treats `transfer-encoding` as a forbidden header, so the one shape
   * that reproduces this defect is unreachable through fetch. node:http will
   * send it.
   */
  function rawRequest(
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${d.base}${path}`);
      const request = httpRequest(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
        (response) => {
          let text = '';
          response.on('data', (chunk) => { text += String(chunk); });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
        },
      );
      request.on('error', reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  it('accepts a bodyless POST framed the way Modal\'s proxy frames one', async () => {
    // `Transfer-Encoding: chunked` with no content-length and no content-type
    // is the exact shape the proxy forwards, and it is what a plain
    // `fetch(url, {method:'POST'})` became in production. Sent explicitly here
    // because the shape is the bug: the same request straight to a local
    // listener carries content-length: 0 and Fastify tolerates it, which is
    // why nothing caught this before it shipped.
    const cookie = await session();
    const response = await rawRequest('/api/wake', { cookie, 'Transfer-Encoding': 'chunked' });
    // The discriminator is the media-type refusal, not the status: this harness
    // stubs upstream with PCM, so the handler is reached and then fails on the
    // stub. Reaching it at all is the property under test.
    expect(response.status).not.toBe(415);
    expect(response.body).not.toMatch(/Unsupported Media Type/i);
  });

  it('accepts a bodyless DELETE of the session', async () => {
    const cookie = await session();
    const response = await fetch(`${d.base}/api/session`, { method: 'DELETE', headers: { cookie } });
    expect(response.status).toBe(204);
  });

  it('still refuses actual content it cannot parse, with 415 and not 500', async () => {
    // The tolerance is for EMPTY bodies only, decided by whether bytes arrive
    // rather than by headers. Something with content in it must still declare a
    // type it can be parsed as, or this becomes a way to post an unparsed body
    // at any route.
    const cookie = await session();
    const response = await fetch(`${d.base}/api/wake`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-shrubbery' },
      body: 'not parseable as anything',
    });
    expect(response.status).toBe(415);
  });

  it('reports a framework 4xx as the caller-side failure it is', async () => {
    // Reported as 'upstream' this sends someone to check a GPU that is fine.
    const cookie = await session();
    const response = await fetch(`${d.base}/api/wake`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-shrubbery' },
      body: 'nope',
    });
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe('validation');
    expect(body.error.type).not.toBe('upstream');
  });
});
