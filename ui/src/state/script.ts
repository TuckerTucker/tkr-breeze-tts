/**
 * The script, as the browser edits it.
 *
 * The cue list is the document. Editing one row must cost one row — every
 * other row keeps its generated audio and replays from cache — which is the
 * difference between a script feature that is usable and one that is not.
 *
 * @module
 */

import { MAX_TOKENS, estimateTokens } from './draft.js';

/** Where a cue stands, shown in place on its row. */
export type CueState = 'queued' | 'generating' | 'done' | 'stale' | 'failed' | 'unrunnable';

/** One line of the script. */
export interface Cue {
  readonly id: string;
  readonly index: number;
  readonly text: string;
  readonly voiceId: string | null;
  readonly voiceName: string | null;
  readonly cfgScale: number;
  readonly seed: number;
  readonly targetStart: number | null;
  readonly targetEnd: number | null;
  readonly state: CueState;
  readonly clipId: string;
  readonly actualSeconds: number | null;
  readonly driftSeconds: number | null;
  readonly problem: string | null;
}

/** A block of an imported file that could not be read. */
export interface CueProblem {
  readonly block: number;
  readonly reason: string;
  readonly raw: string;
}

/** A script and its cues. */
export interface Script {
  readonly id: string;
  readonly name: string;
  readonly source: 'vtt' | 'text';
  readonly cues: Cue[];
  readonly problems: CueProblem[];
}

/** How each state reads on a row. */
export const CUE_STATE_LABEL: Record<CueState, string> = {
  queued: 'QUEUED',
  generating: 'GENERATING',
  done: 'DONE',
  stale: 'STALE / EDITED',
  failed: 'FAILED',
  unrunnable: 'NEEDS ATTENTION',
};

/**
 * The target slot length a cue was imported with.
 *
 * @param cue - The cue.
 * @returns Seconds, or null for an untimed cue.
 */
export function targetSeconds(cue: Cue): number | null {
  if (cue.targetStart === null || cue.targetEnd === null) return null;
  return cue.targetEnd - cue.targetStart;
}

/**
 * How drift should read on a row.
 *
 * Always displayed, never resolved. There is no option here that would stretch
 * audio to fit, because that option does not exist anywhere in the system: the
 * three honest responses are reroll, shorten, or accept.
 *
 * @param cue - The cue.
 * @returns A signed string such as `+0.7s`, or `—` when there is nothing to say.
 */
export function driftLabel(cue: Cue): string {
  if (cue.driftSeconds === null || cue.actualSeconds === null) return '—';
  if (Math.abs(cue.driftSeconds) < 0.05) return '—';
  const sign = cue.driftSeconds > 0 ? '+' : '';
  return `${sign}${cue.driftSeconds.toFixed(1)}s`;
}

/** The three responses to drift the system actually offers. */
export const DRIFT_RESPONSES = ['Reroll the seed', 'Shorten the line', 'Accept'] as const;

/**
 * Whether a row can be run, and why not when it cannot.
 *
 * @param cue - The cue.
 * @param availableVoiceIds - Voices still in the library.
 * @returns A reason, or null when the row is runnable.
 */
export function cueBlocker(
  cue: Cue,
  availableVoiceIds: ReadonlySet<string>,
): string | null {
  if (cue.voiceId && !availableVoiceIds.has(cue.voiceId)) {
    return `The voice “${cue.voiceName ?? cue.voiceId}” is no longer in the library.`;
  }
  const tokens = estimateTokens(cue.text);
  if (tokens > MAX_TOKENS) {
    return `About ${tokens} tokens, past the ${MAX_TOKENS}-token ceiling.`;
  }
  if (!cue.text.trim()) return 'This row has no text.';
  return null;
}

/** A run's progress, aggregated for the header. */
export interface ScriptProgress {
  readonly total: number;
  readonly done: number;
  readonly stale: number;
  readonly cached: number;
  readonly failed: number;
}

/**
 * Summarise a script for the progress header.
 *
 * @param script - The script.
 * @returns Counts by state.
 */
export function progressOf(script: Script): ScriptProgress {
  const count = (state: CueState): number =>
    script.cues.filter((cue) => cue.state === state).length;
  return {
    total: script.cues.length,
    done: count('done'),
    stale: count('stale') + count('queued'),
    cached: count('done'),
    failed: count('failed') + count('unrunnable'),
  };
}

/**
 * Apply an edit to one row, leaving every other row untouched.
 *
 * @param script - The script.
 * @param cueId - The row being edited.
 * @param patch - What changed.
 * @returns A new script with only that row replaced and marked stale.
 */
export function editCue(
  script: Script,
  cueId: string,
  patch: Partial<Pick<Cue, 'text' | 'voiceId' | 'voiceName' | 'cfgScale' | 'seed'>>,
): Script {
  return {
    ...script,
    cues: script.cues.map((cue) =>
      cue.id === cueId
        ? { ...cue, ...patch, state: 'stale', actualSeconds: null, driftSeconds: null }
        : cue,
    ),
  };
}

/**
 * Format a target timing for the row.
 *
 * @param seconds - The offset, or null.
 * @returns `m:ss.s`, or `—`.
 */
export function formatTarget(seconds: number | null): string {
  if (seconds === null) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}
