/**
 * Age-bounded storage for staged reference recordings.
 *
 * A staged reference is working material: one normalised WAV and one sidecar,
 * uploaded and transcribed once, then addressed by id. It is intentionally not
 * a clip or a voice. Clips are generated exhaust and voices are durable; a
 * staged source instead expires by age and is copied by any durable consumer.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';

import type { Transcription } from './asr.js';
import { GatewayError } from './proxy.js';
import {
  FFMPEG_INSTALL_REMEDY,
  ReferenceError,
  type FfmpegStatus,
} from './reference.js';
import {
  parseWavPcm,
  peaksFrom,
  sliceTranscript,
  type PcmSampleFormat,
  type TimedWord,
} from './reference-slice.js';

const run = promisify(execFile);
const WAV_SUFFIX = '.wav';
const SIDECAR_SUFFIX = '.json';

/** Number of waveform columns computed once during intake. */
export const DEFAULT_PEAK_BUCKETS = 512;

/** Metadata returned to the browser and persisted beside a staged WAV. */
export interface ReferenceRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly bytes: number;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly format: PcmSampleFormat;
  readonly channels: number;
  readonly peaks: readonly number[];
  readonly words: readonly TimedWord[];
  readonly transcript: string;
  readonly language: string | null;
}

/** A full stored pair, used when another store takes its own copy. */
export interface ReferenceWithAudio {
  readonly record: ReferenceRecord;
  readonly wav: Buffer;
}

/** The exact trimmed pair sent to synthesis or previewed by the browser. */
export interface ReferenceWindow {
  readonly referenceId: string;
  readonly start: number;
  readonly end: number;
  readonly durationSeconds: number;
  readonly transcript: string;
  readonly words: readonly TimedWord[];
  readonly wav: Buffer;
}

/** Inputs that can constrain a synthesis window before ffmpeg runs. */
export interface WindowOptions {
  readonly maxDurationSeconds?: number;
  readonly cfgScale?: number;
}

/**
 * Validate a staged-reference sidecar without touching the filesystem.
 *
 * @param value - Parsed JSON.
 * @returns A usable record, or null.
 */
export function validateReferenceRecord(value: unknown): ReferenceRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const finitePositive = (entry: unknown): entry is number =>
    typeof entry === 'number' && Number.isFinite(entry) && entry > 0;
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.length === 0 ||
    !finitePositive(candidate.createdAt) ||
    !finitePositive(candidate.bytes) ||
    !finitePositive(candidate.durationSeconds) ||
    !finitePositive(candidate.sampleRate) ||
    !Number.isInteger(candidate.sampleRate) ||
    !finitePositive(candidate.channels) ||
    !Number.isInteger(candidate.channels) ||
    !['s16le', 's24le', 's32le', 'f32le'].includes(String(candidate.format)) ||
    !Array.isArray(candidate.peaks) ||
    !candidate.peaks.every(
      (peak) =>
        typeof peak === 'number' && Number.isFinite(peak) && peak >= 0 && peak <= 1,
    ) ||
    !Array.isArray(candidate.words) ||
    typeof candidate.transcript !== 'string' ||
    !(typeof candidate.language === 'string' || candidate.language === null)
  ) {
    return null;
  }

  const words: TimedWord[] = [];
  for (const raw of candidate.words) {
    if (typeof raw !== 'object' || raw === null) return null;
    const word = raw as Record<string, unknown>;
    if (
      typeof word.word !== 'string' ||
      typeof word.start !== 'number' ||
      !Number.isFinite(word.start) ||
      typeof word.end !== 'number' ||
      !Number.isFinite(word.end) ||
      word.start < 0 ||
      word.end < word.start
    ) {
      return null;
    }
    words.push({ word: word.word, start: word.start, end: word.end });
  }

  return {
    id: candidate.id,
    createdAt: candidate.createdAt,
    bytes: candidate.bytes,
    durationSeconds: candidate.durationSeconds,
    sampleRate: candidate.sampleRate,
    format: candidate.format as PcmSampleFormat,
    channels: candidate.channels,
    peaks: candidate.peaks as number[],
    words,
    transcript: candidate.transcript,
    language: candidate.language as string | null,
  };
}

