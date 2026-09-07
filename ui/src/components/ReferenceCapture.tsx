/** Shared upload/record/stage/trim surface for referenced voice intent. */

import { useEffect, useRef, useState, type JSX } from 'react';

import { ReferenceTrimmer } from './ReferenceTrimmer.js';
import type { StagedReferenceSelection } from '../state/reference.js';

/** One microphone track the component is obliged to stop. */
export interface CaptureTrack {
  stop(): void;
}

/** The only part of a `MediaStream` this component touches. */
export interface CaptureStream {
  getTracks(): readonly CaptureTrack[];
}

/**
 * The only part of a `MediaRecorder` this component touches.
 *
 * Declared structurally rather than as `MediaRecorder` so the recorder
 * lifecycle — the part that leaks a live microphone when it goes wrong — can be
 * driven in a test without a real capture device.
 */
export interface CaptureRecorder {
  readonly state: string;
  readonly mimeType: string;
  start(): void;
  stop(): void;
  ondataavailable: ((event: { readonly data: Blob }) => void) | null;
  onstop: (() => void) | null;
}

/**
 * The two hardware seams of the capture path.
 *
 * They are split rather than wrapped in a single `record()` helper because the
 * defect this injection exists to prove sits *between* them: a permission grant
 * that succeeds followed by a recorder construction that throws.
 */
export interface CaptureDevices {
  /** Ask for microphone permission and open a stream. */
  openMicrophone(): Promise<CaptureStream>;
  /** Build a recorder over an already-granted stream. */
  createRecorder(stream: CaptureStream): CaptureRecorder;
}

/**
 * The real browser capture seams.
 *
 * The casts are confined to this adapter: `MediaRecorder`'s event handlers are
 * typed against `BlobEvent`, which is deliberately not part of the narrow
 * surface above, and nothing else in the component needs to know that.
 */
const browserCapture: CaptureDevices = {
  async openMicrophone(): Promise<CaptureStream> {
    return navigator.mediaDevices.getUserMedia({ audio: true });
  },
  createRecorder(stream: CaptureStream): CaptureRecorder {
    return new MediaRecorder(stream as MediaStream) as unknown as CaptureRecorder;
  },
};

/** Props for staging one reference and moving its bounded selection. */
export interface ReferenceCaptureProps {
  readonly selection: StagedReferenceSelection | null;
  readonly onSelectionChange: (selection: StagedReferenceSelection) => void;
  readonly onStage: (
    file: File,
    source: 'upload' | 'record',
  ) => Promise<StagedReferenceSelection>;
  /**
   * Release a staged reference the draft no longer holds.
   *
   * Staged audio is expiring working material, not a durable voice, so the
   * gateway will collect it eventually; calling this returns the bytes at the
   * moment the operator stops wanting them instead of a day later. Optional
   * because a caller that does not own a gateway client can still render the
   * surface — the reference then simply waits out its expiry.
   */
  readonly onReleaseReference?: (referenceId: string) => void | Promise<unknown>;
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
  /** Capture seams. Defaults to the browser's; overridden in tests. */
  readonly devices?: CaptureDevices;
}

/**
 * Render reference intake once and keep audio/transcript selection inseparable.
 *
 * @param props - Intake services, constraints, and current staged selection.
 * @returns The progressive reference preparation surface.
 */
export function ReferenceCapture(props: ReferenceCaptureProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const capture = useRef<{ stream: CaptureStream; recorder: CaptureRecorder } | null>(null);
  const [recording, setRecording] = useState(false);
  const [staging, setStaging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Hand the microphone back and abandon whatever was being recorded.
   *
   * Handlers are detached before the tracks are stopped because ending every
   * track is itself enough to make a browser fire `onstop`: without this the
   * teardown path would stage an abandoned recording and set state on an
   * unmounted component.
   */
  const releaseMicrophone = (): void => {
    const active = capture.current;
    if (!active) return;
    capture.current = null;
    active.recorder.ondataavailable = null;
    active.recorder.onstop = null;
    try {
      if (active.recorder.state !== 'inactive') active.recorder.stop();
    } catch {
      // A recorder that refuses to stop must not keep the tracks alive.
    }
    stopTracks(active.stream);
  };

  // Unmount is the only teardown signal the component gets: switching creation
  // method, leaving the workspace, and closing the tab all arrive as one. The
  // closure reads refs only, so the first render's copy stays correct.
  useEffect(() => releaseMicrophone, []);

  const releaseStaged = (referenceId: string): void => {
    const release = props.onReleaseReference;
    if (!release) return;
    void Promise.resolve(release(referenceId)).catch(() => {
      // The operator asked for this reference to be gone. One that already
      // expired is gone, and saying so beside the control would be noise.
    });
  };

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
    const superseded = props.selection?.referenceId ?? null;
    try {
      const staged = await props.onStage(file, source);
      props.onSelectionChange(staged);
      // Only once the replacement exists: a failed stage leaves the operator
      // with the selection they already had, which must still be playable.
      if (superseded && superseded !== staged.referenceId) releaseStaged(superseded);
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
    const devices = props.devices ?? browserCapture;
    let stream: CaptureStream;
    try {
      stream = await devices.openMicrophone();
    } catch {
      setProblem('The microphone is unavailable. Uploading an existing file still works.');
      return;
    }
    try {
      const recorder = devices.createRecorder(stream);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => {
        capture.current = null;
        stopTracks(stream);
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        void accept(new File([blob], 'recording.webm', { type: blob.type }), 'record');
        setRecording(false);
      };
      capture.current = { stream, recorder };
      recorder.start();
      setRecording(true);
    } catch {
      // Permission was granted and the recorder still failed. The stream is
      // live and nothing else holds it, so it is released here rather than
      // left running behind a message about a microphone being unavailable.
      stopTracks(stream);
      capture.current = null;
      setRecording(false);
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
          onClick={recording ? () => capture.current?.recorder.stop() : startRecording}
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

/** Stop every track, tolerating one that is already ended. */
function stopTracks(stream: CaptureStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // One track that will not stop must not strand the rest.
    }
  }
}
