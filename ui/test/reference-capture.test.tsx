/**
 * Reference capture: intake validation, staging failures, and — the point of
 * this suite — deterministic release of the microphone and of staged audio the
 * draft no longer holds. A live capture device that outlives the operator's
 * interest is a privacy defect, so every teardown path is asserted here rather
 * than trusted to the one handler that used to carry it.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  ReferenceCapture,
  type CaptureDevices,
  type CaptureRecorder,
  type CaptureStream,
} from '../src/components/ReferenceCapture.js';
import type { StagedReferenceSelection } from '../src/state/reference.js';

function selection(id: string, name: string): StagedReferenceSelection {
  return {
    referenceId: id,
    name,
    durationSeconds: 4,
    sampleRate: 24_000,
    peaks: [0.1, 0.6, 0.3, 0.9],
    words: [
      { word: 'One', start: 0, end: 1 },
      { word: 'two', start: 1.2, end: 2 },
    ],
    language: 'en',
    start: 0,
    end: 2,
    transcript: 'One two',
    transcriptEdited: false,
  };
}

/** A microphone stream whose tracks record whether they were stopped. */
function stubStream(count = 2): { stream: CaptureStream; stops: () => number[] } {
  const tracks = Array.from({ length: count }, () => ({ stop: vi.fn() }));
  return {
    stream: { getTracks: () => tracks },
    stops: () => tracks.map((track) => track.stop.mock.calls.length),
  };
}

