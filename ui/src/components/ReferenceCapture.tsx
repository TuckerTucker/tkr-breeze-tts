/** Shared upload/record/stage/trim surface for referenced voice intent. */

import { useRef, useState, type JSX } from 'react';

import { ReferenceTrimmer } from './ReferenceTrimmer.js';
import type { StagedReferenceSelection } from '../state/reference.js';

/** Props for staging one reference and moving its bounded selection. */
export interface ReferenceCaptureProps {
  readonly selection: StagedReferenceSelection | null;
  readonly onSelectionChange: (selection: StagedReferenceSelection) => void;
  readonly onStage: (
    file: File,
    source: 'upload' | 'record',
  ) => Promise<StagedReferenceSelection>;
  readonly disabled?: boolean;
  readonly canRecord: boolean;
  readonly recordDisabledReason: string | null;
  readonly maxSeconds: number;
  readonly maxMeasured: boolean;
  readonly cfgScale: number;
  readonly branchLimits: { readonly noCfg: number; readonly singleCfg: number } | null;
  readonly tokenCeiling: number;
  readonly audioUrl: (id: string, start: number, end: number) => string;
  readonly asrRemedy: string | null;
}

/**
 * Render reference intake once and keep audio/transcript selection inseparable.
 *
 * @param props - Intake services, constraints, and current staged selection.
 * @returns The progressive reference preparation surface.
 */
export function ReferenceCapture(props: ReferenceCaptureProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [staging, setStaging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const accept = async (
    file: File | undefined,
    source: 'upload' | 'record' = 'upload',
  ): Promise<void> => {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !/\.(wav|mp3|m4a|ogg|flac|webm)$/i.test(file.name)) {
      setProblem(`“${file.name}” is not a recognised audio file.`);
      return;
    }
    setProblem(null);
    setStaging(true);
    try {
      props.onSelectionChange(await props.onStage(file, source));
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'The reference could not be prepared. The current selection is unchanged.',
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
        void accept(new File([blob], 'recording.webm', { type: blob.type }), 'record');
        setRecording(false);
      };
      recorder.current = media;
      media.start();
      setRecording(true);
    } catch {
      setProblem('The microphone is unavailable. Uploading an existing file still works.');
    }
  };

  return (
    <div className="reference-capture">
      <div className="row">
        <button
          type="button"
          className="chip"
          disabled={props.disabled || staging}
          onClick={() => input.current?.click()}
        >
          {staging ? 'Preparing reference…' : 'Upload audio'}
        </button>
        <button
          type="button"
          className="chip"
          disabled={props.disabled || staging || !props.canRecord}
          onClick={recording ? () => recorder.current?.stop() : startRecording}
        >
          {recording ? 'Stop recording' : 'Record'}
        </button>
        <span className="muted">WAV, MP3, M4A, FLAC, OGG, or WebM</span>
      </div>
      <input
        ref={input}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm"
        aria-label="Upload reference audio"
        hidden
        disabled={props.disabled || staging}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          void accept(file);
        }}
      />
      {staging && (
        <p className="caption" role="status">
          Normalising audio, calculating its waveform, and transcribing it…
        </p>
      )}
      {!props.canRecord && props.recordDisabledReason && (
        <p className="caption blocked">{props.recordDisabledReason}</p>
      )}
      {problem && <p className="caption blocked" role="status">{problem}</p>}

      {props.selection && (
        <ReferenceTrimmer
          reference={props.selection}
          maxSeconds={props.maxSeconds}
          maxMeasured={props.maxMeasured}
          cfgScale={props.cfgScale}
          branchLimits={props.branchLimits}
          tokenCeiling={props.tokenCeiling}
          audioUrl={(start, end) =>
            props.audioUrl(props.selection!.referenceId, start, end)
          }
          asrRemedy={props.asrRemedy}
          onChange={props.onSelectionChange}
        />
      )}
    </div>
  );
}
