/**
 * Reference trimmer: one staged recording, one word-safe window, live limits.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReferenceTrimmer } from '../src/components/ReferenceTrimmer.js';
import type { StagedReferenceSelection } from '../src/state/reference.js';

const REFERENCE: StagedReferenceSelection = {
  referenceId: 'reference-1',
  name: 'narrator.wav',
  durationSeconds: 4,
  sampleRate: 24_000,
  peaks: [0.1, 0.5, 1, 0.4, 0.7, 0.2],
  words: [
    { word: 'One', start: 0, end: 1 },
    { word: 'two', start: 1.2, end: 2 },
    { word: 'three', start: 2.2, end: 3 },
    { word: '.', start: 3, end: 3.2 },
  ],
  language: 'en',
  start: 0,
  end: 3.2,
  transcript: 'One two three.',
  transcriptEdited: false,
};

interface HarnessProps {
  readonly initial?: StagedReferenceSelection;
  readonly maxSeconds?: number;
  readonly maxMeasured?: boolean;
  readonly tokenCeiling?: number;
  readonly asrRemedy?: string | null;
  readonly cfgScale?: number;
  readonly branchLimits?: { readonly noCfg: number; readonly singleCfg: number } | null;
}

function Harness(props: HarnessProps): JSX.Element {
  const [reference, setReference] = useState(props.initial ?? REFERENCE);
  return (
    <ReferenceTrimmer
      reference={reference}
      maxSeconds={props.maxSeconds ?? 2}
      maxMeasured={props.maxMeasured ?? true}
      cfgScale={props.cfgScale ?? 1}
      branchLimits={props.branchLimits === undefined
        ? { noCfg: 2, singleCfg: 4 }
        : props.branchLimits}
      tokenCeiling={props.tokenCeiling ?? 512}
      asrRemedy={props.asrRemedy}
      audioUrl={(start, end) =>
        `/api/reference/${reference.referenceId}/audio?start=${start}&end=${end}`
      }
      onChange={setReference}
    />
  );
}

let observedResize: ResizeObserverCallback | null;
let renderedWidth: number;

beforeEach(() => {
  renderedWidth = 400;
  observedResize = null;
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({
      bottom: 112,
      height: 112,
      left: 0,
      right: renderedWidth,
      top: 0,
      width: renderedWidth,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
    setTransform: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        observedResize = callback;
      }

      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('word-safe selection', () => {
  it('moves both edges as one selection when the waveform is dragged', () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByRole('img', { name: /Reference waveform/i }), {
      clientX: 235,
      pointerId: 1,
    });

    expect(screen.getByRole('slider', { name: 'Reference selection position' })).toHaveValue('1.2');
    expect(screen.getByLabelText('Selected reference times')).toHaveTextContent('1.20s–3.20s');
    expect(screen.getByLabelText('Reference transcript')).toHaveValue('two three.');
  });

  it('re-slices the transcript to the fully selected words exactly', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('slider', { name: 'Reference selection position' }), {
      target: { value: '1.35' },
    });

    expect(screen.getByRole('slider', { name: 'Reference selection position' })).toHaveValue('1.2');
    expect(screen.getByLabelText('Reference transcript')).toHaveValue('two three.');
  });

  it('keeps a hand edit through a later move and resumes tracking on Undo', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Reference transcript'), {
      target: { value: 'My exact correction' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'Reference selection position' }), {
      target: { value: '1.35' },
    });

    expect(screen.getByLabelText('Reference transcript')).toHaveValue('My exact correction');
    expect(screen.getByRole('status')).toHaveTextContent(/no longer follows the selected words/i);

    fireEvent.click(screen.getByRole('button', { name: /Undo hand edit/i }));
    expect(screen.getByLabelText('Reference transcript')).toHaveValue('two three.');
    expect(screen.queryByText(/no longer follows the selected words/i)).not.toBeInTheDocument();
  });

  it('serves playback from the selected-window URL', () => {
    render(<Harness />);
    const audio = screen.getByLabelText('Play selected reference window');
    expect(audio).toHaveAttribute(
      'src',
      '/api/reference/reference-1/audio?start=0&end=2',
    );

    fireEvent.change(screen.getByRole('slider', { name: 'Reference selection position' }), {
      target: { value: '1.35' },
    });
    expect(audio).toHaveAttribute(
      'src',
      '/api/reference/reference-1/audio?start=1.2&end=3.2',
    );
  });
});

describe('honest waveform rendering', () => {
  it('rebuilds the canvas backing width after a container resize', () => {
    render(<Harness />);
    const canvas = screen.getByRole('img', { name: /Reference waveform/i }) as HTMLCanvasElement;
    const density = Math.max(1, window.devicePixelRatio || 1);
    expect(canvas.width).toBe(Math.round(400 * density));

    renderedWidth = 560;
    observedResize?.([], {} as ResizeObserver);
    expect(canvas.width).toBe(Math.round(560 * density));
  });

  it('exposes one keyboard-operable selection control instead of two handles', () => {
    render(<Harness />);
    const selection = screen.getByRole('slider', { name: 'Reference selection position' });
    expect(selection).toBeEnabled();
    fireEvent.keyDown(selection, { key: 'ArrowRight' });
    expect(selection).toHaveValue('1.2');
    expect(screen.queryByRole('slider', { name: 'Reference start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Reference end' })).not.toBeInTheDocument();
  });
});

describe('preflight limits and recognition failures', () => {
  it('keeps the window inside its duration limit while still marking token overflow', () => {
    render(<Harness maxSeconds={2} tokenCeiling={1} />);
    expect(screen.getByLabelText('Reference duration limit')).not.toHaveClass('meter--over');
    expect(screen.getByLabelText('Reference transcript token limit')).toHaveClass('meter--over');
    expect(screen.getByLabelText('Reference duration limit')).toHaveTextContent('2.00s / 2.00s');
    expect(screen.getByLabelText('Reference transcript token limit')).toHaveTextContent('3 / 1');
  });

  it('names both measured CFG branches and the active one', () => {
    const { rerender } = render(
      <Harness
        maxSeconds={14.08}
        maxMeasured
        cfgScale={1}
        branchLimits={{ noCfg: 14.08, singleCfg: 28.16 }}
      />,
    );
    expect(screen.getByText(/CFG 1\.0: 14\.08s; CFG above 1\.0: 28\.16s/i)).toBeInTheDocument();
    expect(screen.getByText(/Current CFG 1\.0 uses 14\.08s/i)).toBeInTheDocument();

    rerender(<Harness maxSeconds={10} maxMeasured={false} branchLimits={null} />);
    expect(screen.getByText(/Conservative maximum.*unmeasured/i)).toBeInTheDocument();
  });

  it('keeps an empty transcript required and puts the ASR remedy beside it', () => {
    render(
      <Harness
        initial={{ ...REFERENCE, words: [], transcript: '' }}
        asrRemedy="Set ASR_BASE_URL and restart the gateway."
      />,
    );
    expect(screen.getByLabelText('Reference transcript')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Reference transcript')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(/exact reference transcript is required/i);
    expect(screen.getByRole('status')).toHaveTextContent(/Set ASR_BASE_URL/i);
  });

  it('renders neither toast nor confirmation dialog on any path', () => {
    const { container } = render(<Harness />);
    fireEvent.change(screen.getByLabelText('Reference transcript'), {
      target: { value: 'changed' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Undo hand edit/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.querySelector('.toast, [data-toast]')).toBeNull();
  });
});
