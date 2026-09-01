/**
 * Word-safe reference audio trimming.
 *
 * The waveform is a view of the staged recording, while selection movement
 * and transcript reconstruction delegate to one bounded selection control, so
 * pointer and keyboard input cannot produce different windows or exceed the
 * active inference limit.
 *
 * @module
 */

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import {
  editReferenceTranscript,
  moveReferenceWindow,
  nudgeReferenceWindow,
  referenceSelectionMetrics,
  referenceWindowMaxStart,
  restoreReferenceTranscript,
  type StagedReferenceSelection,
} from '../state/reference.js';

/** Dependencies and state needed by the reference trimmer. */
export interface ReferenceTrimmerProps {
  readonly reference: StagedReferenceSelection;
  readonly maxSeconds: number;
  readonly maxMeasured: boolean;
  readonly cfgScale: number;
  readonly branchLimits: {
    readonly noCfg: number;
    readonly singleCfg: number;
  } | null;
  readonly tokenCeiling: number;
  /** Build a gateway URL that serves only the requested interval. */
  readonly audioUrl: (start: number, end: number) => string;
  readonly onChange: (reference: StagedReferenceSelection) => void;
  /** Actionable health copy shown when recognition returned no words. */
  readonly asrRemedy?: string | null;
}

const WAVEFORM_HEIGHT = 112;
const FALLBACK_WAVEFORM_WIDTH = 640;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatSeconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

/**
 * Draw normalized peaks at the canvas's current rendered dimensions.
 *
 * The backing bitmap is rebuilt at device resolution every time. It is never
 * stretched from the intake's fixed peak count or from an earlier width.
 */
function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: readonly number[],
  durationSeconds: number,
  start: number,
  end: number,
): void {
  const renderedWidth = Math.max(
    1,
    Math.round(canvas.getBoundingClientRect().width || canvas.clientWidth || FALLBACK_WAVEFORM_WIDTH),
  );
  const density = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(renderedWidth * density);
  canvas.height = Math.round(WAVEFORM_HEIGHT * density);

  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(density, 0, 0, density, 0, 0);
  context.clearRect(0, 0, renderedWidth, WAVEFORM_HEIGHT);
  context.fillStyle = '#f5f5f5';
  context.fillRect(0, 0, renderedWidth, WAVEFORM_HEIGHT);

  if (peaks.length === 0 || durationSeconds <= 0) return;
  const centre = WAVEFORM_HEIGHT / 2;
  const columnWidth = renderedWidth / peaks.length;
  peaks.forEach((rawPeak, index) => {
    const peak = clamp(rawPeak, 0, 1);
    const columnTime = ((index + 0.5) / peaks.length) * durationSeconds;
    context.fillStyle = columnTime >= start && columnTime <= end ? '#e3000b' : '#666666';
    const barHeight = Math.max(1, peak * (WAVEFORM_HEIGHT - 16));
    context.fillRect(index * columnWidth, centre - barHeight / 2, Math.max(1, columnWidth), barHeight);
  });
}

/**
 * Render the waveform, bounded selection, transcript and preflight metrics.
 *
 * @param props - Staged reference and the active request ceilings.
 * @returns The complete inline trimming surface.
 */
