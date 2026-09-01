/**
 * The voice library panel.
 *
 * A voice is reference audio plus its exact transcript; the model stores
 * neither. Naming one at the moment the operator decides they like it — with
 * the name pre-filled from the instruction that produced it — is what turns a
 * clip into something they can use again months later.
 *
 * Deleting takes effect immediately and offers an undo. There is no
 * confirmation dialog anywhere here: a dialog shifts responsibility for a
 * decision the system can simply reverse.
 *
 * @module
 */

import { useState, type JSX } from 'react';

import { EMPTY_LIBRARY_COPY, originLine, type PendingUndo, type Voice } from '../state/voices.js';

/** What the library panel needs. */
export interface VoiceLibraryProps {
  readonly voices: readonly Voice[];
  readonly selectedId: string | null;
  readonly onSelect: (voice: Voice) => void;
  readonly onRename: (voice: Voice, name: string) => void;
  readonly onDelete: (voice: Voice) => void;
  readonly onUndo: (undo: PendingUndo) => void;
  readonly pendingUndo: PendingUndo | null;
}

/**
 * Render the library.
 *
 * @param props - Voices and their actions.
 * @returns The panel element.
 */
export function VoiceLibrary(props: VoiceLibraryProps): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  return (
    <section aria-label="Your voices">
      <div className="row row--between">
        <p className="caption caption--ink">Your voices</p>
        <p className="caption">kept locally, not on the GPU</p>
      </div>

      {props.pendingUndo && (
        <p className="caption blocked" role="status">
          Deleted “{props.pendingUndo.voice.name}”.{' '}
          <button
            type="button"
            className="chip"
            onClick={() => props.onUndo(props.pendingUndo!)}
          >
            Undo
          </button>
        </p>
      )}

      {props.voices.length === 0 ? (
        <p className="caption">{EMPTY_LIBRARY_COPY}</p>
      ) : (
        <ul className="list">
          {props.voices.map((voice, index) => (
            <li
              key={voice.id}
              className="list__item"
              aria-selected={props.selectedId === voice.id}
            >
              <div className="row row--between">
                <div style={{ minWidth: 0 }}>
                  <span className="list__index">{String(index + 1).padStart(2, '0')}</span>
                  {editingId === voice.id ? (
                    <input
                      type="text"
                      aria-label={`Rename ${voice.name}`}
                      value={draftName}
                      autoFocus
                      onChange={(event) => setDraftName(event.target.value)}
                      onBlur={() => {
                        props.onRename(voice, draftName);
                        setEditingId(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          props.onRename(voice, draftName);
                          setEditingId(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="chip"
                      disabled={!voice.available}
                      onClick={() => props.onSelect(voice)}
                    >
                      {voice.name}
                    </button>
                  )}
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="chip"
                    onClick={() => {
                      setEditingId(voice.id);
                      setDraftName(voice.name);
                    }}
                  >
                    Rename
                  </button>
                  <button type="button" className="chip" onClick={() => props.onDelete(voice)}>
                    Delete
                  </button>
                </div>
              </div>
              <p className="caption" style={{ margin: '2px 0 0' }}>
                {originLine(voice)}
                {voice.defaultDirection ? ` / ${voice.defaultDirection.toUpperCase()}` : ''}
              </p>
              {!voice.available && (
                <p className="caption blocked">
                  Audio unavailable — save it again from a clip.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The inline save-as-voice affordance shown on the player and on history. */
export function SaveAsVoice(props: {
  readonly suggestedName: string;
  readonly onSave: (name: string) => void;
  readonly disabledReason: string | null;
}): JSX.Element {
  const [name, setName] = useState(props.suggestedName);
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <input
        type="text"
        aria-label="Voice name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button
        type="button"
        className="chip"
        disabled={props.disabledReason !== null}
        onClick={() => props.onSave(name)}
      >
        Save as voice
      </button>
      {props.disabledReason && <span className="caption blocked">{props.disabledReason}</span>}
    </div>
  );
}
