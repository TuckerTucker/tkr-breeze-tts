/**
 * Design, Clone and Direction — three ways to specify a voice.
 *
 * Reference intake offers upload, microphone and the saved library as three
 * *peer* options. Upload is not a fallback for a missing microphone: a clean
 * existing recording is usually the better reference, and far more likely to
 * come with the exact transcript the vendor requires.
 *
 * The reference field and the transcript field are revealed together and never
 * separately, so the half-formed pair the vendor rejects cannot be expressed.
 *
 * @module
 */

import { useRef, useState, type JSX } from 'react';

import { CfgControl } from './CfgControl.js';
import {
  CFG_LABEL,
  MODE_BLURB,
  needsReference,
  type CfgControl as CfgControlShape,
  type ModeState,
  type Reference,
  type VoiceMode,
} from '../state/mode.js';
import { EMPTY_LIBRARY_COPY, isSelectable, type Voice } from '../state/voices.js';

/** What the mode panel needs. */
export interface VoiceModesProps {
  readonly state: ModeState;
  readonly onChange: (state: ModeState) => void;
  readonly onModeChange: (mode: VoiceMode) => void;
  readonly cfgControl: CfgControlShape;
  readonly cfgUnmeasured: boolean;
  readonly voices: readonly Voice[];
  /** False when ffmpeg is absent, which is the one thing that disables capture. */
  readonly canRecord: boolean;
  readonly recordDisabledReason: string | null;
}

const MODES: readonly VoiceMode[] = ['design', 'clone', 'direction'];

/**
 * Render the mode selector and its mode-appropriate fields.
 *
 * @param props - Mode state and its dependencies.
 * @returns The panel element.
 */
export function VoiceModes(props: VoiceModesProps): JSX.Element {
  const { state, onChange } = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);

  const acceptFile = (file: File | undefined): void => {
    if (!file) return;
    // Rejected at the point of drop, with the reason shown — not on submit.
    if (!file.type.startsWith('audio/') && !/\.(wav|mp3|m4a|ogg|flac|webm)$/i.test(file.name)) {
      setFileProblem(`“${file.name}” is ${file.type || 'not a recognised audio file'}.`);
      return;
    }
    setFileProblem(null);
    const reference: Reference = {
      source: 'upload',
      file,
      name: file.name,
      durationSeconds: null,
    };
    onChange({ ...state, reference });
  };

  const startRecording = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const media = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      media.ondataavailable = (event) => chunks.push(event.data);
      media.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: media.mimeType || 'audio/webm' });
        // WebM/Opus out of the browser; the gateway transcodes it. The
        // operator never learns that happened.
        onChange({
          ...state,
          reference: {
            source: 'record',
            file: new File([blob], 'recording.webm', { type: blob.type }),
            name: 'recording.webm',
            durationSeconds: null,
          },
        });
        setRecording(false);
      };
      recorder.current = media;
      media.start();
      setRecording(true);
    } catch {
      setFileProblem('The microphone is unavailable. Uploading a file still works.');
      setRecording(false);
    }
  };

  const selectVoice = (voice: Voice): void => {
    // Both halves, together. Selection cannot leave the pair half-filled.
    onChange({
      ...state,
      reference: {
        source: 'library',
        voiceId: voice.id,
        name: voice.name,
        durationSeconds: voice.durationSeconds,
      },
      refText: voice.transcript,
      direction:
        state.mode === 'direction' && !state.direction
          ? (voice.defaultDirection ?? '')
          : state.direction,
    });
  };

  return (
    <section className="panel" aria-label="Voice mode">
      <p className="caption caption--ink">Voice mode</p>
      <div className="tabs" role="group" aria-label="Voice mode">
        {MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className="tab"
            aria-pressed={state.mode === mode}
            onClick={() => props.onModeChange(mode)}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>
      {/* One line, in place. The distinction between these three is the thing
          the demo exists to teach, so it does not live behind a help modal. */}
      <p className="caption" style={{ marginTop: 8 }}>{MODE_BLURB[state.mode]}</p>

      {needsReference(state.mode) && (
        <div className="panel--inset" style={{ marginTop: 16 }}>
          <p className="caption caption--ink">Reference voice — three peer options</p>

          <div className="row">
            <button type="button" className="chip" onClick={() => fileInput.current?.click()}>
              Upload a file
            </button>
            <button
              type="button"
              className="chip"
              disabled={!props.canRecord}
              onClick={recording ? () => recorder.current?.stop() : startRecording}
            >
              {recording ? 'Stop recording' : 'Record'}
            </button>
            <span className="muted">MP3 / M4A / WAV / FLAC / recording</span>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm"
            aria-label="Upload a reference file"
            style={{ display: 'none' }}
            onChange={(event) => acceptFile(event.target.files?.[0])}
          />
          {!props.canRecord && props.recordDisabledReason && (
            <p className="caption blocked" style={{ marginTop: 8 }}>
              {props.recordDisabledReason} Uploads of existing files still work.
            </p>
          )}
          {fileProblem && (
            <p className="caption blocked" role="status" style={{ marginTop: 8 }}>
              {fileProblem}
            </p>
          )}

          <p className="caption caption--ink" style={{ marginTop: 16 }}>
            Saved voices ({props.voices.length} in library)
          </p>
          {props.voices.length === 0 ? (
            <p className="caption">{EMPTY_LIBRARY_COPY}</p>
          ) : (
            <ul className="list">
              {props.voices.map((voice) => (
                <li
                  key={voice.id}
                  className="list__item"
                  aria-selected={state.reference?.voiceId === voice.id}
                >
                  <button
                    type="button"
                    className="chip"
                    disabled={!isSelectable(voice)}
                    onClick={() => selectVoice(voice)}
                  >
                    {voice.name}
                  </button>
                  {!isSelectable(voice) && (
                    <span className="caption blocked" style={{ marginLeft: 8 }}>
                      audio unavailable
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {state.reference && (
            <p className="caption caption--ink" style={{ marginTop: 16 }} role="status">
              {state.reference.name}
              {state.reference.durationSeconds !== null
                ? ` — ${state.reference.durationSeconds.toFixed(1)}s`
                : ''}{' '}
              accepted
            </p>
          )}

          {/* Revealed with the reference, never without it. */}
          <label className="field" style={{ marginTop: 8 }}>
            <p className="caption caption--ink">Reference transcript — must be exact</p>
            <input
              type="text"
              aria-label="Reference transcript"
              value={state.refText}
              onChange={(event) => onChange({ ...state, refText: event.target.value })}
            />
          </label>

          {state.mode === 'direction' && (
            <label className="field">
              <p className="caption caption--ink">Direction — how it should be delivered</p>
              <input
                type="text"
                aria-label="Direction"
                value={state.direction}
                onChange={(event) => onChange({ ...state, direction: event.target.value })}
              />
            </label>
          )}
        </div>
      )}

      {/* Present in all three modes: it is instruction-following strength
          everywhere, and it is the only thing separating clone from direction,
          which share one template and one request shape. */}
      <CfgControl
        control={props.cfgControl}
        value={state.cfgScale}
        label={CFG_LABEL[state.mode]}
        unmeasured={props.cfgUnmeasured}
        onChange={(cfgScale) => onChange({ ...state, cfgScale })}
      />
    </section>
  );
}
