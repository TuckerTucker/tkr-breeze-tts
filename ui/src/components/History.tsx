/**
 * Clip history: every generation, with what produced it, replayable for free.
 *
 * Replay reads the gateway's cache and reaches no GPU, so comparing two voices
 * costs nothing and works while the container is scaled to zero. Playback
 * never resets the console, because an A/B comparison must not destroy the
 * work in progress that prompted it.
 *
 * @module
 */

import type { JSX } from 'react';

import {
  formatDuration,
  settingsLine,
  type Clip,
} from '../state/history.js';

/** What history needs. */
export interface HistoryProps {
  readonly clips: readonly Clip[];
  readonly selectedId: string | null;
  readonly onSelect: (clip: Clip) => void;
  readonly onReplay: (clip: Clip) => void;
  readonly onLoadIntoConsole: (clip: Clip) => void;
  readonly onPromoteToReference: (clip: Clip) => void;
  readonly onSaveAsVoice: (clip: Clip) => void;
  /** The download URL for a clip, framed as WAV by the gateway at read. */
  readonly clipUrl: (id: string) => string;
  /** Set when the cache is unreachable; history then renders read-only. */
  readonly readOnlyReason: string | null;
}

/**
 * Render the history list.
 *
 * @param props - Clips and their actions.
 * @returns The history element.
 */
export function History(props: HistoryProps): JSX.Element {
  return (
    <section aria-label="Clips this session">
      <div className="row row--between">
        <p className="caption caption--ink">Clips this session</p>
        <p className="caption">{String(props.clips.length).padStart(2, '0')}</p>
      </div>

      {props.readOnlyReason && (
        <p className="caption blocked" role="status">{props.readOnlyReason}</p>
      )}

      {props.clips.length === 0 ? (
        <p className="caption">
          Nothing yet. Generated clips appear here and replay for free, even while
          the GPU is asleep.
        </p>
      ) : (
        <ul className="list">
          {props.clips.map((clip, index) => (
            <li
              key={clip.id}
              className="list__item"
              aria-selected={props.selectedId === clip.id}
            >
              <button
                type="button"
                className="chip"
                style={{ border: 'none', padding: 0, textAlign: 'left', width: '100%' }}
                onClick={() => props.onSelect(clip)}
              >
                <span className="list__index">
                  {String(props.clips.length - index).padStart(2, '0')}
                </span>
                {clip.request.text.slice(0, 48)}
                {clip.request.text.length > 48 ? '…' : ''}
              </button>
              <p className="caption" style={{ margin: '2px 0 0' }}>
                {settingsLine(clip)} / {formatDuration(clip.durationSeconds)}
              </p>

              {props.selectedId === clip.id && (
                <div className="row" style={{ marginTop: 8 }}>
                  {/* None of these reach the GPU. */}
                  <button type="button" className="chip" onClick={() => props.onReplay(clip)}>
                    Replay
                  </button>
                  <a className="chip" href={props.clipUrl(clip.id)} download>
                    Save WAV
                  </a>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => props.onLoadIntoConsole(clip)}
                  >
                    Load into console
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => props.onPromoteToReference(clip)}
                  >
                    Use as voice →
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => props.onSaveAsVoice(clip)}
                  >
                    Save to library
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="caption" style={{ marginTop: 8 }}>
        Replay is served from the local cache — instant, free, and unaffected by
        the GPU being asleep.
      </p>
    </section>
  );
}