export function ReferenceTrimmer(props: ReferenceTrimmerProps): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const dragOffsetSeconds = useRef(0);
  const transcriptId = useId();
  const boundedReference = moveReferenceWindow(
    props.reference,
    props.reference.start,
    props.maxSeconds,
  );
  const reference = boundedReference;
  const metrics = referenceSelectionMetrics(reference, props.maxSeconds, props.tokenCeiling);
  const maximumStart = referenceWindowMaxStart(reference, props.maxSeconds);

  useEffect(() => {
    if (
      reference.start !== props.reference.start ||
      reference.end !== props.reference.end ||
      reference.transcript !== props.reference.transcript
    ) {
      props.onChange(reference);
    }
  }, [
    props.onChange,
    props.reference.end,
    props.reference.start,
    props.reference.transcript,
    reference.end,
    reference.start,
    reference.transcript,
  ]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return undefined;
    const redraw = (): void => {
      drawWaveform(
        element,
        reference.peaks,
        reference.durationSeconds,
        reference.start,
        reference.end,
      );
    };
    redraw();

    const parent = element.parentElement ?? element;
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(redraw);
      observer.observe(parent);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', redraw);
    return () => window.removeEventListener('resize', redraw);
  }, [reference.durationSeconds, reference.end, reference.peaks, reference.start]);

  const moveWindow = (startSeconds: number): void => {
    props.onChange(moveReferenceWindow(reference, startSeconds, props.maxSeconds));
  };

  const timeAtPointer = (event: ReactPointerEvent<HTMLCanvasElement>): number => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return reference.start;
    const fraction = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    return fraction * reference.durationSeconds;
  };

  const onWaveformPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const seconds = timeAtPointer(event);
    const inside = seconds >= reference.start && seconds <= reference.end;
    dragOffsetSeconds.current = inside
      ? seconds - reference.start
      : (reference.end - reference.start) / 2;
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    moveWindow(seconds - dragOffsetSeconds.current);
  };

  const onSelectionKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const direction =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? -1
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? 1
          : null;
    if (direction === null) return;
    event.preventDefault();
    props.onChange(nudgeReferenceWindow(reference, direction, props.maxSeconds));
  };

  return (
    <section className="reference-trimmer" aria-label="Reference trimmer">
      <div className="row row--between">
        <div>
          <p className="caption caption--ink">Selected reference window</p>
          <p className="caption" style={{ marginBottom: 0 }}>{reference.name}</p>
        </div>
        <p className="caption meter" aria-label="Selected reference times">
          {formatSeconds(reference.start)}–{formatSeconds(reference.end)}
        </p>
      </div>

      <div className="reference-trimmer__waveform">
        <canvas
          ref={canvas}
          className="reference-trimmer__canvas"
          role="img"
          aria-label="Reference waveform; drag the selected window or use the position control below"
          onPointerDown={onWaveformPointerDown}
          onPointerMove={(event) => {
            if (dragging.current) {
              moveWindow(timeAtPointer(event) - dragOffsetSeconds.current);
            }
          }}
          onPointerUp={(event) => {
            dragging.current = false;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        />
        <span
          className="reference-trimmer__selection"
          aria-hidden="true"
          style={{
            left: `${(reference.start / reference.durationSeconds) * 100}%`,
            width: `${((reference.end - reference.start) / reference.durationSeconds) * 100}%`,
          }}
        />
      </div>

      <label className="reference-trimmer__position">
        <span className="caption caption--ink">
          Move selection — {formatSeconds(reference.start)} to {formatSeconds(reference.end)}
        </span>
        <input
          type="range"
          aria-label="Reference selection position"
          aria-valuetext={`${formatSeconds(reference.start)} to ${formatSeconds(reference.end)}`}
          min={0}
          max={Math.max(maximumStart, reference.start)}
          step={0.01}
          value={reference.start}
          disabled={maximumStart <= 0}
          onKeyDown={onSelectionKeyDown}
          onChange={(event) => moveWindow(Number(event.target.value))}
        />
      </label>

      <audio
        className="reference-trimmer__audio"
        aria-label="Play selected reference window"
        controls
        preload="none"
        src={props.audioUrl(reference.start, reference.end)}
      />

      <div className="reference-trimmer__metrics" aria-label="Reference limits">
        <p
          className="caption meter"
          aria-label="Reference duration limit"
        >
          Window {formatSeconds(metrics.durationSeconds)} / {formatSeconds(props.maxSeconds)} maximum
        </p>
        <p
          className={`caption meter${metrics.tokenCeilingExceeded ? ' meter--over' : ''}`}
          aria-label="Reference transcript token limit"
        >
          Transcript {metrics.transcriptTokens} / {props.tokenCeiling} tokens
        </p>
      </div>
      <p className="caption reference-trimmer__measurement">
        {props.maxMeasured && props.branchLimits
          ? `Measured limits — CFG 1.0: ${formatSeconds(props.branchLimits.noCfg)}; CFG above 1.0: ${formatSeconds(props.branchLimits.singleCfg)}. Current CFG ${props.cfgScale.toFixed(1)} uses ${formatSeconds(props.maxSeconds)}.`
          : props.maxMeasured
            ? `Measured limit for the current CFG branch: ${formatSeconds(props.maxSeconds)}.`
            : 'Conservative maximum — this deployment’s reference wall is unmeasured.'}
      </p>

      <label className="field reference-trimmer__transcript" htmlFor={transcriptId}>
        <span className="caption caption--ink">Reference transcript — must be exact</span>
        <textarea
          id={transcriptId}
          aria-label="Reference transcript"
          aria-required="true"
          aria-invalid={!reference.transcript.trim()}
          value={reference.transcript}
          onChange={(event) => props.onChange(editReferenceTranscript(reference, event.target.value))}
        />
      </label>

      {reference.transcriptEdited && (
        <div className="reference-trimmer__divergence blocked" role="status">
          <p className="caption caption--accent">
            Hand edit kept — the transcript no longer follows the selected words.
          </p>
          <button
            type="button"
            className="chip"
            onClick={() => props.onChange(restoreReferenceTranscript(reference))}
          >
            Undo hand edit
          </button>
        </div>
      )}

      {!reference.transcript.trim() && (
        <div className="blocked" role="status">
          <p className="caption caption--accent">
            An exact reference transcript is required before Generate can run.
          </p>
          {props.asrRemedy && <p className="caption">{props.asrRemedy}</p>}
        </div>
      )}
    </section>
  );
}
