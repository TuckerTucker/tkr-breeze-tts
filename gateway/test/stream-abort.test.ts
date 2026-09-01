/**
 * What reaches the browser when upstream answers 200 and then fails.
 *
 * The vendor raises inside its own generator — a warmup-profile miss is the
 * live example — long after FastAPI has committed to a 200. So the gateway
 * receives headers, then a socket close, and the reason never crosses the wire.
 *
 * These run against a real listening server rather than `inject`. The defect
 * under test was Fastify rejecting a JSON object on a reply already committed
 * to `audio/pcm`, and only a real socket can show what the client is left
 * holding.
 */

import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { ClipCache } from '../src/cache.js';
import { ModalProxy } from '../src/proxy.js';
import { ScriptStore } from '../src/script.js';
import { VoiceStore } from '../src/voices.js';
import { createServer, type GatewayServer } from '../src/index.js';
import { makePcm, silentLogger, stubConfig, stubFetch, type StubUpstream } from './helpers.js';

describe('an upstream that fails after committing to 200', () => {
  let dir: string;
  const servers: GatewayServer[] = [];
  const caches: ClipCache[] = [];

  const start = async (name: string, upstream: StubUpstream): Promise<string> => {
    const config = stubConfig({
      clipCacheDir: join(dir, name, 'clips'),
      voiceStoreDir: join(dir, name, 'voices'),
      scriptStoreDir: join(dir, name, 'scripts'),
    });
    const logger = silentLogger();
    const cache = new ClipCache({
      dir: config.clipCacheDir,
      maxBytes: config.clipCacheMaxBytes,
      logger,
    });
    const voices = new VoiceStore({ dir: config.voiceStoreDir, logger });
    const scripts = new ScriptStore({ dir: config.scriptStoreDir, logger });
    await Promise.all([cache.load(), voices.load(), scripts.load()]);

    const server = createServer({
      config,
      logger,
      proxy: new ModalProxy({ config, logger, fetchImpl: stubFetch([upstream]) }),
      cache,
      voices,
      scripts,
      ffmpeg: { available: true, version: 'stub', remedy: null },
    });
    servers.push(server);
    caches.push(cache);

    await server.listen({ port: 0, host: '127.0.0.1' });
    const { port } = server.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const speak = (base: string): Promise<Response> =>
    fetch(`${base}/api/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hello there',
        instruction: 'warm',
        cfg_scale: 1,
        seed: 42,
        mode: 'design',
      }),
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'breeze-abort-'));
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
    await rm(dir, { recursive: true, force: true });
  });

  it('answers a failure before the first byte with a typed error, not a broken one', async () => {
    // The live shape: the vendor raises while building its branch batch, so
    // nothing is written and the reply is still retractable. It was not
    // retracted — `reply.type('audio/pcm')` had already been declared, and
    // Fastify rejected the JSON failure beneath it with
    // FST_ERR_REP_INVALID_PAYLOAD_TYPE, turning one upstream fault into two,
    // the second of them ours and untrue. Withdrawing the declaration is what
    // lets the real one through.
    const base = await start('none', { chunks: [makePcm(2400)], abortAfter: 0 });
    const response = await speak(base);

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as {
      error: { type: string; message: string; remedy?: string };
    };
    expect(body.error.type).toBe('upstream');
    expect(body.error.message).toMatch(/closed the stream without sending audio/);
    // undici's word for a dropped socket is not an explanation, and it was the
    // whole of what an operator used to be given.
    expect(body.error.message).not.toMatch(/terminated/);
    expect(body.error.message).not.toContain('INVALID_PAYLOAD_TYPE');
    expect(body.error.remedy).toBeTruthy();
    // The credential and the endpoint stay out of it, as on every other path.
    expect(body.error.message).not.toContain('modal.run');
  });

  it('leaves no clip behind when no audio was produced', async () => {
    // A zero-byte clip in history would be a generation that appears to have
    // happened. The writer aborts instead.
    const cache = caches[caches.length - 1]!;
    await cache.whenIdle();
    expect(cache.list()).toHaveLength(0);
  });

  it('gives the client the bytes that did arrive, then breaks the read', async () => {
    // Truncation is the only signal left once audio is on the wire, so it has
    // to be a clean one: the reader throws rather than reporting a short but
    // complete clip.
    const base = await start('partial', {
      chunks: [makePcm(2400), makePcm(2400, 3)],
      abortAfter: 1,
      // Long enough for the first chunk to reach the socket, which is what
      // commits the reply and puts the JSON failure out of reach.
      delayMs: 50,
    });
    const response = await speak(base);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/pcm');

    const reader = response.body!.getReader();
    let bytes = 0;
    let threw = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength ?? 0;
      }
    } catch {
      threw = true;
    }

    expect(bytes).toBeGreaterThan(0);
    expect(threw).toBe(true);
  });

  it('still answers a fault raised before the reply is committed with a typed error', async () => {
    // The guard must not swallow the ordinary case: nothing has been written
    // yet, so the failure is still deliverable as JSON.
    const base = await start('upfront', { status: 409, body: 'busy' });
    const response = await speak(base);

    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe('busy');
  });
});