/** Disk-backed store for transient source recordings. */
export class ReferenceStore {
  readonly #dir: string;
  readonly #maxAgeMs: number;
  readonly #peakBuckets: number;
  readonly #ffmpeg: FfmpegStatus;
  readonly #ffmpegPath: string;
  readonly #tmpRoot: string;
  readonly #log: Logger;
  readonly #now: () => number;
  #records = new Map<string, ReferenceRecord>();

  /**
   * @param options - Storage, retention, audio tooling, and injectable clock.
   */
  constructor(options: {
    dir: string;
    maxAgeMs: number;
    logger: Logger;
    ffmpeg: FfmpegStatus;
    peakBuckets?: number;
    ffmpegPath?: string;
    tmpRoot?: string;
    now?: () => number;
  }) {
    if (!Number.isInteger(options.maxAgeMs) || options.maxAgeMs <= 0) {
      throw new RangeError(
        `reference maxAgeMs must be a positive integer, got ${options.maxAgeMs}`,
      );
    }
    const peakBuckets = options.peakBuckets ?? DEFAULT_PEAK_BUCKETS;
    if (!Number.isInteger(peakBuckets) || peakBuckets <= 0) {
      throw new RangeError(
        `reference peakBuckets must be a positive integer, got ${peakBuckets}`,
      );
    }
    this.#dir = options.dir;
    this.#maxAgeMs = options.maxAgeMs;
    this.#peakBuckets = peakBuckets;
    this.#ffmpeg = options.ffmpeg;
    this.#ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
    this.#tmpRoot = options.tmpRoot ?? tmpdir();
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.logger.child({ component: 'reference-store' });
  }

  /** Store directory, exposed for diagnostics and tests. */
  get dir(): string {
    return this.#dir;
  }

  /** Configured retention window in milliseconds. */
  get maxAgeMs(): number {
    return this.#maxAgeMs;
  }

  /** Number of currently addressable staged references. */
  get size(): number {
    return this.#records.size;
  }

