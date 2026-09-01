/**
 * The script, as the browser edits it.
 *
 * The cue list is the document. Editing one row must cost one row — every
 * other row keeps its generated audio and replays from cache — which is the
 * difference between a script feature that is usable and one that is not.
 *
 * @module
 */

import { estimateTokens, tokenCeilingFor } from './draft.js';

/** Where a cue stands, shown in place on its row. */
export type CueState = 'queued' | 'generating' | 'done' | 'stale' | 'failed' | 'unrunnable';

/** One line of the script. */
export interface Cue {
  readonly id: string;
  readonly index: number;
  readonly text: string;
  readonly voiceId: string | null;
  readonly voiceName: string | null;
  readonly instruction?: string;
  readonly cfgScale: number;
  readonly seed: number;
  readonly overrides?: CueOverrides;
  readonly targetStart: number | null;
  readonly targetEnd: number | null;
  readonly state: CueState;
  readonly clipId: string;
  readonly actualSeconds: number | null;
  readonly driftSeconds: number | null;
  readonly problem: string | null;
}

/** Common delivery values inherited by cues without an explicit exception. */
export interface ScriptDefaults {
  readonly voiceId: string | null;
  readonly voiceName: string | null;
  readonly instruction: string;
  readonly cfgScale: number;
  readonly seedMode: 'fixed' | 'increment';
  readonly seed: number;
}

/** Nullable exceptions; null means inherit the script-level value. */
export interface CueOverrides {
  readonly voiceId: string | null;
  readonly voiceName: string | null;
  readonly instruction: string | null;
  readonly cfgScale: number | null;
  readonly seed: number | null;
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
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly defaults?: ScriptDefaults;
  readonly cues: Cue[];
  readonly problems: CueProblem[];
}

/** Document metadata loaded before the active cue body. */
export interface ScriptSummary {
  readonly id: string;
  readonly name: string;
  readonly source: Script['source'];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cueCount: number;
  readonly doneCount: number;
  readonly failedCount: number;
  readonly defaults: ScriptDefaults;
}

/** Neutral common values for old records and first imports. */
export const INITIAL_SCRIPT_DEFAULTS: ScriptDefaults = {
  voiceId: null,
  voiceName: null,
  instruction: 'Speak clearly and naturally.',
  cfgScale: 1,
  seedMode: 'fixed',
  seed: 42,
};

/** Fully effective delivery values shown and sent for a cue. */
export interface EffectiveCueSettings {
  readonly voiceId: string | null;
  readonly voiceName: string | null;
  readonly instruction: string;
  readonly cfgScale: number;
  readonly seed: number;
}

/**
 * Resolve cue exceptions over script defaults.
 *
 * @param script - Script carrying common values.
 * @param cue - Cue carrying nullable overrides.
 * @returns The values that determine validation and generated audio.
 */
export function effectiveCueSettings(
  script: Pick<Script, 'defaults'>,
  cue: Cue,
): EffectiveCueSettings {
  const defaults = script.defaults ?? INITIAL_SCRIPT_DEFAULTS;
  const overrides = cue.overrides;
  if (!overrides) {
    return {
      voiceId: cue.voiceId,
      voiceName: cue.voiceName,
      instruction: cue.instruction ?? defaults.instruction,
      cfgScale: cue.cfgScale,
      seed: cue.seed,
    };
  }
  return {
    voiceId: overrides.voiceId ?? defaults.voiceId,
    voiceName: overrides.voiceName ?? defaults.voiceName,
    instruction: overrides.instruction ?? defaults.instruction,
    cfgScale: overrides.cfgScale ?? defaults.cfgScale,
    seed:
      overrides.seed ??
      (defaults.seedMode === 'increment' ? defaults.seed + cue.index : defaults.seed),
  };
}

/** API patch shape for cue text and nullable effective-setting exceptions. */
export interface CuePatch {
  readonly text?: string;
  readonly overrides?: Partial<CueOverrides>;
}

/**
 * Apply an optimistic cue patch while preserving every unrelated cue.
 *
 * @param script - Current document.
 * @param cueId - Cue receiving the edit.
 * @param patch - Text or explicit effective-setting changes.
 * @returns A new document with exactly one stale cue.
 */
export function applyCuePatch(
  script: Script,
  cueId: string,
  patch: CuePatch,
): Script {
  return {
    ...script,
    cues: script.cues.map((cue) =>
      cue.id !== cueId
        ? cue
        : {
            ...cue,
            ...(patch.text === undefined ? {} : { text: patch.text }),
            ...(patch.overrides
              ? {
                  overrides: {
                    voiceId: null,
                    voiceName: null,
                    instruction: null,
                    cfgScale: null,
                    seed: null,
                    ...cue.overrides,
                    ...patch.overrides,
                  },
                }
              : {}),
            state: 'stale' as const,
            actualSeconds: null,
            driftSeconds: null,
            problem: null,
          },
    ),
  };
}

function sameEffectiveSettings(
  left: EffectiveCueSettings,
  right: EffectiveCueSettings,
): boolean {
  return (
    left.voiceId === right.voiceId &&
    left.voiceName === right.voiceName &&
    left.instruction === right.instruction &&
    left.cfgScale === right.cfgScale &&
    left.seed === right.seed
  );
}

/**
 * Apply script defaults optimistically and stale only cues whose effective
 * generation settings actually changed.
 *
 * @param script - Current document.
 * @param patch - Script-level values changed by the operator.
 * @returns A document matching the gateway's selective invalidation rule.
 */
export function applyScriptDefaults(
  script: Script,
  patch: Partial<ScriptDefaults>,
): Script {
  const next: Script = {
    ...script,
    defaults: {
      ...INITIAL_SCRIPT_DEFAULTS,
      ...script.defaults,
      ...patch,
    },
  };
  return {
    ...next,
    cues: script.cues.map((cue) =>
      sameEffectiveSettings(
        effectiveCueSettings(script, cue),
        effectiveCueSettings(next, cue),
      )
        ? cue
        : {
            ...cue,
            state: 'stale' as const,
            actualSeconds: null,
            driftSeconds: null,
            problem: null,
          },
    ),
  };
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
  // A cue carrying a library voice is a Clone request and so reaches batch 2
  // even at cfg 1.0; one without is Design and caps at 256 there. The gateway
  // is still authoritative — it can also see the reference transcript, which
  // this row cannot — but a row that will certainly fail says so here first.
  const tokens = estimateTokens(cue.text);
  const ceiling = tokenCeilingFor(cue.voiceId ? 'clone' : 'design', cue.cfgScale);
  if (tokens > ceiling) {
    return `About ${tokens} tokens, past the ${ceiling}-token ceiling.`;
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
