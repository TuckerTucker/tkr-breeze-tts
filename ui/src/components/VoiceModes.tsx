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
import { ReferenceTrimmer } from './ReferenceTrimmer.js';
import {
  CFG_LABEL,
  MODE_BLURB,
  needsReference,
  type CfgControl as CfgControlShape,
  type ModeState,
  type ReferenceSource,
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
  /** Stage one upload or recording through normalisation and ASR. */
  readonly onStageReference: (
    file: File,
    source: Exclude<ReferenceSource, 'library'>,
  ) => Promise<void>;
  readonly referenceMaxSeconds: number;
  readonly referenceMaxMeasured: boolean;
  readonly referenceBranchLimits: {
    readonly noCfg: number;
    readonly singleCfg: number;
  } | null;
  readonly referenceTokenCeiling: number;
  readonly referenceAudioUrl: (id: string, start: number, end: number) => string;
  readonly asrRemedy: string | null;
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
  const [staging, setStaging] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stagedReference =
    state.reference?.source === 'upload' || state.reference?.source === 'record'
      ? state.reference
      : null;

  const acceptFile = async (
    file: File | undefined,
    source: Exclude<ReferenceSource, 'library'> = 'upload',
  ): Promise<void> => {
    if (!file) return;
    // Rejected at the point of drop, with the reason shown — not on submit.
    if (!file.type.startsWith('audio/') && !/\.(wav|mp3|m4a|ogg|flac|webm)$/i.test(file.name)) {
      setFileProblem(`“${file.name}” is ${file.type || 'not a recognised audio file'}.`);
      return;
    }
    setFileProblem(null);
    setStaging(true);
    try {
      await props.onStageReference(file, source);
    } catch (error) {
      setFileProblem(
        error instanceof Error
          ? error.message
          : 'The reference could not be prepared. The current reference is unchanged.',
      );
    } finally {
      setStaging(false);
    }
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
        void acceptFile(
          new File([blob], 'recording.webm', { type: blob.type }),
          'record',
        );
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
        transcript: voice.transcript,
      },
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
            disabled={staging}
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
            <button
              type="button"
              className="chip"
              disabled={staging}
              onClick={() => fileInput.current?.click()}
            >
              {staging ? 'Preparing reference…' : 'Upload a file'}
            </button>
            <button
              type="button"
              className="chip"
              disabled={!props.canRecord || staging}
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
            disabled={staging}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              void acceptFile(file);
            }}
          />
          {staging && (
            <p className="caption" role="status" style={{ marginTop: 8 }}>
              Normalising audio, drawing its waveform, and transcribing it…
            </p>
          )}
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
                  aria-selected={
                    state.reference?.source === 'library' &&
                    state.reference.voiceId === voice.id
                  }
                >
                  <button
                    type="button"
                    className="chip"
                    disabled={staging || !isSelectable(voice)}
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
              {` — ${state.reference.durationSeconds.toFixed(1)}s`} accepted
            </p>
          )}

          {stagedReference ? (
            <ReferenceTrimmer
              reference={stagedReference}
              maxSeconds={props.referenceMaxSeconds}
              maxMeasured={props.referenceMaxMeasured}
              cfgScale={state.cfgScale}
              branchLimits={props.referenceBranchLimits}
              tokenCeiling={props.referenceTokenCeiling}
              audioUrl={(start, end) =>
                props.referenceAudioUrl(stagedReference.referenceId, start, end)
              }
              asrRemedy={props.asrRemedy}
              onChange={(reference) =>
                onChange({
                  ...state,
                  reference: { ...reference, source: stagedReference.source },
                })
              }
            />
          ) : (
            <label className="field" style={{ marginTop: 8 }}>
              <p className="caption caption--ink">Reference transcript — must be exact</p>
              <input
                type="text"
                aria-label="Reference transcript"
                disabled={state.reference === null}
                readOnly={state.reference?.source === 'library'}
                value={state.reference?.transcript ?? ''}
              />
              {state.reference?.source === 'library' && (
                <span className="caption">Saved with this voice and sent as one pair.</span>
              )}
              {state.reference === null && (
                <span className="caption blocked">Choose or prepare a reference first.</span>
              )}
            </label>
          )}

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
