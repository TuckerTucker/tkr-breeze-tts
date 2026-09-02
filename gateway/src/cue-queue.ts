/**
 * The cue queue: strictly sequential, resumable, cache-first.
 *
 * Sequential is not a limitation worked around — it is the shape the vendor
 * declares. `breeze_infer/api.py` holds a process-wide `_request_lock` and
 * returns 409 to anything concurrent, and `configs/fast.json` sets
 * `concurrency: 1`. Running cues one at a time means a 409 is impossible by
 * construction rather than merely unlikely.
 *
 * A cue whose audio is already cached never reaches the GPU. That is what
 * makes correcting one line in a forty-line script cost one request.
 *
 * @module
 */

import type { Logger } from 'pino';

import type { ClipCache } from './cache.js';
import { GatewayError } from './proxy.js';
import {
  ceilingRefusal,
  clipIdFor,
  cueCeilingInput,
  cueMode,
  findCeilingBreach,
  type Cue,
  type ScriptRecord,
  type VoiceReferenceProfile,
} from './script.js';

/** What a cue run produced. */
export interface CueResult {
  readonly cueId: string;
  /** Whether audio came from cache rather than the GPU. */
  readonly fromCache: boolean;
  readonly durationSeconds: number | null;
  readonly state: Cue['state'];
  readonly problem: string | null;
}

/** Progress, emitted as each cue changes state. */
export interface RunProgress {
  readonly scriptId: string;
  readonly cueId: string;
  readonly index: number;
  readonly total: number;
  readonly state: Cue['state'];
  readonly fromCache: boolean;
  readonly problem: string | null;
}

/**
 * Generate one cue's audio.
 *
 * Injected so the queue's ordering, caching and failure handling are testable
 * without a GPU.
 */
export type SynthesizeCue = (
  cue: Cue,
  script: ScriptRecord,
) => Promise<{ clipId: string; durationSeconds: number }>;

/** The outcome of running a whole script. */
export interface RunSummary {
  readonly scriptId: string;
  readonly total: number;
  /** Cues whose audio was already on disk. */
  readonly served: number;
  /** Cues that reached the GPU. */
  readonly generated: number;
  readonly failed: number;
  readonly unrunnable: number;
  readonly results: CueResult[];
}

/**
 * Run every cue that needs running, in order.
 *
 * A failing cue is marked and the run continues: one missing voice must not
 * abort a script, and the run stays resumable because state is derived from
 * what is in the cache rather than from how far a previous attempt got.
 *
 * @param options - The script, its dependencies, and the injected synthesiser.
 * @returns What happened, per cue and in total.
 */
export async function runScript(options: {
  script: ScriptRecord;
  cache: ClipCache;
  voiceReferences: ReadonlyMap<string, VoiceReferenceProfile>;
  synthesize: SynthesizeCue;
  logger: Logger;
  onProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
}): Promise<RunSummary> {
  const { script, cache, voiceReferences, synthesize, logger, onProgress } = options;
  const log = logger.child({ component: 'cue-queue', scriptId: script.id });

  const results: CueResult[] = [];
  let served = 0;
  let generated = 0;
  let failed = 0;
  let unrunnable = 0;

  const emit = (cue: Cue, fromCache: boolean): void => {
    onProgress?.({
      scriptId: script.id,
      cueId: cue.id,
      index: cue.index,
      total: script.cues.length,
      state: cue.state,
      fromCache,
      problem: cue.problem,
    });
  };

  for (const cue of script.cues) {
    if (options.signal?.aborted) break;

    cue.clipId = clipIdFor(cue);

    if (cue.voiceId && !voiceReferences.has(cue.voiceId)) {
      cue.state = 'unrunnable';
      cue.problem = `the voice “${cue.voiceName ?? cue.voiceId}” is no longer in the library`;
      unrunnable += 1;
      results.push({
        cueId: cue.id,
        fromCache: false,
        durationSeconds: null,
        state: cue.state,
        problem: cue.problem,
      });
      emit(cue, false);
      continue;
    }

    const breach = findCeilingBreach(cueCeilingInput(cue, voiceReferences));
    if (breach) {
      // Refused before dispatch. Past the ceiling the vendor's frozen graph
      // cache raises and the connection aborts with no audio, so dispatching
      // would burn a GPU request to produce nothing.
      cue.state = 'unrunnable';
      const refusal = ceilingRefusal(breach, cueMode(cue));
      cue.problem = `${refusal.message}. ${refusal.remedy}`;
      unrunnable += 1;
      results.push({
        cueId: cue.id,
        fromCache: false,
        durationSeconds: null,
        state: cue.state,
        problem: cue.problem,
      });
      emit(cue, false);
      continue;
    }

    const cached = cache.get(cue.clipId);
    if (cached) {
      cue.state = 'done';
      cue.actualSeconds = cached.durationSeconds;
      cue.driftSeconds = driftFor(cue, cached.durationSeconds);
      cue.problem = null;
      served += 1;
      results.push({
        cueId: cue.id,
        fromCache: true,
        durationSeconds: cached.durationSeconds,
        state: 'done',
        problem: null,
      });
      emit(cue, true);
      continue;
    }

    cue.state = 'generating';
    cue.problem = null;
    emit(cue, false);

    try {
      const produced = await synthesize(cue, script);
      cue.state = 'done';
      cue.clipId = produced.clipId;
      cue.actualSeconds = produced.durationSeconds;
      cue.driftSeconds = driftFor(cue, produced.durationSeconds);
      generated += 1;
      results.push({
        cueId: cue.id,
        fromCache: false,
        durationSeconds: produced.durationSeconds,
        state: 'done',
        problem: null,
      });
    } catch (error) {
      // The run continues. A single failure marks one row, not the script.
      const message =
        error instanceof GatewayError ? error.message : (error as Error).message;
      cue.state = 'failed';
      cue.problem = message;
      failed += 1;
      log.warn({ cueId: cue.id, err: message }, 'cue failed; continuing with the rest');
      results.push({
        cueId: cue.id,
        fromCache: false,
        durationSeconds: null,
        state: 'failed',
        problem: message,
      });
    }
    emit(cue, false);
  }

  return {
    scriptId: script.id,
    total: script.cues.length,
    served,
    generated,
    failed,
    unrunnable,
    results,
  };
}

/**
 * Measure drift against an imported target.
 *
 * Reported, never corrected. There is deliberately no time-stretch and no
 * pitch correction anywhere in this codebase: distorting the audio to hit a
 * slot would misrepresent what the model produced, which is the one thing a
 * demo of a model must not do.
 *
 * @param cue - The cue, carrying any imported target timing.
 * @param actualSeconds - The generated duration.
 * @returns Generated minus target in seconds, or null when untimed.
 */
export function driftFor(cue: Cue, actualSeconds: number): number | null {
  if (cue.targetStart === null || cue.targetEnd === null) return null;
  return Number((actualSeconds - (cue.targetEnd - cue.targetStart)).toFixed(3));
}
