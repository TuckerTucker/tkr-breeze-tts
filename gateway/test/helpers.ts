/**
 * Shared test scaffolding: a silent logger, a stub configuration, a scripted
 * upstream, and real audio fixtures produced by ffmpeg.
 *
 * The fixtures are generated rather than committed. A checked-in binary is a
 * thing nobody can read in a diff, and ffmpeg is already a hard dependency of
 * the capability under test.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino, { type Logger } from 'pino';

import type { GatewayConfig } from '../src/config.js';

const run = promisify(execFile);

/** A logger that writes nowhere, so test output stays readable. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/**
 * Build a configuration pointing at temporary directories.
 *
 * @param overrides - Fields to change.
 * @returns A complete configuration.
 */
export function stubConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    endpoint: 'https://example--breeze-tts-serve.modal.run',
    key: 'wk-testkey0123456789',
    secret: 'ws-testsecret0123456789',
    transport: 'streaming',
    clipCacheDir: join(tmpdir(), 'breeze-test-clips'),
    clipCacheMaxBytes: 10 * 1024 * 1024,
    voiceStoreDir: join(tmpdir(), 'breeze-test-voices'),
    scriptStoreDir: join(tmpdir(), 'breeze-test-scripts'),
    scaledownWindowMs: 300_000,
    findingsDir: join(tmpdir(), 'breeze-test-findings'),
    uiDir: join(tmpdir(), 'breeze-test-ui'),
    upstreamTimeoutMs: 5_000,
    ...overrides,
  };
}

/** One scripted upstream response. */
export interface StubUpstream {
  status?: number;
  headers?: Record<string, string>;
  /** PCM chunks, delivered in order. */
  chunks?: Uint8Array[];
  /** Milliseconds between chunks, to exercise streaming timing. */
  delayMs?: number;
  body?: string;
}

/**
 * Build a `fetch` stand-in that serves scripted responses and records calls.
 *
 * @param responses - Responses to serve, in order. The last repeats.
 * @returns The fetch double, with a `calls` array attached.
 */
export function stubFetch(
  responses: StubUpstream[],
): typeof fetch & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...responses];

  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const spec = queue.length > 1 ? queue.shift()! : (queue[0] ?? {});
    const status = spec.status ?? 200;

    if (status !== 200) {
      return new Response(spec.body ?? '', { status });
    }

    const chunks = spec.chunks ?? [new Uint8Array(4800)];
    const delayMs = spec.delayMs ?? 0;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'X-Sample-Rate': '24000',
        'X-Sample-Format': 's16le',
        ...(spec.headers ?? {}),
      },
    });
  }) as typeof fetch & { calls: typeof calls };

  impl.calls = calls;
  return impl;
}

/** A generated set of real audio files in several containers. */
export interface AudioFixtures {
  readonly dir: string;
  readonly wav: Buffer;
  readonly webm: Buffer;
  readonly mp3: Buffer;
  readonly m4a: Buffer;
  readonly flac: Buffer;
  readonly ogg: Buffer;
  cleanup(): Promise<void>;
}

/**
 * Produce a one-second tone in every container the gateway claims to accept.
 *
 * @returns The fixtures, with a cleanup hook.
 */
export async function makeAudioFixtures(): Promise<AudioFixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'breeze-fixtures-'));
  const source = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'];

  const encode = async (name: string, args: string[]): Promise<Buffer> => {
    const path = join(dir, name);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...source, ...args, path]);
    return readFileSync(path);
  };

  const [wav, webm, mp3, m4a, flac, ogg] = await Promise.all([
    encode('tone.wav', ['-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le']),
    encode('tone.webm', ['-ac', '1', '-c:a', 'libopus']),
    encode('tone.mp3', ['-ac', '1', '-c:a', 'libmp3lame']),
    encode('tone.m4a', ['-ac', '1', '-c:a', 'aac']),
    encode('tone.flac', ['-ac', '1', '-c:a', 'flac']),
    encode('tone.ogg', ['-ac', '1', '-c:a', 'libvorbis']),
  ]);

  return {
    dir,
    wav: wav!,
    webm: webm!,
    mp3: mp3!,
    m4a: m4a!,
    flac: flac!,
    ogg: ogg!,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Generate deterministic PCM, so a byte-for-byte comparison means something.
 *
 * @param samples - How many 16-bit samples.
 * @param seed - Varies the waveform between fixtures.
 * @returns Little-endian s16 PCM.
 */
export function makePcm(samples: number, seed = 1): Buffer {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(8000 * Math.sin((i * seed) / 20)), i * 2);
  }
  return buffer;
}