  /** Absolute path of a staged WAV. */
  wavPath(id: string): string {
    return join(this.#dir, `${id}${WAV_SUFFIX}`);
  }

  /** Absolute path of a staged sidecar. */
  sidecarPath(id: string): string {
    return join(this.#dir, `${id}${SIDECAR_SUFFIX}`);
  }

  /**
   * Rebuild the in-memory index and evict expired working material.
   */
  async load(): Promise<void> {
    this.#log.info('reference store load started');
    await mkdir(this.#dir, { recursive: true });
    const entries = await readdir(this.#dir).catch(() => [] as string[]);
    const records = new Map<string, ReferenceRecord>();
    const sidecarIds = new Set(
      entries
        .filter((entry) => entry.endsWith(SIDECAR_SUFFIX))
        .map((entry) => entry.slice(0, -SIDECAR_SUFFIX.length)),
    );
    for (const entry of entries) {
      if (!entry.endsWith(SIDECAR_SUFFIX)) continue;
      const id = entry.slice(0, -SIDECAR_SUFFIX.length);
      try {
        const parsed = JSON.parse(await readFile(this.sidecarPath(id), 'utf8'));
        const record = validateReferenceRecord(parsed);
        if (!record || record.id !== id) {
          this.#log.warn({ id }, 'reference sidecar invalid; skipping');
          await this.#removeFiles(id);
          continue;
        }
        const bytes = await stat(this.wavPath(id)).then((info) => info.size);
        if (bytes !== record.bytes) {
          this.#log.warn(
            { id, declared: record.bytes, actual: bytes },
            'reference WAV missing or truncated; skipping',
          );
          await this.#removeFiles(id);
          continue;
        }
        records.set(id, record);
      } catch (error) {
        this.#log.warn({ id, err: error }, 'reference sidecar or WAV unreadable; skipping');
        await this.#removeFiles(id);
      }
    }
    for (const entry of entries) {
      if (!entry.endsWith(WAV_SUFFIX)) continue;
      const id = entry.slice(0, -WAV_SUFFIX.length);
      if (!sidecarIds.has(id)) {
        this.#log.warn({ id }, 'orphaned reference WAV removed');
        await this.#removeFiles(id);
      }
    }
    this.#records = records;
    await this.evictExpired();
    this.#log.info({ references: this.#records.size }, 'reference store loaded');
  }

  /**
   * Persist one already-normalised WAV and its one-time recognition.
   *
   * @param wav - The normalised WAV.
   * @param transcription - ASR output or the graceful empty shape.
   * @returns The stored record returned by intake.
   */
  async create(
    wav: Buffer,
    transcription: Transcription,
  ): Promise<ReferenceRecord> {
    this.#log.info({ bytes: wav.length }, 'reference store write started');
    await this.evictExpired();
    const parsed = parseWavPcm(wav);
    const id = randomUUID();
    const record: ReferenceRecord = {
      id,
      createdAt: this.#now(),
      bytes: wav.length,
      durationSeconds: parsed.durationSeconds,
      sampleRate: parsed.format.sampleRate,
      format: parsed.format.format,
      channels: parsed.format.channels,
      peaks: peaksFrom(parsed.pcm, parsed.format, this.#peakBuckets),
      words: transcription.words,
      transcript: transcription.text,
      language: transcription.language,
    };

    await mkdir(this.#dir, { recursive: true });
    try {
      await writeFile(this.wavPath(id), wav);
      await writeFile(
        this.sidecarPath(id),
        `${JSON.stringify(record, null, 2)}\n`,
        'utf8',
      );
    } catch (error) {
      await this.#removeFiles(id);
      this.#log.error({ id, err: error }, 'reference store write failed');
      throw error;
    }
    this.#records.set(id, record);
    await this.evictExpired();
    this.#log.info(
      { id, durationSeconds: record.durationSeconds, words: record.words.length },
      'reference stored',
    );
    return record;
  }

  /** Look up metadata without reading the WAV. */
  get(id: string): ReferenceRecord | undefined {
    return this.#records.get(id);
  }

  /**
   * Read a staged WAV and its sidecar together.
   *
   * @param id - Staged reference id.
   * @returns The complete stored pair.
   */
  async read(id: string): Promise<ReferenceWithAudio> {
    const record = this.#records.get(id);
    if (!record) {
      throw new GatewayError('not-found', `no staged reference with id ${id}`);
    }
    try {
      const wav = await readFile(this.wavPath(id));
      if (wav.length !== record.bytes) throw new Error('length mismatch');
      return { record, wav };
    } catch (error) {
      this.#records.delete(id);
      this.#log.warn({ id, err: error }, 'staged reference WAV unreadable');
      throw new GatewayError(
        'not-found',
        'that staged reference is no longer available',
        { remedy: 'Upload or record the reference again.' },
      );
    }
  }

  /**
   * Resolve, validate, and trim one word-safe window.
   *
   * The duration ceiling is checked before ffmpeg runs. Transcript and audio
   * boundaries are then carried by the same object so they cannot drift on the
   * way to synthesis.
   *
   * @param id - Staged reference id.
   * @param start - Requested start in seconds.
   * @param end - Requested end in seconds.
   * @param options - Optional measured duration ceiling.
   * @returns The exact WAV/transcript pair for the snapped window.
   */
  async window(
    id: string,
    start: number,
    end: number,
    options: WindowOptions = {},
  ): Promise<ReferenceWindow> {
    const record = this.#records.get(id);
    if (!record) {
      throw new GatewayError('not-found', `no staged reference with id ${id}`);
    }
    this.#validateWindow(start, end, record.durationSeconds);
    const sliced = sliceTranscript(record.words, start, end);
    this.#validateWindow(sliced.start, sliced.end, record.durationSeconds);
    const duration = sliced.end - sliced.start;
    if (
      options.maxDurationSeconds !== undefined &&
      duration > options.maxDurationSeconds + 1e-6
    ) {
      const cfg = options.cfgScale === undefined ? '' : ` at CFG ${options.cfgScale}`;
      throw new GatewayError(
        'validation',
        `the reference window is ${duration.toFixed(3)} seconds, past the measured ` +
          `${options.maxDurationSeconds.toFixed(3)}-second ceiling${cfg}`,
        {
          remedy:
            `Shorten the reference window to ${options.maxDurationSeconds.toFixed(3)} ` +
            'seconds or less before generating.',
        },
      );
    }

    const wav = await this.#trim(id, sliced.start, sliced.end);
    return {
      referenceId: id,
      start: sliced.start,
      end: sliced.end,
      durationSeconds: duration,
      transcript: sliced.transcript,
      words: sliced.words,
      wav,
    };
  }

  #validateWindow(start: number, end: number, duration: number): void {
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > duration + 1e-6
    ) {
      throw new GatewayError(
        'validation',
        `reference window ${String(start)}-${String(end)} is outside or inverted; ` +
          `the recording is ${duration.toFixed(3)} seconds long`,
        {
          remedy:
            `Choose a start at or above 0 and an end no later than ${duration.toFixed(3)} seconds.`,
        },
      );
    }
  }

  async #trim(id: string, start: number, end: number): Promise<Buffer> {
    if (!this.#ffmpeg.available) {
      throw new ReferenceError(
        'ffmpeg-missing',
        'ffmpeg is required to cut a staged reference window',
        FFMPEG_INSTALL_REMEDY,
      );
    }
    const record = this.#records.get(id);
    const storedBytes = await stat(this.wavPath(id))
      .then((info) => info.size)
      .catch(() => -1);
    if (!record || storedBytes !== record.bytes) {
      this.#records.delete(id);
      await this.#removeFiles(id);
      throw new GatewayError(
        'not-found',
        'that staged reference is no longer available',
        { remedy: 'Upload or record the reference again.' },
      );
    }
    const workdir = await mkdtemp(join(this.#tmpRoot, 'breeze-ref-window-'));
    const output = join(workdir, 'window.wav');
    try {
      await run(
        this.#ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          this.wavPath(id),
          '-ss',
          String(start),
          '-to',
          String(end),
          '-map',
          '0:a:0',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          output,
        ],
        { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      );
      return await readFile(output);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#log.error({ id, start, end, err: detail }, 'reference trim failed');
      if (detail.includes('ENOENT')) {
        throw new ReferenceError(
          'ffmpeg-missing',
          'ffmpeg is not installed, so a staged reference cannot be cut',
          FFMPEG_INSTALL_REMEDY,
        );
      }
      throw new ReferenceError(
        'transcode-failed',
        `the reference window could not be cut: ${detail}`,
        'Try a different interval or upload the recording again.',
      );
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Delete one staged reference immediately.
   *
   * @param id - Reference id.
   * @returns Whether the reference was indexed.
   */
  async remove(id: string): Promise<boolean> {
    const existed = this.#records.delete(id);
    await this.#removeFiles(id);
    if (existed) this.#log.info({ id }, 'staged reference removed');
    return existed;
  }

  /**
   * Remove every record at or beyond the configured age.
   *
   * @returns Removed ids.
   */
  async evictExpired(): Promise<string[]> {
    const now = this.#now();
    const expired = [...this.#records.values()]
      .filter((record) => now - record.createdAt >= this.#maxAgeMs)
      .map((record) => record.id);
    for (const id of expired) {
      this.#records.delete(id);
      await this.#removeFiles(id);
    }
    if (expired.length > 0) {
      this.#log.info({ evicted: expired.length }, 'expired staged references evicted');
    }
    return expired;
  }

  async #removeFiles(id: string): Promise<void> {
    await Promise.all([
      rm(this.wavPath(id), { force: true }).catch(() => {}),
      rm(this.sidecarPath(id), { force: true }).catch(() => {}),
    ]);
  }
}
