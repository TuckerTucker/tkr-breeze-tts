/**
 * The clip cache: replay without a GPU, one on-disk format, bounded growth.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClipCache } from '../src/cache.js';
import {
  cueCacheKey,
  newestFirst,
  selectForEviction,
  validateRecord,
  type ClipRecord,
  type ClipRequest,
} from '../src/cache-index.js';
import { ModalProxy } from '../src/proxy.js';
import { ScriptStore } from '../src/script.js';
import { VoiceStore } from '../src/voices.js';
import { AsrProxy } from '../src/asr.js';
import { ReferenceStore } from '../src/references.js';
import { createServer, type GatewayServer } from '../src/index.js';
import { readWavHeader } from '../src/transport.js';
import { makePcm, silentLogger, stubConfig } from './helpers.js';

const FORMAT = { sampleRate: 24000, format: 's16le', channels: 1, bytesPerSample: 2 } as const;

const request = (text: string): ClipRequest => ({
  text,
  instruction: 'A warm, thoughtful young woman, calm delivery.',
  mode: 'design',
  cfgScale: 1,
  seed: 42,
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'breeze-cache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function openCache(maxBytes = 10 * 1024 * 1024): Promise<ClipCache> {
  const cache = new ClipCache({ dir, maxBytes, logger: silentLogger() });
  await cache.load();
  return cache;
}

describe('storage and replay', () => {
  it('stores raw PCM and frames it as WAV only at read', async () => {
    const cache = await openCache();
    const pcm = makePcm(2400);
    const record = await cache.put(pcm, {
      format: FORMAT,
      ttfaMs: 38,
      transport: 'streaming',
      request: request('hello'),
    });

    expect(record).not.toBeNull();
    // The bytes on disk are exactly what Modal emitted.
    expect((await readFile(cache.pcmPath(record!.id))).equals(pcm)).toBe(true);

    const wav = await cache.readWav(record!.id);
    const header = readWavHeader(wav!);
    expect(header.sampleRate).toBe(24000);
    expect(header.dataBytes).toBe(pcm.length);
    expect(wav!.subarray(44).equals(pcm)).toBe(true);
  });

  it('frames replay from the sidecar values, not from a hardcoded rate', async () => {
    const cache = await openCache();
    const record = await cache.put(makePcm(1200), {
      format: { ...FORMAT, sampleRate: 16000 },
      ttfaMs: null,
      transport: 'buffered',
      request: request('other rate'),
    });
    expect(readWavHeader((await cache.readWav(record!.id))!).sampleRate).toBe(16000);
  });

  it('keeps the request provenance beside each clip', async () => {
    const cache = await openCache();
    const record = await cache.put(makePcm(600), {
      format: FORMAT,
      ttfaMs: 41,
      transport: 'streaming',
      request: { ...request('provenance'), seed: 17, cfgScale: 4 },
    });
    // This is what makes an A/B comparison in the UI possible at all.
    expect(record!.request.seed).toBe(17);
    expect(record!.request.cfgScale).toBe(4);
    expect(record!.ttfaMs).toBe(41);
    expect(record!.durationSeconds).toBeCloseTo(600 / 24000, 6);
  });

  it('survives a restart by rebuilding the index from the sidecars', async () => {
    const first = await openCache();
    const record = await first.put(makePcm(600), {
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: request('persisted'),
    });

    const second = await openCache();
    expect(second.get(record!.id)?.request.text).toBe('persisted');
  });
});

describe('replay never reaches the GPU', () => {
  let servers: GatewayServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
  });

  it('serves a cached clip with the upstream unreachable', async () => {
    const config = stubConfig({
      clipCacheDir: join(dir, 'clips'),
      voiceStoreDir: join(dir, 'voices'),
      scriptStoreDir: join(dir, 'scripts'),
      referenceStoreDir: join(dir, 'references'),
    });
    const logger = silentLogger();
    const cache = new ClipCache({ dir: config.clipCacheDir, maxBytes: 1e9, logger });
    const voices = new VoiceStore({ dir: config.voiceStoreDir, logger });
    const scripts = new ScriptStore({ dir: config.scriptStoreDir, logger });
    const ffmpeg = { available: true, version: 'stub', remedy: null } as const;
    const references = new ReferenceStore({
      dir: config.referenceStoreDir,
      maxAgeMs: config.referenceMaxAgeMs,
      logger,
      ffmpeg,
    });
    await Promise.all([cache.load(), voices.load(), scripts.load(), references.load()]);

    const record = await cache.put(makePcm(2400), {
      format: FORMAT,
      ttfaMs: 38,
      transport: 'streaming',
      request: request('already generated'),
    });

    let upstreamCalls = 0;
    const server = createServer({
      config,
      logger,
      proxy: new ModalProxy({
        config,
        logger,
        fetchImpl: (async () => {
          upstreamCalls += 1;
          throw new Error('ECONNREFUSED — the container is scaled to zero');
        }) as unknown as typeof fetch,
      }),
      cache,
      voices,
      scripts,
      references,
      asr: new AsrProxy({ config, logger }),
      ffmpeg,
    });
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: `/api/clips/${record!.id}` });
    expect(response.statusCode).toBe(200);
    expect(readWavHeader(response.rawPayload).dataBytes).toBe(4800);
    // Re-auditioning works while the container is scaled to zero, and costs
    // nothing.
    expect(upstreamCalls).toBe(0);
  });
});

describe('integrity', () => {
  it('drops a clip whose payload was truncated rather than serving it', async () => {
    const cache = await openCache();
    const record = await cache.put(makePcm(2400), {
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: request('will be corrupted'),
    });
    await writeFile(cache.pcmPath(record!.id), Buffer.alloc(10));

    const reopened = await openCache();
    // A truncated clip served at its declared length plays, and is wrong.
    expect(reopened.get(record!.id)).toBeUndefined();
    expect(reopened.list()).toHaveLength(0);
  });

  it('drops a sidecar with no sample rate rather than guessing one', async () => {
    const cache = await openCache();
    const record = await cache.put(makePcm(600), {
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: request('no rate'),
    });
    const sidecar = JSON.parse(await readFile(cache.sidecarPath(record!.id), 'utf8'));
    delete sidecar.sampleRate;
    await writeFile(cache.sidecarPath(record!.id), JSON.stringify(sidecar));

    expect((await openCache()).list()).toHaveLength(0);
  });

  it('drops an unparseable sidecar', async () => {
    const cache = await openCache();
    const record = await cache.put(makePcm(600), {
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: request('bad json'),
    });
    await writeFile(cache.sidecarPath(record!.id), '{ not json');
    expect((await openCache()).list()).toHaveLength(0);
  });

  it('validates records without touching a disk', () => {
    expect(validateRecord(null)).toBeNull();
    expect(validateRecord({ id: 'x' })).toBeNull();
    expect(
      validateRecord({
        id: 'x',
        createdAt: 1,
        bytes: 100,
        sampleRate: 24000,
        format: 's16le',
        request: {},
      }),
    ).not.toBeNull();
  });
});

describe('bounded growth', () => {
  it('evicts oldest-first at the limit', async () => {
    const cache = await openCache(5_000);
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const record = await cache.put(makePcm(1000), {
        format: FORMAT,
        ttfaMs: null,
        transport: 'streaming',
        request: request(`clip ${index}`),
      });
      ids.push(record!.id);
      // Distinct timestamps, so "oldest" is unambiguous.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(cache.totalBytes()).toBeLessThanOrEqual(5_000);
    expect(cache.get(ids[0]!)).toBeUndefined();
    expect(cache.get(ids[3]!)).toBeDefined();
  });

  it('selects eviction candidates without a filesystem', () => {
    const records = [
      { id: 'a', createdAt: 3, bytes: 100 },
      { id: 'b', createdAt: 1, bytes: 100 },
      { id: 'c', createdAt: 2, bytes: 100 },
    ] as ClipRecord[];
    expect(selectForEviction(records, 300)).toEqual([]);
    expect(selectForEviction(records, 250)).toEqual(['b']);
    expect(selectForEviction(records, 150)).toEqual(['b', 'c']);
  });

  it('lists newest first', () => {
    const records = [
      { id: 'a', createdAt: 1 },
      { id: 'c', createdAt: 3 },
      { id: 'b', createdAt: 2 },
    ] as ClipRecord[];
    expect(newestFirst(records).map((record) => record.id)).toEqual(['c', 'b', 'a']);
  });

  it('keeps synthesis working when caching is disabled', async () => {
    const cache = await openCache();
    cache.disable('disk full');
    const writer = cache.beginWrite();
    writer.write(makePcm(100));
    // The writer still accepts chunks, so callers never branch on cache health.
    expect(await writer.finalize({
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: request('uncached'),
    })).toBeNull();
    expect(cache.enabled).toBe(false);
  });
});

describe('cue cache keys', () => {
  it('are stable for identical inputs and differ for any change', () => {
    const base = { text: 'We need to move.', voiceId: 'v1', cfgScale: 1, seed: 42 };
    expect(cueCacheKey(base)).toBe(cueCacheKey({ ...base }));
    expect(cueCacheKey(base)).not.toBe(cueCacheKey({ ...base, text: 'We need to go.' }));
    expect(cueCacheKey(base)).not.toBe(cueCacheKey({ ...base, voiceId: 'v2' }));
    expect(cueCacheKey(base)).not.toBe(cueCacheKey({ ...base, cfgScale: 4 }));
    expect(cueCacheKey(base)).not.toBe(cueCacheKey({ ...base, seed: 17 }));
  });
});
