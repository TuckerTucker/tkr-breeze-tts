/**
 * The clip index: record shape, validation, and eviction ordering.
 *
 * Deliberately free of filesystem access so the rules that decide what is
 * servable and what gets evicted are testable without a disk. `cache.ts` owns
 * the IO.
 *
 * @module
 */

import type { Transport } from './config.js';
import { MAX_SAMPLE_RATE, MIN_SAMPLE_RATE, SUPPORTED_FORMAT } from './transport.js';

/** The three ways a voice can be specified, as the UI presents them. */
export type VoiceMode = 'design' | 'clone' | 'direction';

/** Neutral delivery used by legacy scripts and omitted from their old cache key. */
export const DEFAULT_DELIVERY_INSTRUCTION = 'Speak clearly and naturally.';

/** The request that produced a clip, kept beside it. */
export interface ClipRequest {
  /** The line that was spoken. */
  readonly text: string;
  /** The voice description or delivery direction. */
  readonly instruction: string;
  /** Which control mode produced it. */
  readonly mode: VoiceMode;
  /** Instruction-following strength. */
  readonly cfgScale: number;
  /** The seed, so a generation can be reproduced exactly. */
  readonly seed: number;
  /** Exact transcript of the reference audio, when there was one. */
  readonly refText?: string;
  /** Library voice used, when one was. */
  readonly voiceId?: string;
  /** That voice's name at generation time, for legible history. */
  readonly voiceName?: string;
}

/** One cached clip. Mirrors its on-disk sidecar exactly. */
export interface ClipRecord {
  readonly id: string;
  /** Epoch milliseconds. Eviction is oldest-first on this. */
  readonly createdAt: number;
  /** Length of the raw PCM payload on disk. */
  readonly bytes: number;
  readonly sampleRate: number;
  readonly format: typeof SUPPORTED_FORMAT;
  readonly channels: number;
  /** Derived exactly from `bytes`, never estimated. */
  readonly durationSeconds: number;
  /** Measured first-byte time, or null when it was not observed. */
  readonly ttfaMs: number | null;
  /** Which transport produced it. The bytes on disk do not depend on this. */
  readonly transport: Transport;
  readonly request: ClipRequest;
}

/**
 * Decide whether a parsed sidecar is servable.
 *
 * A sidecar missing its sample rate is dropped rather than served at a guessed
 * rate: a wrong rate plays at the wrong speed instead of failing, which is the
 * failure mode a listener misreads as the model being broken.
 *
 * @param value - A parsed sidecar, of unknown shape.
 * @returns The record when it is usable, otherwise null.
 */
export function validateRecord(value: unknown): ClipRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;

  const id = candidate.id;
  const bytes = candidate.bytes;
  const sampleRate = candidate.sampleRate;
  const createdAt = candidate.createdAt;

  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (
    typeof sampleRate !== 'number' ||
    !Number.isInteger(sampleRate) ||
    sampleRate < MIN_SAMPLE_RATE ||
    sampleRate > MAX_SAMPLE_RATE
  ) {
    return null;
  }
  if (candidate.format !== SUPPORTED_FORMAT) return null;

  const request = candidate.request;
  if (typeof request !== 'object' || request === null) return null;

  const channels = typeof candidate.channels === 'number' ? candidate.channels : 1;
  return {
    id,
    createdAt,
    bytes,
    sampleRate,
    format: SUPPORTED_FORMAT,
    channels,
    durationSeconds:
      typeof candidate.durationSeconds === 'number'
        ? candidate.durationSeconds
        : bytes / 2 / channels / sampleRate,
    ttfaMs: typeof candidate.ttfaMs === 'number' ? candidate.ttfaMs : null,
    transport: candidate.transport === 'buffered' ? 'buffered' : 'streaming',
    request: request as ClipRequest,
  };
}

/**
 * Order records newest-first, which is the order history is read in.
 *
 * @param records - Records to sort. Not mutated.
 * @returns A new, sorted array.
 */
export function newestFirst(records: readonly ClipRecord[]): ClipRecord[] {
  return [...records].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Choose which clips to evict to bring the cache under its limit.
 *
 * @param records - Every record currently held.
 * @param maxBytes - The configured ceiling.
 * @returns The ids to remove, oldest first.
 */
export function selectForEviction(
  records: readonly ClipRecord[],
  maxBytes: number,
): string[] {
  let total = records.reduce((sum, record) => sum + record.bytes, 0);
  if (total <= maxBytes) return [];

  const oldestFirst = [...records].sort((a, b) => a.createdAt - b.createdAt);
  const doomed: string[] = [];
  for (const record of oldestFirst) {
    if (total <= maxBytes) break;
    doomed.push(record.id);
    total -= record.bytes;
  }
  return doomed;
}

/**
 * A stable cache key for a script cue.
 *
 * Keyed on text, voice, cfg and seed, so re-running a script regenerates only
 * what changed — the difference between a script feature that is usable and
 * one that costs a full re-run for every corrected line.
 *
 * @param parts - The four things a cue's audio depends on.
 * @returns A hex key.
 */
export function cueCacheKey(parts: {
  text: string;
  voiceId: string | null;
  cfgScale: number;
  seed: number;
  instruction?: string;
}): string {
  const values: Array<string | number> = [
    parts.text,
    parts.voiceId ?? '',
    parts.cfgScale,
    parts.seed,
  ];
  // Preserve legacy cache identities for the neutral instruction. Any visible
  // non-neutral delivery becomes part of the key so it cannot reuse stale audio.
  if (
    parts.instruction !== undefined &&
    parts.instruction !== DEFAULT_DELIVERY_INSTRUCTION
  ) {
    values.push(parts.instruction);
  }
  const canonical = JSON.stringify(values);
  // FNV-1a: short, stable, and this is a cache key rather than a security
  // boundary, so a non-cryptographic hash is the right tool.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