/** A recorder that mirrors the browser's state machine and nothing else. */
class StubRecorder implements CaptureRecorder {
  state = 'inactive';
  readonly mimeType = 'audio/webm';
  ondataavailable: ((event: { readonly data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly stopped = vi.fn();

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.stopped();
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['RIFF'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

interface HarnessProps {
  readonly initial?: StagedReferenceSelection | null;
  readonly onStage?: (file: File, source: 'upload' | 'record') => Promise<StagedReferenceSelection>;
  readonly onReleaseReference?: (referenceId: string) => void | Promise<unknown>;
  readonly devices?: CaptureDevices;
  readonly canRecord?: boolean;
}

function Harness(props: HarnessProps): JSX.Element {
  const [staged, setStaged] = useState<StagedReferenceSelection | null>(props.initial ?? null);
  return (
    <ReferenceCapture
      selection={staged}
      onSelectionChange={setStaged}
      onStage={props.onStage ?? (async () => selection('reference-new', 'recording.webm'))}
      onReleaseReference={props.onReleaseReference}
      devices={props.devices}
      canRecord={props.canRecord ?? true}
      recordDisabledReason={null}
      maxSeconds={10}
      maxMeasured
      cfgScale={1}
      branchLimits={{ noCfg: 14.08, singleCfg: 28.16 }}
      tokenCeiling={512}
      audioUrl={(id, start, end) => `/api/reference/${id}/audio?start=${start}&end=${end}`}
      asrRemedy={null}
    />
  );
}

const wav = (name = 'narrator.wav'): File =>
  new File(['RIFF'], name, { type: 'audio/wav' });

const upload = (file: File): void => {
  fireEvent.change(screen.getByLabelText('Upload reference audio'), {
    target: { files: [file] },
  });
};

describe('reference capture release', () => {
  it('stops every microphone track when the component unmounts mid-recording', async () => {
    const { stream, stops } = stubStream(3);
    const recorder = new StubRecorder();
    const onStage = vi.fn(async (_file: File, _source: 'upload' | 'record') =>
      selection('reference-new', 'recording.webm'));
    const view = render(
      <Harness
        onStage={onStage}
        devices={{ openMicrophone: async () => stream, createRecorder: () => recorder }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await screen.findByRole('button', { name: 'Stop recording' });
    expect(stops()).toEqual([0, 0, 0]);

    view.unmount();

    expect(stops()).toEqual([1, 1, 1]);
    expect(recorder.stopped).toHaveBeenCalledTimes(1);
    // An abandoned recording must not be staged: the operator left.
    expect(onStage).not.toHaveBeenCalled();
  });

  it('releases the granted stream when recorder construction throws', async () => {
    const { stream, stops } = stubStream();
    render(
      <Harness
        devices={{
          openMicrophone: async () => stream,
          createRecorder: () => {
            throw new Error('MediaRecorder is not supported');
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));

    expect(
      await screen.findByText(
        'The microphone is unavailable. Uploading an existing file still works.',
      ),
    ).toBeInTheDocument();
    expect(stops()).toEqual([1, 1]);
    // The surface must fall back to the peer path, not sit in a recording state.
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
    expect(screen.getByLabelText('Upload reference audio')).toBeEnabled();
  });

  it('reports a denied microphone in place and keeps upload available', async () => {
    render(
      <Harness
        devices={{
          openMicrophone: async () => {
            throw new Error('NotAllowedError');
          },
          createRecorder: () => new StubRecorder(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));

    expect(
      await screen.findByText(
        'The microphone is unavailable. Uploading an existing file still works.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Upload reference audio')).toBeEnabled();
  });

  it('stops the stream and stages the audio when the operator stops cleanly', async () => {
    const { stream, stops } = stubStream();
    const recorder = new StubRecorder();
    const onStage = vi.fn(async (_file: File, _source: 'upload' | 'record') =>
      selection('reference-new', 'recording.webm'));
    render(
      <Harness
        onStage={onStage}
        devices={{ openMicrophone: async () => stream, createRecorder: () => recorder }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));

    await waitFor(() => expect(onStage).toHaveBeenCalledTimes(1));
    expect(onStage.mock.calls[0]?.[1]).toBe('record');
    expect(stops()).toEqual([1, 1]);
    expect(await screen.findByRole('button', { name: 'Record' })).toBeInTheDocument();
  });

  it('releases the superseded reference when a new one is staged', async () => {
    const onReleaseReference = vi.fn();
    render(
      <Harness
        initial={selection('reference-old', 'first.wav')}
        onStage={async () => selection('reference-new', 'second.wav')}
        onReleaseReference={onReleaseReference}
      />,
    );

    upload(wav('second.wav'));

    await waitFor(() => expect(onReleaseReference).toHaveBeenCalledWith('reference-old'));
    expect(onReleaseReference).toHaveBeenCalledTimes(1);
  });

  it('keeps the staged reference when the component unmounts, because the draft still holds it', () => {
    const onReleaseReference = vi.fn();
    const view = render(
      <Harness initial={selection('reference-old', 'first.wav')} onReleaseReference={onReleaseReference} />,
    );

    view.unmount();

    expect(onReleaseReference).not.toHaveBeenCalled();
  });

  it('keeps the previous reference when staging its replacement fails', async () => {
    const onReleaseReference = vi.fn();
    render(
      <Harness
        initial={selection('reference-old', 'first.wav')}
        onStage={async () => {
          throw new Error('The reference could not be transcribed.');
        }}
        onReleaseReference={onReleaseReference}
      />,
    );

    upload(wav('second.wav'));

    expect(await screen.findByText('The reference could not be transcribed.')).toBeInTheDocument();
    expect(onReleaseReference).not.toHaveBeenCalled();
  });

  it('does not surface a release that fails, because the reference is gone either way', async () => {
    const onStage = vi.fn(async () => selection('reference-new', 'second.wav'));
    render(
      <Harness
        initial={selection('reference-old', 'first.wav')}
        onStage={onStage}
        onReleaseReference={async () => {
          throw new Error('no staged reference with id reference-old');
        }}
      />,
    );

    upload(wav('second.wav'));

    await waitFor(() => expect(onStage).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/no staged reference/)).not.toBeInTheDocument();
  });
});

describe('reference capture intake', () => {
  it('refuses a file that is neither audio by type nor by extension', async () => {
    const onStage = vi.fn(async () => selection('reference-new', 'x'));
    render(<Harness onStage={onStage} />);

    upload(new File(['#!/bin/sh'], 'script.sh', { type: 'text/x-shellscript' }));

    expect(
      await screen.findByText('“script.sh” is not a recognised audio file.'),
    ).toBeInTheDocument();
    expect(onStage).not.toHaveBeenCalled();
  });

  it('accepts an audio extension the browser did not type', async () => {
    const onStage = vi.fn(async (_file: File, _source: 'upload' | 'record') =>
      selection('reference-new', 'narrator.m4a'));
    render(<Harness onStage={onStage} />);

    upload(new File(['ftyp'], 'narrator.m4a', { type: '' }));

    await waitFor(() => expect(onStage).toHaveBeenCalledTimes(1));
    expect(onStage.mock.calls[0]?.[1]).toBe('upload');
  });

  it('reports a staging failure beside the control and leaves intake usable', async () => {
    render(
      <Harness
        onStage={async () => {
          throw new Error('The reference could not be transcribed.');
        }}
      />,
    );

    upload(wav());

    expect(await screen.findByText('The reference could not be transcribed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload audio' })).toBeEnabled();
  });
});
