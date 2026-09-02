/** Shared playback surface for generated script cues. */

import type { JSX, RefObject } from 'react';

import type { Cue } from '../state/script.js';

/** What the script preview surface needs from its workspace owner. */
export interface ScriptPreviewPlayerProps {
  readonly cue: Cue | null;
  readonly source: string | null;
  readonly playerRef: RefObject<HTMLAudioElement>;
  readonly loading: boolean;
  readonly playing: boolean;
  readonly problem: string | null;
  readonly onPlay: () => void;
  readonly onPlaying: () => void;
  readonly onPause: () => void;
  readonly onWaiting: () => void;
  readonly onError: () => void;
}

/**
 * Render one persistent player for whichever generated cue is selected.
 *
 * The player consumes the cue's cached WAV route. It never dispatches a new
 * synthesis request, so previews remain available while Modal is asleep or
 * another cue is being generated.
 *
 * @param props - Selected cue, cached source, and playback lifecycle handlers.
 * @returns The script preview surface.
 */
export function ScriptPreviewPlayer(
  props: ScriptPreviewPlayerProps,
): JSX.Element {
  const number = props.cue ? props.cue.index + 1 : null;
  const status = props.problem
    ?? (number === null
      ? 'Run a cue to make its preview available.'
      : props.loading
        ? `Loading cue ${number} preview…`
        : props.playing
          ? `Playing cue ${number}.`
          : `Cue ${number} is ready to preview.`);

  return (
    <section
      className="script-preview"
      aria-label="Generated cue preview"
      aria-busy={props.loading}
    >
      <div className="script-preview__copy">
        <p className="step-label">Generation preview</p>
        <p className="script-preview__line">
          {props.cue
            ? <><strong>Cue {number}</strong> · {props.cue.text}</>
            : 'No generated audio yet.'}
        </p>
        <p
          className={props.problem ? 'inline-problem' : 'script-preview__status'}
          role="status"
          aria-live="polite"
        >
          {status}
        </p>
      </div>

      {props.cue && props.source && (
        <audio
          ref={props.playerRef}
          controls
          preload="none"
          src={props.source}
          aria-label={`Preview generated audio for cue ${number}`}
          onPlay={props.onPlay}
          onPlaying={props.onPlaying}
          onPause={props.onPause}
          onEnded={props.onPause}
          onWaiting={props.onWaiting}
          onError={props.onError}
        />
      )}
    </section>
  );
}
