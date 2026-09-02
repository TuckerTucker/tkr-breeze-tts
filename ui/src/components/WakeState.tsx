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
  formatSeconds,
  readinessSummary,
  wakeCopy,
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

/** Format a measured figure for prose. Re-exported so callers stay consistent. */
export { formatSeconds };
