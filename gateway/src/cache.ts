/**
 * The clip cache: tee while streaming, replay buffered.
 *
 * Two invariants make this worth having.
 *
 * **The tee never delays the client.** Writes go to an unawaited stream, so
 * the cache cannot cost the latency the stream exists to demonstrate. A disk
 * failure is logged and the audio keeps flowing — losing a cache entry must
 * never cost the operator their clip.
 *
 * **One on-disk format, always.** Raw PCM s16le exactly as Modal emits it,
 * beside a sidecar carrying the rate, the format and the request provenance.
 * WAV framing happens at read. Storing whatever the active transport happened
 * to produce would make a clip's readability depend on a setting that was in
 * force when it was generated.
 *
 * @module
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

import type { Transport } from './config.js';
import {
  newestFirst,
  selectForEviction,
  validateRecord,
  type ClipRecord,
  type ClipRequest,
} from './cache-index.js';
import { durationSeconds, frameWav, type AudioFormat } from './transport.js';

const PCM_SUFFIX = '.pcm';
const SIDECAR_SUFFIX = '.json';

/** Everything needed to finalise a clip once its bytes have arrived. */
export interface FinalizeInput {
  readonly format: AudioFormat;
  readonly ttfaMs: number | null;
  readonly transport: Transport;
  readonly request: ClipRequest;
  /** Override the generated id, used by the script runner's cue keys. */
  readonly id?: string;
}

/** An in-flight clip write. */
export interface ClipWriter {
  /** The id this clip will be stored under. */
  readonly id: string;
  /**
   * Tee one chunk to disk. Never throws and never awaits — a cache write must
   * not sit between the model and the operator's ears.
   *
   * @param chunk - PCM bytes also being sent to the client.
   */
  write(chunk: Uint8Array): void;
  /**
   * Close the file and write the sidecar.
   *
   * @param input - Format, timing and provenance.
   * @returns The stored record, or null if caching failed and was abandoned.
   */
  finalize(input: FinalizeInput): Promise<ClipRecord | null>;
  /** Abandon the clip and remove any partial file. */
  abort(): Promise<void>;
}

/**
 * Disk-backed store of generated clips.
 */
export class ClipCache {
  readonly #dir: string;
  readonly #maxBytes: number;
  readonly #log: Logger;
  #records = new Map<string, ClipRecord>();
  #enabled = true;
  #loaded = false;
  #inflight = new Map<string, Promise<void>>();
  #resolvers = new Map<string, () => void>();

  /**
   * @param options - Directory, ceiling and logger.
   */
  constructor(options: { dir: string; maxBytes: number; logger: Logger }) {
    this.#dir = options.dir;
    this.#maxBytes = options.maxBytes;
    this.#log = options.logger.child({ component: 'clip-cache' });
  }

  /**
   * Resolve once every in-flight tee has finished writing.
   *
   * The tee is deliberately not awaited on the request path — that is the
   * whole point of it — so shutdown and tests need somewhere to wait.
   *
   * @returns A promise that settles when no write is outstanding.
   */
  async whenIdle(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.all([...this.#inflight.values()]);
    }
  }

  #settle(id: string): void {
    this.#resolvers.get(id)?.();
    this.#resolvers.delete(id);
    this.#inflight.delete(id);
  }

  /** Whether caching is currently operating. */
  get enabled(): boolean {
    return this.#enabled;
  }

  /** The directory clips are written to. */
  get dir(): string {
    return this.#dir;
  }

