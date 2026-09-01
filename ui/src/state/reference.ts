/**
 * Pure state transitions for a staged reference recording.
 *
 * Audio is uploaded once and addressed by id after intake. This module keeps
 * selection movement, transcript tracking, and preflight limits deterministic
 * without depending on the DOM or the gateway client.
 *
 * @module
 */

import { estimateTokens } from './draft.js';

/** The safe selection wall used until a measured reference finding is available. */
export const CONSERVATIVE_REFERENCE_MAX_SECONDS = 10;

/** One transcribed word and the interval occupied by its audio. */
export interface TimedWord {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/** Metadata returned by `POST /api/reference`. */
export interface StagedReferenceResource {
  readonly id: string;
  readonly createdAt: number;
  readonly bytes: number;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly format: 's16le' | 's24le' | 's32le' | 'f32le';
  readonly channels: number;
  readonly peaks: readonly number[];
  readonly words: readonly TimedWord[];
  readonly transcript: string;
  readonly language: string | null;
}

/** The staged resource plus the exact window the operator will send. */
export interface StagedReferenceSelection {
  readonly referenceId: string;
  readonly name: string;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly peaks: readonly number[];
  readonly words: readonly TimedWord[];
  readonly language: string | null;
  readonly start: number;
  readonly end: number;
  readonly transcript: string;
  readonly transcriptEdited: boolean;
}

/** Live preflight measurements shown beside a reference selection. */
export interface ReferenceSelectionMetrics {
  readonly durationSeconds: number;
  readonly transcriptTokens: number;
  readonly durationExceeded: boolean;
  readonly tokenCeilingExceeded: boolean;
}

/** The duration wall selected for the current branch configuration. */
export interface ReferenceCeilingSelection {
  readonly maxSeconds: number;
  readonly measured: boolean;
}

const OPENING_PUNCTUATION = /[([{“‘「『《〈【〔]$/u;
const CLOSING_PUNCTUATION = /^[,.;:!?，。；：！？、…'’”」』》〉】〕)\]}]/u;
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2ebef}]/u;

function validWords(words: readonly TimedWord[]): TimedWord[] {
  return [...words]
    .filter(
      ({ word, start, end }) =>
        word.trim().length > 0 &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        end >= start,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function joinWords(words: readonly TimedWord[]): string {
  if (words.length === 0) return '';
  // faster-whisper retains leading spaces when its tokenizer emits them.
  // Concatenation is the only exact reconstruction for that representation.
  if (words.some(({ word }) => /^\s|\s$/u.test(word))) {
    return words.map(({ word }) => word).join('').trim();
  }

  let transcript = '';
  for (const { word: raw } of words) {
    const word = raw.trim();
    if (!word) continue;
    if (!transcript) {
      transcript = word;
      continue;
    }
    const previous = transcript.at(-1) ?? '';
    const needsSpace =
      !CLOSING_PUNCTUATION.test(word) &&
      !OPENING_PUNCTUATION.test(previous) &&
      !(CJK.test(previous) && CJK.test(word.at(0) ?? ''));
    transcript += `${needsSpace ? ' ' : ''}${word}`;
  }
  return transcript;
}

function nearest(values: readonly number[], target: number): number {
  const first = values[0];
  if (first === undefined) return target;
  return values.slice(1).reduce((best, value) => {
    const distance = Math.abs(value - target);
    const bestDistance = Math.abs(best - target);
    return distance < bestDistance || (distance === bestDistance && value < best)
      ? value
      : best;
  }, first);
}

function positiveDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Read the branch-specific duration wall from the findings response.
 *
 * CFG 1.0 is the unbranched graph; every other value uses the single-CFG
 * branch. Missing or malformed evidence deliberately returns the conservative
 * unmeasured wall instead of inventing measured headroom.
 *
 * @param finding - Whole response from `GET /api/findings`.
 * @param cfgScale - Guidance scale that selects the inference branch.
 * @returns The applicable duration wall and whether it was measured.
 */
export function referenceCeilingFor(
  finding: unknown,
  cfgScale: number,
): ReferenceCeilingSelection {
  const fallback: ReferenceCeilingSelection = {
    maxSeconds: CONSERVATIVE_REFERENCE_MAX_SECONDS,
    measured: false,
  };
  if (typeof finding !== 'object' || finding === null) return fallback;
  const rawCeiling = (finding as Record<string, unknown>).referenceCeiling;
  if (typeof rawCeiling !== 'object' || rawCeiling === null) return fallback;
  const ceiling = rawCeiling as Record<string, unknown>;
  if (ceiling.measured !== true) return fallback;
  const rawModes = ceiling.ceilingByBranchMode;
  if (typeof rawModes !== 'object' || rawModes === null) return fallback;
  const modes = rawModes as Record<string, unknown>;
  const selected = cfgScale === 1.0 ? modes.noCfg : modes.singleCfg;
  if (typeof selected !== 'number' || !Number.isFinite(selected) || selected <= 0) {
    return fallback;
  }
  return { maxSeconds: selected, measured: true };
}

/**
 * Reconstruct the transcript for the words fully contained by an interval.
 *
 * @param words - Timed ASR words from intake.
 * @param start - Inclusive audio-window start in seconds.
 * @param end - Inclusive audio-window end in seconds.
 * @returns Text naming only words whose complete audio is selected.
 */
export function sliceReferenceTranscript(
  words: readonly TimedWord[],
  start: number,
  end: number,
): string {
  return joinWords(
    validWords(words).filter((word) => word.start >= start && word.end <= end),
  );
}

/**
 * Create the first valid window for an intake response.
 *
 * Word timing is used to avoid starting or ending inside speech. A long
 * recording is capped at the supplied wall before the operator can generate;
 * a recording without ASR timing remains trimmable on audio-frame boundaries.
 *
 * @param resource - Validated gateway intake metadata.
 * @param name - Source name shown in the UI.
 * @param maxSeconds - Current measured or conservative reference wall.
 * @returns A staged selection ready for the trimmer.
 */
export function createInitialReferenceSelection(
  resource: StagedReferenceResource,
  name: string,
  maxSeconds: number,
): StagedReferenceSelection {
  const durationSeconds = positiveDuration(resource.durationSeconds);
  const ceiling = positiveDuration(maxSeconds) || CONSERVATIVE_REFERENCE_MAX_SECONDS;
  const words = validWords(resource.words).filter(
    ({ end }) => end <= durationSeconds,
  );
  const initial: StagedReferenceSelection = {
    referenceId: resource.id,
    name,
    durationSeconds,
    sampleRate: resource.sampleRate,
    peaks: resource.peaks,
    words,
    language: resource.language,
    start: 0,
    end: Math.min(durationSeconds, ceiling),
    transcript: resource.transcript.trim(),
    transcriptEdited: false,
  };
  return moveReferenceWindow(initial, 0, ceiling);
}

/**
 * Furthest start position for a duration-bounded selection window.
 *
 * @param selection - Current staged selection.
 * @param maxSeconds - Measured or conservative duration wall.
 * @returns Latest start that leaves one complete maximum-sized window.
 */
export function referenceWindowMaxStart(
  selection: StagedReferenceSelection,
  maxSeconds: number,
): number {
  const duration = positiveDuration(selection.durationSeconds);
  const windowDuration = Math.min(
    duration,
    positiveDuration(maxSeconds) || CONSERVATIVE_REFERENCE_MAX_SECONDS,
  );
  return Math.max(0, duration - windowDuration);
}

/**
 * Move the complete selection window and settle it on word-safe boundaries.
 *
 * The operator moves one unit, never two independent handles. Its end is
 * derived from the active ceiling, so a UI interaction cannot construct an
 * over-duration request. A hand-edited transcript remains operator-owned;
 * otherwise the transcript follows the newly selected complete words.
 *
 * @param selection - Current staged selection.
 * @param targetStartSeconds - Requested position of the selection's start.
 * @param maxSeconds - Measured or conservative duration wall.
 * @returns A new valid selection.
 */
export function moveReferenceWindow(
  selection: StagedReferenceSelection,
  targetStartSeconds: number,
  maxSeconds: number,
): StagedReferenceSelection {
  const duration = positiveDuration(selection.durationSeconds);
  const ceiling = Math.min(
    duration,
    positiveDuration(maxSeconds) || CONSERVATIVE_REFERENCE_MAX_SECONDS,
  );
  const maximumStart = referenceWindowMaxStart(selection, ceiling);
  const target = Number.isFinite(targetStartSeconds)
    ? Math.max(0, Math.min(targetStartSeconds, maximumStart))
    : Math.max(0, Math.min(selection.start, maximumStart));
  const words = validWords(selection.words).filter(({ end }) => end <= duration);

  let start = target;
  let end = Math.min(duration, start + ceiling);
  if (words.length > 0) {
    const candidates = words
      .map((word) => word.start)
      .filter((wordStart) => wordStart <= maximumStart);
    start = candidates.length > 0 ? nearest(candidates, target) : words[0]?.start ?? target;
    const latestAllowed = Math.min(duration, start + ceiling);
    const eligibleEnds = words
      .filter((word) => word.end > start && word.end <= latestAllowed)
      .map((word) => word.end);
    end = eligibleEnds.at(-1) ?? latestAllowed;
  }

  const transcript = selection.transcriptEdited
    ? selection.transcript
    : words.length > 0
      ? sliceReferenceTranscript(words, start, end)
      : selection.transcript;
  return { ...selection, words, start, end, transcript };
}

/**
 * Move a word-safe window by one semantic step for keyboard control.
 *
 * @param selection - Current staged selection.
 * @param direction - Earlier or later in the source recording.
 * @param maxSeconds - Measured or conservative duration wall.
 * @returns The previous or next complete-word window.
 */
export function nudgeReferenceWindow(
  selection: StagedReferenceSelection,
  direction: -1 | 1,
  maxSeconds: number,
): StagedReferenceSelection {
  const maximumStart = referenceWindowMaxStart(selection, maxSeconds);
  const words = validWords(selection.words).filter(
    (word) => word.end <= selection.durationSeconds && word.start <= maximumStart,
  );
  if (words.length === 0) {
    const step = Math.min(1, Math.max(0.1, maxSeconds / 10));
    return moveReferenceWindow(
      selection,
      selection.start + direction * step,
      maxSeconds,
    );
  }

  const starts = words.map((word) => word.start);
  const current = starts.reduce((bestIndex, value, index) =>
    Math.abs(value - selection.start) < Math.abs(starts[bestIndex]! - selection.start)
      ? index
      : bestIndex,
  0);
  const next = Math.max(0, Math.min(starts.length - 1, current + direction));
  return moveReferenceWindow(selection, starts[next]!, maxSeconds);
}

/**
 * Mark a transcript as operator-owned so later handle movement cannot erase it.
 *
 * @param selection - Current staged selection.
 * @param text - Exact transcript entered by the operator.
 * @returns A new divergent selection.
 */
export function editReferenceTranscript(
  selection: StagedReferenceSelection,
  text: string,
): StagedReferenceSelection {
  return { ...selection, transcript: text, transcriptEdited: true };
}

/**
 * Undo transcript divergence and resume selection tracking.
 *
 * @param selection - Current staged selection.
 * @returns A new selection whose transcript matches its contained words.
 */
export function restoreReferenceTranscript(
  selection: StagedReferenceSelection,
): StagedReferenceSelection {
  return {
    ...selection,
    transcript: sliceReferenceTranscript(
      selection.words,
      selection.start,
      selection.end,
    ),
    transcriptEdited: false,
  };
}

/**
 * Measure the current window against its two independent request ceilings.
 *
 * @param selection - Current staged selection.
 * @param maxSeconds - Measured or conservative audio wall.
 * @param tokenCeiling - Text-encoder ceiling for the current mode and CFG.
 * @returns Values and over-limit flags for display and preflight gating.
 */
export function referenceSelectionMetrics(
  selection: StagedReferenceSelection,
  maxSeconds: number,
  tokenCeiling: number,
): ReferenceSelectionMetrics {
  const durationSeconds = Math.max(0, selection.end - selection.start);
  const transcriptTokens = estimateTokens(selection.transcript);
  return {
    durationSeconds,
    transcriptTokens,
    durationExceeded: durationSeconds > maxSeconds + Number.EPSILON,
    tokenCeilingExceeded: transcriptTokens > tokenCeiling,
  };
}

/**
 * Name the first reference problem that would make synthesis fail.
 *
 * @param selection - Current staged selection.
 * @param maxSeconds - Measured or conservative audio wall.
 * @param tokenCeiling - Text-encoder ceiling for the current mode and CFG.
 * @returns A contextual disabled reason, or null when the reference can send.
 */
export function referenceSelectionBlocker(
  selection: StagedReferenceSelection,
  maxSeconds: number,
  tokenCeiling: number,
): string | null {
  if (!selection.transcript.trim()) {
    return 'Add the exact transcript of the selected reference audio.';
  }
  const metrics = referenceSelectionMetrics(selection, maxSeconds, tokenCeiling);
  if (metrics.durationExceeded) {
    return `The reference selection is ${metrics.durationSeconds.toFixed(2)}s — past the ${maxSeconds.toFixed(2)}s limit. Shorten it to generate.`;
  }
  if (metrics.tokenCeilingExceeded) {
    return `The reference transcript is about ${metrics.transcriptTokens} tokens — past the ${tokenCeiling}-token limit. Shorten it to generate.`;
  }
  return null;
}
