/**
 * Dual transport: one contract, two deliveries, and a header that is never
 * assumed.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClipCache } from '../src/cache.js';
import { ModalProxy } from '../src/proxy.js';
import { ScriptStore } from '../src/script.js';
import { VoiceStore } from '../src/voices.js';
import { AsrProxy } from '../src/asr.js';
import { ReferenceStore } from '../src/references.js';
import { createServer, type GatewayServer } from '../src/index.js';
import {
  FormatError,
  durationSeconds,
  frameWav,
  parseAudioFormat,
  readWavHeader,
  wavHeader,
} from '../src/transport.js';
import { makePcm, silentLogger, stubConfig, stubFetch } from './helpers.js';

const headersOf = (values: Record<string, string>): Headers => new Headers(values);

describe('the upstream format is read, never assumed', () => {
  it('parses a well-formed pair of headers', () => {
    const format = parseAudioFormat(
      headersOf({ 'X-Sample-Rate': '24000', 'X-Sample-Format': 's16le' }),
    );
    expect(format).toEqual({
      sampleRate: 24000,
      format: 's16le',
      channels: 1,
      bytesPerSample: 2,
    });
  });

  it('fails loudly on a missing rate rather than assuming 24000', () => {
    // A wrong rate does not fail — it plays at the wrong speed, which reads as
    // a broken model rather than a broken header.
    expect(() => parseAudioFormat(headersOf({ 'X-Sample-Format': 's16le' }))).toThrowError(
      FormatError,
    );
  });

  it('fails loudly on a missing format', () => {
    expect(() => parseAudioFormat(headersOf({ 'X-Sample-Rate': '24000' }))).toThrowError(
      FormatError,
    );
  });

  it('rejects an implausible rate rather than silently accepting it', () => {
    expect(() =>
      parseAudioFormat(headersOf({ 'X-Sample-Rate': '3', 'X-Sample-Format': 's16le' })),
    ).toThrowError(/plausible/);
    expect(() =>
      parseAudioFormat(headersOf({ 'X-Sample-Rate': '2400000', 'X-Sample-Format': 's16le' })),
    ).toThrowError(/plausible/);
  });

  it('rejects an encoding it cannot frame', () => {
    expect(() =>
      parseAudioFormat(headersOf({ 'X-Sample-Rate': '24000', 'X-Sample-Format': 'f32le' })),
    ).toThrowError(/not supported/);
  });
});

describe('WAV framing', () => {
  const format = { sampleRate: 24000, format: 's16le', channels: 1, bytesPerSample: 2 } as const;

  it('produces a header whose values match the upstream ones', () => {
    const pcm = makePcm(24000);
    const parsed = readWavHeader(frameWav(pcm, format));
    expect(parsed.sampleRate).toBe(24000);
    expect(parsed.channels).toBe(1);
    expect(parsed.bytesPerSample).toBe(2);
    expect(parsed.dataBytes).toBe(pcm.length);
  });

  it('carries a non-24k rate through rather than hardcoding one', () => {
    const parsed = readWavHeader(frameWav(makePcm(100), { ...format, sampleRate: 16000 }));
    expect(parsed.sampleRate).toBe(16000);
  });

  it('is exactly 44 bytes of header followed by the payload', () => {
    const pcm = makePcm(1000);
    const wav = frameWav(pcm, format);
    expect(wavHeader(format, pcm.length)).toHaveLength(44);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  it('derives duration exactly rather than estimating it', () => {
    expect(durationSeconds(48_000, format)).toBe(1);
    expect(durationSeconds(24_000, format)).toBe(0.5);
  });
});

describe('both transports accept an identical request', () => {
  let dir: string;
  const servers: GatewayServer[] = [];
  const caches: ClipCache[] = [];

  const build = async (transport: 'streaming' | 'buffered'): Promise<GatewayServer> => {
    const config = stubConfig({
      transport,
      clipCacheDir: join(dir, transport, 'clips'),
      voiceStoreDir: join(dir, transport, 'voices'),
      scriptStoreDir: join(dir, transport, 'scripts'),
      referenceStoreDir: join(dir, transport, 'references'),
    });
    const logger = silentLogger();
    const cache = new ClipCache({
      dir: config.clipCacheDir,
      maxBytes: config.clipCacheMaxBytes,
      logger,
    });
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

    const server = createServer({
      config,
      logger,
      proxy: new ModalProxy({
        config,
        logger,
        fetchImpl: stubFetch([{ chunks: [makePcm(2400), makePcm(2400, 3)] }]),
      }),
      cache,
      voices,
      scripts,
      references,
      asr: new AsrProxy({ config, logger }),
      ffmpeg,
    });
    servers.push(server);
    caches.push(cache);
    return server;
  };

  const request = {
    method: 'POST' as const,
    url: '/api/speech',
    payload: {
      text: 'hello there',
      instruction: 'warm',
      cfg_scale: 1,
      seed: 42,
      mode: 'design',
    },
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'breeze-transport-'));
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a decodable WAV whose header matches upstream in buffered mode', async () => {
    const server = await build('buffered');
    const response = await server.inject(request);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('audio/wav');
    const parsed = readWavHeader(response.rawPayload);
    expect(parsed.sampleRate).toBe(24000);
    expect(parsed.dataBytes).toBe(response.rawPayload.length - 44);
  });

  it('returns raw PCM in streaming mode, with the format headers preserved', async () => {
    const server = await build('streaming');
    const response = await server.inject(request);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('audio/pcm');
    expect(response.headers['x-sample-rate']).toBe('24000');
    expect(response.headers['x-sample-format']).toBe('s16le');
    // No RIFF: streaming mode transforms nothing.
    expect(response.rawPayload.subarray(0, 4).toString('ascii')).not.toBe('RIFF');
  });

  it('leaves byte-identical payloads on disk whichever transport produced them', async () => {
    // The on-disk format must not depend on a setting that happened to be in
    // force at generation time, or a clip's readability becomes a lottery.
    const [buffered, streaming] = servers;
    await Promise.all(caches.map((cache) => cache.whenIdle()));

    const clipsOf = async (server: GatewayServer): Promise<any[]> =>
      JSON.parse((await server.inject({ method: 'GET', url: '/api/clips' })).payload).clips;

    const streamingClips = await clipsOf(streaming!);
    const bufferedClips = await clipsOf(buffered!);

    expect(streamingClips).toHaveLength(1);
    expect(bufferedClips).toHaveLength(1);
    expect(streamingClips[0].bytes).toBe(bufferedClips[0].bytes);
    expect(streamingClips[0].sampleRate).toBe(bufferedClips[0].sampleRate);
    expect(streamingClips[0].format).toBe('s16le');
    expect(streamingClips[0].transport).toBe('streaming');
    expect(bufferedClips[0].transport).toBe('buffered');

    const streamingWav = await streaming!.inject({
      method: 'GET',
      url: `/api/clips/${streamingClips[0].id}`,
    });
    const bufferedWav = await buffered!.inject({
      method: 'GET',
      url: `/api/clips/${bufferedClips[0].id}`,
    });
    expect(streamingWav.rawPayload.equals(bufferedWav.rawPayload)).toBe(true);
  });
});
