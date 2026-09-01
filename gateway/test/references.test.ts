/** Staged references: one intake, one transcription, bounded retention, trim at send. */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  AsrProxy,
  EMPTY_TRANSCRIPTION,
  type Transcription,
} from '../src/asr.js';
import { ClipCache } from '../src/cache.js';
import {
  MAX_AUDIO_UPLOAD_BYTES,
  createServer,
  type GatewayServer,
} from '../src/index.js';
import { ModalProxy } from '../src/proxy.js';
import { ReferenceStore, type ReferenceRecord } from '../src/references.js';
import { ScriptStore } from '../src/script.js';
import { frameWav } from '../src/transport.js';
import { VoiceStore } from '../src/voices.js';
import {
  makeAudioFixtures,
  makePcm,
  silentLogger,
  stubConfig,
  stubFetch,
  type AudioFixtures,
} from './helpers.js';

const run = promisify(execFile);
const FFMPEG = { available: true, version: 'test', remedy: null } as const;
const FORMAT = {
  sampleRate: 24_000,
  format: 's16le',
  channels: 1,
  bytesPerSample: 2,
} as const;

let root: string;
let fixtures: AudioFixtures;
const servers: GatewayServer[] = [];

beforeAll(async () => {
  fixtures = await makeAudioFixtures();
});

afterAll(async () => {
  await fixtures.cleanup();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  if (root) await rm(root, { recursive: true, force: true });
});

function multipartAudio(audio: Buffer): { payload: Buffer; contentType: string } {
  const boundary = 'breeze-reference-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="reference.wav"\r\n' +
      'Content-Type: audio/wav\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, audio, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

interface TestServer {
  readonly server: GatewayServer;
  readonly config: ReturnType<typeof stubConfig>;
  readonly references: ReferenceStore;
  readonly voices: VoiceStore;
}

async function buildServer(options: {
  asrEndpoint?: string | null;
  asrFetch?: typeof fetch;
  speechFetch?: ReturnType<typeof stubFetch>;
} = {}): Promise<TestServer> {
  root = await mkdtemp(join(tmpdir(), 'breeze-staged-reference-'));
  const config = stubConfig({
    asrEndpoint: options.asrEndpoint ?? null,
    clipCacheDir: join(root, 'clips'),
    voiceStoreDir: join(root, 'voices'),
    scriptStoreDir: join(root, 'scripts'),
    referenceStoreDir: join(root, 'references'),
    findingsDir: join(root, 'findings'),
  });
  const logger = silentLogger();
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
    ffmpeg: FFMPEG,
  });
  await Promise.all([cache.load(), voices.load(), scripts.load(), references.load()]);
  const server = createServer({
    config,
    logger,
    proxy: new ModalProxy({
      config,
      logger,
      fetchImpl: options.speechFetch ?? stubFetch([{}]),
    }),
    cache,
    voices,
    scripts,
    references,
    asr: new AsrProxy({ config, logger, fetchImpl: options.asrFetch }),
    ffmpeg: FFMPEG,
  });
  servers.push(server);
  return { server, config, references, voices };
}

async function stage(server: GatewayServer, wav: Buffer): Promise<ReferenceRecord> {
  const multipart = multipartAudio(wav);
  const response = await server.inject({
    method: 'POST',
    url: '/api/reference',
    headers: { 'content-type': multipart.contentType },
    payload: multipart.payload,
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.payload) as ReferenceRecord;
}

describe('ASR proxy', () => {
  it('posts the normalised WAV to the live route with server-side credentials', async () => {
    const config = stubConfig({ asrEndpoint: 'https://example--breeze-asr.modal.run' });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          text: 'hello world',
          language: 'en',
          duration: 1,
          words: [
            { word: 'hello', start: 0, end: 0.4 },
            { word: ' world', start: 0.5, end: 0.9 },
          ],
        }),
      );
    }) as typeof fetch;
    const asr = new AsrProxy({ config, logger: silentLogger(), fetchImpl });

    const result = await asr.transcribe(fixtures.wav);
    expect(result.text).toBe('hello world');
    expect(calls[0]!.url).toBe(
      `${config.asrEndpoint}/v1/audio/transcriptions`,
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Modal-Key']).toBe(config.key);
    expect(headers['Modal-Secret']).toBe(config.secret);
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
  });

  it('degrades an upstream failure to an empty transcript and reports it', async () => {
    const config = stubConfig({ asrEndpoint: 'https://example--breeze-asr.modal.run' });
    const asr = new AsrProxy({
      config,
      logger: silentLogger(),
      fetchImpl: (async () => new Response('broken', { status: 500 })) as typeof fetch,
    });
    expect(await asr.transcribe(fixtures.wav)).toEqual(EMPTY_TRANSCRIPTION);
    expect(asr.status()).toMatchObject({ available: false, configured: true });
    expect(asr.status().lastError).toContain('returned 500');
  });
});

