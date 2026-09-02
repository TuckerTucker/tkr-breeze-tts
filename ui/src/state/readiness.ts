/**
 * Readiness and the wake state.
 *
 * Cold start is the interaction most likely to misrepresent a model sold on
 * latency: at roughly twenty times the cost of the generation it precedes, and
 * paid again after every gap longer than the scaledown window, a spinner turns
 * "serverless is waking" into "the model is slow". So it gets its own named
 * state, its own expected duration drawn from measured data, and the warm
 * figure that follows it shown alongside.
 *
 * @module
 */

/** What the gateway believes about the container. */
export type Readiness = 'warm' | 'cold' | 'unknown';

/** Figures recorded by `bench`, or null when nothing has been measured. */
export interface MeasuredLatency {
  /** Time the vendor spent capturing CUDA graphs, in milliseconds. */
  readonly warmupMs: number | null;
  /** Median first-audio time on a cold container. */
  readonly coldTtfaMs: number | null;
  /** Median first-audio time once warm. */
  readonly warmTtfaMs: number | null;
  /** Median real-time factor. */
  readonly rtf: number | null;
}

/** Optional speech-recognition intake reported without waking its GPU. */
export interface AsrHealth {
  readonly available: boolean;
  readonly configured: boolean;
  readonly remedy: string | null;
  readonly lastError: string | null;
}

/** Measured reference-audio ceilings for unbranched and branched inference. */
export interface ReferenceCeiling {
  readonly maxReferenceSeconds: number;
  readonly ceilingByBranchMode: {
    readonly noCfg: number;
    readonly singleCfg: number;
  };
}

/** The gateway's health payload, as the UI reads it. */
export interface Health {
  readonly readiness: Readiness;
  readonly lastUpstreamAt: number | null;
  readonly scaledownWindowMs: number;
  readonly transport: 'streaming' | 'buffered';
  readonly ffmpeg: { available: boolean; remedy: string | null };
  readonly asr: AsrHealth;
  readonly cache: { enabled: boolean; clips: number; bytes: number };
  readonly voices: number;
  readonly references: { staged: number; maxAgeMs: number };
  readonly limits: {
    readonly maxTokens: number;
    readonly tokenCeilingByBatch: Readonly<Record<string, number>>;
    readonly backboneCeilingByBatch: Readonly<Record<string, number>>;
    readonly referenceSeconds: ReferenceCeiling | null;
  };
  readonly measured: MeasuredLatency | null;
}

/** Where a generation currently stands. */
export type GenerationPhase = 'idle' | 'waking' | 'generating' | 'playing' | 'failed';

/**
 * The one-line status shown beside the Generate control.
 *
 * @param readiness - What the gateway reports.
 * @param measured - Recorded figures, or null.
 * @returns Text describing what the next request will cost.
 */
export function readinessSummary(
  readiness: Readiness,
  measured: MeasuredLatency | null,
): string {
  if (readiness === 'warm') {
    return measured?.warmTtfaMs != null
      ? `Warm — expected ${Math.round(measured.warmTtfaMs)}ms to first audio`
      : 'Warm — first-audio time not yet measured';
  }
  if (readiness === 'cold') {
    return measured?.coldTtfaMs != null
      ? `Asleep — the next request is a cold start, about ${formatSeconds(measured.coldTtfaMs)}`
      : 'Asleep — the next request is a cold start, duration not yet measured';
  }
  // A wrong warm claim is the one that misleads, so an unknown says so.
  return 'Readiness unknown — nothing has been generated yet this session';
}

/**
 * What the waking state says while a cold container comes up.
 *
 * @param elapsedMs - How long the wake has taken so far.
 * @param measured - Recorded figures, or null.
 * @returns The heading and the explanation beneath it.
 */
export function wakeCopy(
  elapsedMs: number,
  measured: MeasuredLatency | null,
): { elapsed: string; expectation: string } {
  const elapsed = `${Math.floor(elapsedMs / 1000)} seconds elapsed`;
  if (measured?.coldTtfaMs == null) {
    return {
      elapsed,
      expectation:
        'Expected duration has not been measured yet — run the latency harness to record it.',
    };
  }
  const warm =
    measured.warmTtfaMs != null ? `${Math.round(measured.warmTtfaMs)}ms` : 'a fraction of that';
  const overrun = elapsedMs > measured.coldTtfaMs;
  return {
    elapsed,
    // Past its estimate, the state holds and the elapsed figure keeps moving,
    // rather than collapsing into an indeterminate spinner.
    expectation: overrun
      ? `Longer than the measured ${formatSeconds(measured.coldTtfaMs)} — still waking. Then ${warm} per clip.`
      : `Expected ${formatSeconds(measured.coldTtfaMs)}, then ${warm} per clip once warm.`,
  };
}

/** Why a cold start happens at all, shown in place rather than hidden. */
export const WAKE_EXPLANATION = [
  'The container scaled to zero after the idle window.',
  'Loading 7.7 GB of weights and capturing 53 CUDA graphs takes time.',
  'This cost is paid once, then every clip is fast.',
];

/**
 * Format a millisecond figure as human seconds.
 *
 * @param ms - Milliseconds.
 * @returns A short string such as `45s`.
 */
export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/**
 * What to say when the stream ended before the clip did.
 *
 * Upstream answers `200`, streams, and then closes the connection, so a fault
 * raised while generating never crosses the wire — the gateway sees a socket
 * close and nothing more, and the reason stays in the service's own log. That
 * is a hard limit, not an omission, so this names what was observed and
 * declines to invent a cause. Silence with no explanation is what this
 * replaces: the response is a `200` carrying too few bytes, so nothing in the
 * request path reads as a failure at all.
 *
 * @param playback - What the player managed to receive.
 * @param cfgAdjustable - Whether the current surface can offer CFG as a remedy.
 * @returns The message and remedy to show beside the control.
 */
export function incompleteStreamFailure(playback: {
  readonly bytes: number;
}, cfgAdjustable = true): { message: string; remedy: string } {
  if (playback.bytes === 0) {
    return {
      message: 'the service accepted the request and then closed the stream without sending audio',
      remedy:
        'Nothing came back with the fault, so try again to tell a transient close from a ' +
        (cfgAdjustable
          ? 'repeatable one. If it repeats, shorten the line or change CFG — an input the '
          : 'repeatable one. If it repeats, shorten the line — an input the ') +
        'warmup profile has no captured graph for fails in exactly this shape.',
    };
  }
  return {
    message: 'the stream ended early, so this clip is incomplete rather than fast',
    remedy: 'What played is what arrived. Generate again for a complete clip.',
  };
}

/**
 * Whether the wake state should be shown for this request.
 *
 * Warm requests show none at all — that is what makes the cold one legible.
 *
 * @param readiness - Readiness at the moment the request was sent.
 * @returns True when the request is a cold start.
 */
export function shouldShowWake(readiness: Readiness): boolean {
  return readiness !== 'warm';
}