  /**
   * Build the in-memory index from the sidecars on disk.
   *
   * The index is derived rather than persisted, so a corrupt or stale index
   * file can never make a servable clip unservable.
   */
  async load(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const entries = await readdir(this.#dir).catch(() => [] as string[]);
    const records = new Map<string, ClipRecord>();

    for (const entry of entries) {
      if (!entry.endsWith(SIDECAR_SUFFIX)) continue;
      const id = entry.slice(0, -SIDECAR_SUFFIX.length);
      const record = await this.#readRecord(id);
      if (record) records.set(id, record);
    }

    this.#records = records;
    this.#loaded = true;
    this.#log.info({ clips: records.size }, 'clip cache loaded');
    await this.evict();
  }

  async #readRecord(id: string): Promise<ClipRecord | null> {
    const sidecarPath = this.sidecarPath(id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(sidecarPath, 'utf8'));
    } catch {
      this.#log.warn({ id }, 'sidecar unreadable; dropping clip from the index');
      return null;
    }
    const record = validateRecord(parsed);
    if (!record) {
      this.#log.warn({ id }, 'sidecar invalid; dropping clip from the index');
      return null;
    }
    const size = await stat(this.pcmPath(id))
      .then((info) => info.size)
      .catch(() => -1);
    if (size !== record.bytes) {
      // A truncated clip served at its declared length would be worse than an
      // absent one: it plays, and it is wrong.
      this.#log.warn(
        { id, declared: record.bytes, actual: size },
        'clip payload missing or truncated; dropping from the index',
      );
      return null;
    }
    return record;
  }

  /** Absolute path of a clip's raw PCM payload. */
  pcmPath(id: string): string {
    return join(this.#dir, `${id}${PCM_SUFFIX}`);
  }

  /** Absolute path of a clip's sidecar. */
  sidecarPath(id: string): string {
    return join(this.#dir, `${id}${SIDECAR_SUFFIX}`);
  }

  /**
   * List every servable clip.
   *
   * @returns Records, newest first.
   */
  list(): ClipRecord[] {
    return newestFirst([...this.#records.values()]);
  }

  /**
   * Look one clip up.
   *
   * @param id - The clip id.
   * @returns The record, or undefined when it is not cached.
   */
  get(id: string): ClipRecord | undefined {
    return this.#records.get(id);
  }

  /** Total bytes currently held. */
  totalBytes(): number {
    let total = 0;
    for (const record of this.#records.values()) total += record.bytes;
    return total;
  }

  /**
   * Open a writer that tees a stream to disk.
   *
   * @param id - Optional fixed id, used by the script runner's cue keys.
   * @returns A writer, always — when caching is disabled it accepts and drops
   *   chunks, so callers never branch on cache health.
   */
  beginWrite(id: string = randomUUID()): ClipWriter {
    if (!this.#enabled) return this.#nullWriter(id);

    let stream: WriteStream | null = null;
    let failed = false;
    // Counted here rather than read from `stream.bytesWritten`: that property
    // excludes data still queued, and the tee queues by design.
    let written = 0;
    this.#inflight.set(
      id,
      new Promise<void>((resolve) => this.#resolvers.set(id, resolve)),
    );
    try {
      stream = createWriteStream(this.pcmPath(id));
      stream.on('error', (error) => {
        failed = true;
        this.#log.warn({ id, err: error }, 'clip write failed; audio is unaffected');
      });
    } catch (error) {
      this.#log.warn({ id, err: error }, 'could not open clip file; skipping this clip');
      this.#settle(id);
      return this.#nullWriter(id);
    }

    const cache = this;
    return {
      id,
      write(chunk: Uint8Array): void {
        if (failed || !stream) return;
        written += chunk.byteLength;
        // Unawaited on purpose: Node buffers, and the client's bytes must not
        // wait behind a disk.
        stream.write(Buffer.from(chunk));
      },
      async finalize(input: FinalizeInput): Promise<ClipRecord | null> {
        if (!stream) {
          cache.#settle(id);
          return null;
        }
        await new Promise<void>((resolve) => stream!.end(resolve));
        const bytes = written;
        if (failed || bytes === 0) {
          await cache.#removeFiles(id);
          cache.#settle(id);
          return null;
        }
        const record: ClipRecord = {
          id,
          createdAt: Date.now(),
          bytes,
          sampleRate: input.format.sampleRate,
          format: input.format.format,
          channels: input.format.channels,
          durationSeconds: durationSeconds(bytes, input.format),
          ttfaMs: input.ttfaMs,
          transport: input.transport,
          request: input.request,
        };
        try {
          await writeFile(
            cache.sidecarPath(id),
            `${JSON.stringify(record, null, 2)}\n`,
            'utf8',
          );
        } catch (error) {
          cache.#log.warn({ id, err: error }, 'sidecar write failed; clip not cached');
          await cache.#removeFiles(id);
          cache.#settle(id);
          return null;
        }
        cache.#records.set(id, record);
        await cache.evict();
        cache.#settle(id);
        return record;
      },
      async abort(): Promise<void> {
        if (stream) await new Promise<void>((resolve) => stream!.end(resolve));
        await cache.#removeFiles(id);
        cache.#settle(id);
      },
    };
  }

  #nullWriter(id: string): ClipWriter {
    return {
      id,
      write(): void {},
      async finalize(): Promise<ClipRecord | null> {
        return null;
      },
      async abort(): Promise<void> {},
    };
  }

  /**
   * Store a complete payload directly, bypassing the streaming tee.
   *
   * @param pcm - The full PCM payload.
   * @param input - Format, timing and provenance.
   * @returns The stored record, or null if caching failed.
   */
  async put(pcm: Buffer, input: FinalizeInput): Promise<ClipRecord | null> {
    const writer = this.beginWrite(input.id);
    writer.write(pcm);
    return writer.finalize(input);
  }

  /**
   * Read a clip's raw PCM.
   *
   * @param id - The clip id.
   * @returns The payload, or null when the clip is absent. An absent file also
   *   drops the clip from the index, rather than being served as a truncated
   *   one on the next request.
   */
  async readPcm(id: string): Promise<Buffer | null> {
    const record = this.#records.get(id);
    if (!record) return null;
    try {
      const pcm = await readFile(this.pcmPath(id));
      if (pcm.length !== record.bytes) throw new Error('length mismatch');
      return pcm;
    } catch (error) {
      this.#log.warn({ id, err: error }, 'cached clip unreadable; removing from the index');
      this.#records.delete(id);
      return null;
    }
  }

  /**
   * Read a clip framed as WAV, using its own sidecar's rate and format.
   *
   * Replay is a buffered read in either transport, so generation streams while
   * replay is instant — and it reaches no GPU, so it works while the container
   * is scaled to zero.
   *
   * @param id - The clip id.
   * @returns A complete WAV file, or null when the clip is absent.
   */
  async readWav(id: string): Promise<Buffer | null> {
    const record = this.#records.get(id);
    const pcm = await this.readPcm(id);
    if (!record || !pcm) return null;
    return frameWav(pcm, {
      sampleRate: record.sampleRate,
      format: record.format,
      channels: record.channels,
      bytesPerSample: 2,
    });
  }

  /**
   * Delete a clip.
   *
   * @param id - The clip id.
   * @returns Whether it was present.
   */
  async remove(id: string): Promise<boolean> {
    const existed = this.#records.delete(id);
    await this.#removeFiles(id);
    return existed;
  }

  async #removeFiles(id: string): Promise<void> {
    await Promise.all([
      rm(this.pcmPath(id), { force: true }).catch(() => {}),
      rm(this.sidecarPath(id), { force: true }).catch(() => {}),
    ]);
  }

  /**
   * Bring the cache under its configured ceiling, oldest first.
   *
   * @returns The ids removed.
   */
  async evict(): Promise<string[]> {
    const doomed = selectForEviction([...this.#records.values()], this.#maxBytes);
    for (const id of doomed) {
      this.#records.delete(id);
      await this.#removeFiles(id);
    }
    if (doomed.length > 0) {
      this.#log.info({ evicted: doomed.length }, 'evicted oldest clips at the cache limit');
    }
    return doomed;
  }

  /**
   * Stop caching rather than fail synthesis.
   *
   * Reached when space cannot be reclaimed. Synthesis continuing without a
   * cache is a degraded demo; synthesis failing because a disk is full is a
   * broken one.
   *
   * @param reason - Why, for the log.
   */
  disable(reason: string): void {
    if (!this.#enabled) return;
    this.#enabled = false;
    this.#log.warn({ reason }, 'caching disabled; synthesis and replay of existing clips continue');
  }

  /** Whether `load` has run. */
  get ready(): boolean {
    return this.#loaded;
  }
}