describe('intake and reuse', () => {
  it('stages usable audio when ASR is absent and exposes the remedy in health', async () => {
    expect(MAX_AUDIO_UPLOAD_BYTES).toBeGreaterThanOrEqual(
      44_100 * 2 * 2 * 40 * 60,
    );
    const { server } = await buildServer();
    const reference = await stage(server, fixtures.webm);
    expect(reference.durationSeconds).toBeCloseTo(1, 2);
    expect(reference.sampleRate).toBe(24_000);
    expect(reference.peaks).toHaveLength(512);
    expect(reference.words).toEqual([]);
    expect(reference.transcript).toBe('');

    const health = JSON.parse(
      (await server.inject({ method: 'GET', url: '/api/health' })).payload,
    );
    expect(health.asr.available).toBe(false);
    expect(health.asr.remedy).toContain('modal deploy infra/asr.py');
  });

  it('uploads and transcribes once, then trims the same id for two syntheses', async () => {
    let transcriptionCalls = 0;
    const asrFetch = (async () => {
      transcriptionCalls += 1;
      return new Response(
        JSON.stringify({
          text: 'hello world',
          language: 'en',
          duration: 1,
          words: [
            { word: 'hello', start: 0, end: 0.4 },
            { word: ' world', start: 0.5, end: 0.9 },
          ],
        }),
      );
    }) as typeof fetch;
    const speechFetch = stubFetch([{}]);
    const { server } = await buildServer({
      asrEndpoint: 'https://example--breeze-asr.modal.run',
      asrFetch,
      speechFetch,
    });
    const reference = await stage(server, fixtures.wav);

    for (const text of ['first line', 'second line']) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/speech',
        payload: {
          text,
          mode: 'clone',
          cfg_scale: 1,
          reference_id: reference.id,
          ref_start: 0,
          ref_end: 1,
        },
      });
      expect(response.statusCode).toBe(200);
    }

    expect(transcriptionCalls).toBe(1);
    expect(speechFetch.calls).toHaveLength(2);
    for (const call of speechFetch.calls) {
      const form = call.init.body as FormData;
      expect(form.get('ref_text')).toBe('hello world');
      expect(form.get('ref_audio')).toBeInstanceOf(Blob);
    }
  });
});

