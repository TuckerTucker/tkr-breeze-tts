/**
 * Cold start, told honestly.
 *
 * Naming the cold start and pairing it with the measured warm latency is more
 * honest than a spinner. It reframes the wait as a known property of
 * serverless rather than as the model being slow, and it is the difference
 * between a demo that misrepresents a low-latency model and one that explains
 * it.
 *
 * @module
 */

import type { JSX } from 'react';

import {
  WAKE_EXPLANATION,
  WARM_UP_COST,
  readinessSummary,
  wakeCopy,
  warmUpBlockedReason,
  type MeasuredLatency,
  type Readiness,
} from '../state/readiness.js';

/** The readiness indicator shown before submission. */
export function ReadinessBadge(props: {
  readonly readiness: Readiness;
  readonly measured: MeasuredLatency | null;
}): JSX.Element {
  return (
    <div className="status-pill">
      <span className={`status-dot status-dot--${props.readiness}`} aria-hidden="true" />
      <span className="caption caption--ink" role="status">
        {readinessSummary(props.readiness, props.measured)}
      </span>
    </div>
  );
}

/** What the warm-up control needs. */
export interface WarmUpButtonProps {
  readonly readiness: Readiness;
  /** True while a wake this control started is still in flight. */
  readonly waking: boolean;
  readonly onWarmUp: () => void;
}

/**
 * Pay the cold start deliberately, instead of at the first generation.
 *
 * Disabled rather than hidden when it would do nothing, per the standing rule
 * that an unavailable action is greyed out with its reason beside it. Hiding it
 * would also make the control appear and vanish from the masthead as the warm
 * window opens and closes, which reads as a glitch rather than as a state.
 *
 * The cost is stated on the control itself. This is the only button in the
 * console that spends money — every other one is free, or is the direct
 * consequence of a generation the operator asked for — and hosted, everyone
 * holding the link can press it. A control that quietly draws down a shared
 * budget is exactly the kind of thing this project writes down.
 *
 * @param props - Current readiness, whether a wake is running, and the handler.
 * @returns The button and its explanation.
 */
export function WarmUpButton(props: WarmUpButtonProps): JSX.Element {
  const reason = warmUpBlockedReason(props.readiness, props.waking);
  return (
    <div className="warm-up">
      <button
        type="button"
        className="chip"
        onClick={props.onWarmUp}
        disabled={reason !== null}
        aria-describedby="warm-up-note"
      >
        {props.waking ? 'Warming…' : 'Warm up'}
      </button>
      <span id="warm-up-note" className="warm-up__note">
        {reason ?? WARM_UP_COST}
      </span>
    </div>
  );
}

/** What the waking panel needs. */
export interface WakeStateProps {
  readonly elapsedMs: number;
  readonly measured: MeasuredLatency | null;
}

/**
 * Render the waking state.
 *
 * Rendered only on a cold request. A warm request shows none of this at all,
 * which is what makes the cold one legible when it appears.
 *
 * @param props - Elapsed time and recorded figures.
 * @returns The panel element.
 */
export function WakeState(props: WakeStateProps): JSX.Element {
  const copy = wakeCopy(props.elapsedMs, props.measured);
  return (
    <section className="wake" aria-label="Waking the GPU" role="status">
      <p className="caption caption--accent">Waking the GPU — container cold start</p>
      <p className="wake__elapsed">{Math.floor(props.elapsedMs / 1000)}</p>
      <p className="caption">{copy.elapsed}</p>
      <p className="caption caption--ink">{copy.expectation}</p>

      <p className="caption caption--ink" style={{ marginTop: 16 }}>Why this happens</p>
      {WAKE_EXPLANATION.map((line) => (
        <p key={line} className="caption" style={{ marginBottom: 2 }}>{line}</p>
      ))}
      <p className="caption" style={{ marginTop: 16 }}>
        Replay of anything already generated works while this happens — it never
        reaches the GPU.
      </p>
    </section>
  );
}

/** The per-clip figures shown once playback has begun. */
export function FirstAudioReadout(props: {
  readonly ttfaMs: number | null;
  readonly rtf: number | null;
  readonly transport: 'streaming' | 'buffered';
  readonly fellBack: boolean;
}): JSX.Element {
  return (
    <section className="panel--inset" aria-label="Measured latency">
      <div className="row" style={{ gap: 32 }}>
        <div>
          <p className="caption">First audio</p>
          <div className="metric">
            <span className="metric__value">
              {props.ttfaMs === null ? '—' : Math.round(props.ttfaMs)}
            </span>
            <span className="metric__unit">ms</span>
          </div>
        </div>
        <div>
          <p className="caption">Real-time factor</p>
          <div className="metric">
            <span className="metric__value">
              {props.rtf === null ? '—' : props.rtf.toFixed(2)}
            </span>
          </div>
        </div>
        <div>
          <p className="caption">Transport</p>
          <div className="metric">
            <span className="metric__unit">
              {props.transport === 'streaming' ? 'Streaming PCM' : 'Buffered WAV'}
            </span>
          </div>
        </div>
      </div>
      <p className="caption" style={{ marginTop: 8, marginBottom: 0 }}>
        {props.fellBack
          ? 'The AudioWorklet could not start, so this played through the buffered path.'
          : props.transport === 'streaming'
            ? 'Audio started before generation finished — this number was observed here, not quoted.'
            : 'Buffered: the whole clip arrived before playback began.'}
      </p>
    </section>
  );
}