describe('trim at send', () => {
  it('produces the exact WAV emitted by the declared ffmpeg operation', async () => {
    root = await mkdtemp(join(tmpdir(), 'breeze-reference-trim-'));
    const logger = silentLogger();
    const store = new ReferenceStore({
      dir: join(root, 'references'),
      maxAgeMs: 60_000,
      logger,
      ffmpeg: FFMPEG,
    });
    await store.load();
    const record = await store.create(fixtures.wav, EMPTY_TRANSCRIPTION);
    const actual = await store.window(record.id, 0.2, 0.8);

    const expectedPath = join(root, 'expected.wav');
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      store.wavPath(record.id),
      '-ss',
      '0.2',
      '-to',
      '0.8',
      '-map',
      '0:a:0',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      expectedPath,
    ]);
    expect(actual.wav.equals(await readFile(expectedPath))).toBe(true);
  });

  it('refuses the measured no-CFG wall before trimming or invoking synthesis', async () => {
    const speechFetch = stubFetch([{}]);
    const { server, config } = await buildServer({ speechFetch });
    await mkdir(config.findingsDir, { recursive: true });
    await writeFile(
      join(config.findingsDir, 'reference-ceiling.json'),
      JSON.stringify({
        max_reference_seconds: 14.08,
        ceiling_by_branch_mode: { no_cfg: 14.08, single_cfg: 28.16 },
      }),
    );
    const longWav = frameWav(makePcm(20 * FORMAT.sampleRate), FORMAT);
    const reference = await stage(server, longWav);
    const findings = (
      await server.inject({ method: 'GET', url: '/api/findings' })
    ).json();
    expect(findings.referenceCeiling).toMatchObject({
      measured: true,
      maxReferenceSeconds: 14.08,
      ceilingByBranchMode: { noCfg: 14.08, singleCfg: 28.16 },
    });

    const refused = await server.inject({
      method: 'POST',
      url: '/api/speech',
      payload: {
        text: 'hello',
        mode: 'clone',
        cfg_scale: 1,
        reference_id: reference.id,
        ref_start: 0,
        ref_end: 15,
        ref_text: 'the exact words',
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.payload).toContain('14.080-second ceiling');
    expect(speechFetch.calls).toHaveLength(0);

    const served = await server.inject({
      method: 'POST',
      url: '/api/speech',
      payload: {
        text: 'hello',
        mode: 'clone',
        cfg_scale: 4,
        reference_id: reference.id,
        ref_start: 0,
        ref_end: 15,
        ref_text: 'the exact words',
      },
    });
    expect(served.statusCode).toBe(200);
    expect(speechFetch.calls).toHaveLength(1);
  });

  it('types unknown and invalid windows with the recording duration', async () => {
    const { server, references } = await buildServer();
    const reference = await stage(server, fixtures.wav);
    const outside = await server.inject({
      method: 'GET',
      url: `/api/reference/${reference.id}/audio?start=0.8&end=0.2`,
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.payload).toContain('recording is 1.000 seconds long');

    const missing = await server.inject({
      method: 'GET',
      url: '/api/reference/not-there/audio?start=0&end=1',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.type).toBe('not-found');

    await rm(references.wavPath(reference.id));
    const vanished = await server.inject({
      method: 'GET',
      url: `/api/reference/${reference.id}/audio?start=0&end=0.5`,
    });
    expect(vanished.statusCode).toBe(404);
    expect(vanished.json().error.type).toBe('not-found');
  });
});

describe('age retention is separate from voice lifetime', () => {
  const RECOGNITION: Transcription = {
    text: 'kept words',
    language: 'en',
    durationSeconds: 1,
    words: [{ word: 'kept words', start: 0, end: 1 }],
  };

  it('removes WAV and sidecar together while a copied voice still reads', async () => {
    root = await mkdtemp(join(tmpdir(), 'breeze-reference-age-'));
    let now = 10_000;
    const logger = silentLogger();
    const store = new ReferenceStore({
      dir: join(root, 'references'),
      maxAgeMs: 1_000,
      logger,
      ffmpeg: FFMPEG,
      now: () => now,
    });
    const voices = new VoiceStore({ dir: join(root, 'voices'), logger });
    await Promise.all([store.load(), voices.load()]);
    const reference = await store.create(fixtures.wav, RECOGNITION);
    const source = await store.read(reference.id);
    const voice = await voices.create({
      wav: source.wav,
      transcript: source.record.transcript,
      name: 'Kept voice',
      origin: { kind: 'cloned' },
    });

    now += 1_001;
    expect(await store.evictExpired()).toEqual([reference.id]);
    await expect(stat(store.wavPath(reference.id))).rejects.toThrow();
    await expect(stat(store.sidecarPath(reference.id))).rejects.toThrow();
    expect((await voices.read(voice.id)).record.name).toBe('Kept voice');
  });

  it('evicts expired entries on load and before a later write', async () => {
    root = await mkdtemp(join(tmpdir(), 'breeze-reference-load-age-'));
    let now = 20_000;
    const logger = silentLogger();
    const options = {
      dir: join(root, 'references'),
      maxAgeMs: 1_000,
      logger,
      ffmpeg: FFMPEG,
      now: () => now,
    };
    const first = new ReferenceStore(options);
    await first.load();
    const old = await first.create(fixtures.wav, RECOGNITION);

    now += 1_001;
    const reopened = new ReferenceStore(options);
    await reopened.load();
    expect(reopened.get(old.id)).toBeUndefined();

    const current = await reopened.create(fixtures.wav, RECOGNITION);
    now += 1_001;
    await reopened.create(fixtures.wav, RECOGNITION);
    expect(reopened.get(current.id)).toBeUndefined();
  });

  it('removes orphaned and malformed pairs while rebuilding the index', async () => {
    root = await mkdtemp(join(tmpdir(), 'breeze-reference-orphans-'));
    const dir = join(root, 'references');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'orphan.wav'), fixtures.wav);
    await writeFile(join(dir, 'broken.wav'), fixtures.wav);
    await writeFile(join(dir, 'broken.json'), '{not json');
    const store = new ReferenceStore({
      dir,
      maxAgeMs: 1_000,
      logger: silentLogger(),
      ffmpeg: FFMPEG,
    });

    await store.load();
    await expect(stat(join(dir, 'orphan.wav'))).rejects.toThrow();
    await expect(stat(join(dir, 'broken.wav'))).rejects.toThrow();
    await expect(stat(join(dir, 'broken.json'))).rejects.toThrow();
  });
});
