/**
 * Voice modes: per-mode fields, three peer reference options, the CFG control.
 */

import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';

import { VoiceModes } from '../src/components/VoiceModes.js';
import {
  DEFAULT_CFG_CONTROL,
  INITIAL_MODE,
  cfgControlFrom,
  instructionFor,
  modeBlocker,
  needsReference,
  switchMode,
  type CfgControl,
  type ModeState,
} from '../src/state/mode.js';
import type { Voice } from '../src/state/voices.js';

const VOICES: Voice[] = [
  {
    id: 'v1',
    name: 'Narrator — calm',
    createdAt: 2,
    transcript: 'It is good to hear your voice again.',
    defaultDirection: null,
    origin: { kind: 'designed', instruction: 'A warm, thoughtful young woman' },
    durationSeconds: 12,
    sampleRate: 24000,
    available: true,
  },
  {
    id: 'v2',
    name: 'Missing audio',
    createdAt: 1,
    transcript: 'gone',
    defaultDirection: null,
    origin: { kind: 'cloned' },
    durationSeconds: 3,
    sampleRate: 24000,
    available: false,
  },
];

function Harness(props: {
  initial?: Partial<ModeState>;
  control?: CfgControl;
  canRecord?: boolean;
  voices?: Voice[];
}): JSX.Element {
  const [state, setState] = useState<ModeState>({ ...INITIAL_MODE, ...props.initial });
  return (
    <VoiceModes
      state={state}
      onChange={setState}
      onModeChange={(mode) => setState(switchMode(state, mode))}
      cfgControl={props.control ?? DEFAULT_CFG_CONTROL}
      cfgUnmeasured
      voices={props.voices ?? VOICES}
      canRecord={props.canRecord ?? true}
      recordDisabledReason={
        props.canRecord === false ? 'ffmpeg is not installed.' : null
      }
    />
  );
}

describe('each mode renders exactly its own field set', () => {
  it('shows only the instruction in Design', () => {
    render(<Harness />);
    expect(screen.queryByLabelText('Reference transcript')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Direction')).not.toBeInTheDocument();
    expect(screen.getByText(/Describe a voice in words/i)).toBeInTheDocument();
  });

  it('shows reference and transcript in Clone, but no delivery instruction', () => {
    render(<Harness initial={{ mode: 'clone' }} />);
    expect(screen.getByLabelText('Reference transcript')).toBeInTheDocument();
    expect(screen.queryByLabelText('Direction')).not.toBeInTheDocument();
  });

  it('shows both the reference and a delivery instruction in Direction', () => {
    render(<Harness initial={{ mode: 'direction' }} />);
    expect(screen.getByLabelText('Reference transcript')).toBeInTheDocument();
    expect(screen.getByLabelText('Direction')).toBeInTheDocument();
  });

  it('carries one line of in-place explanation per mode', () => {
    render(<Harness initial={{ mode: 'direction' }} />);
    expect(screen.getByText(/steer how it delivers/i)).toBeInTheDocument();
    // No help modal anywhere: the distinction is the thing being taught.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('reference and transcript appear together, never one alone', () => {
  it('reveals both fields at once when the mode needs a reference', () => {
    render(<Harness initial={{ mode: 'clone' }} />);
    expect(screen.getByLabelText('Upload a reference file')).toBeInTheDocument();
    expect(screen.getByLabelText('Reference transcript')).toBeInTheDocument();
  });

  it('blocks generation naming the missing half', () => {
    expect(modeBlocker({ ...INITIAL_MODE, mode: 'clone' })).toMatch(/reference voice and its exact transcript/i);
    expect(
      modeBlocker({
        ...INITIAL_MODE,
        mode: 'clone',
        refText: 'words',
      }),
    ).toMatch(/Add the reference recording/i);
    expect(
      modeBlocker({
        ...INITIAL_MODE,
        mode: 'clone',
        reference: { source: 'upload', name: 'a.wav', durationSeconds: null },
      }),
    ).toMatch(/Add the exact transcript/i);
  });

  it('does not block Design at all', () => {
    expect(modeBlocker(INITIAL_MODE)).toBeNull();
    expect(needsReference('design')).toBe(false);
  });

  it('asks Direction for its delivery note', () => {
    expect(
      modeBlocker({
        ...INITIAL_MODE,
        mode: 'direction',
        reference: { source: 'upload', name: 'a.wav', durationSeconds: null },
        refText: 'words',
      }),
    ).toMatch(/how the line should be delivered/i);
  });
});

describe('upload and capture are peers, and the library is a third', () => {
  it('offers all three in Clone', () => {
    render(<Harness initial={{ mode: 'clone' }} />);
    expect(screen.getByRole('button', { name: 'Upload a file' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Narrator — calm' })).toBeInTheDocument();
  });

  it('leaves upload working when capture is unavailable', () => {
    // Upload was never the fallback for a missing microphone.
    render(<Harness initial={{ mode: 'clone' }} canRecord={false} />);
    expect(screen.getByRole('button', { name: 'Record' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upload a file' })).toBeEnabled();
    expect(screen.getByText(/ffmpeg is not installed/i)).toBeInTheDocument();
    expect(screen.getByText(/Uploads of existing files still work/i)).toBeInTheDocument();
  });

  it('rejects a non-audio file at the point of drop, naming the type', () => {
    render(<Harness initial={{ mode: 'clone' }} />);
    const input = screen.getByLabelText('Upload a reference file');
    fireEvent.change(input, {
      target: { files: [new File(['#!/bin/sh'], 'script.sh', { type: 'text/x-shellscript' })] },
    });
    expect(screen.getByRole('status').textContent).toMatch(/script\.sh/);
  });

  it('shows an accepted file by name', () => {
    render(<Harness initial={{ mode: 'clone' }} />);
    fireEvent.change(screen.getByLabelText('Upload a reference file'), {
      target: { files: [new File(['RIFF'], 'narrator.wav', { type: 'audio/wav' })] },
    });
    expect(screen.getByText(/narrator\.wav/)).toBeInTheDocument();
  });

  it('fills reference and transcript together from a saved voice', () => {
    render(<Harness initial={{ mode: 'clone' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Narrator — calm' }));
    expect((screen.getByLabelText('Reference transcript') as HTMLInputElement).value).toBe(
      'It is good to hear your voice again.',
    );
  });

  it('makes a voice whose audio is missing unselectable, with the reason', () => {
    render(<Harness initial={{ mode: 'clone' }} />);
    expect(screen.getByRole('button', { name: 'Missing audio' })).toBeDisabled();
    expect(screen.getAllByText(/audio unavailable/i).length).toBeGreaterThan(0);
  });

  it('explains an empty library rather than hiding it', () => {
    render(<Harness initial={{ mode: 'clone' }} voices={[]} />);
    expect(screen.getByText(/saving a clip is how voices get here/i)).toBeInTheDocument();
  });
});

describe('the CFG control is present in all three modes', () => {
  it.each(['design', 'clone', 'direction'] as const)('appears in %s', (mode) => {
    render(<Harness initial={{ mode }} />);
    expect(screen.getByRole('group', { name: 'CFG scale' })).toBeInTheDocument();
  });

  it('is labelled for what it does in each mode', () => {
    const { unmount } = render(<Harness initial={{ mode: 'design' }} />);
    expect(screen.getByText(/Instruction strength$/)).toBeInTheDocument();
    unmount();

    render(<Harness initial={{ mode: 'direction' }} />);
    // It is the only thing separating clone from direction, which share one
    // template and one request shape.
    expect(screen.getByText(/keeps the reference voice, 4\.0 follows the direction/i)).toBeInTheDocument();
  });

  it('renders presets when no finding has been recorded', () => {
    render(<Harness initial={{ mode: 'clone' }} />);
    expect(screen.getByRole('button', { name: '1.0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4.0' })).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByText(/has not run against this deployment/i)).toBeInTheDocument();
  });

  it('renders a slider only when the finding says one is viable', () => {
    render(
      <Harness
        initial={{ mode: 'clone' }}
        control={{ kind: 'slider', min: 1, max: 4, step: 0.5, default: 1 }}
      />,
    );
    expect(screen.getByRole('slider', { name: 'CFG scale' })).toBeInTheDocument();
  });
});

describe('the control shape follows the recorded finding', () => {
  it('falls back to presets when there is no finding', () => {
    expect(cfgControlFrom(null)).toEqual(DEFAULT_CFG_CONTROL);
    expect(cfgControlFrom({})).toEqual(DEFAULT_CFG_CONTROL);
    expect(cfgControlFrom({ cfgControl: { kind: 'nonsense' } })).toEqual(DEFAULT_CFG_CONTROL);
  });

  it('reads a presets finding', () => {
    expect(
      cfgControlFrom({ cfgControl: { kind: 'presets', values: [1.0, 4.0], default: 1.0 } }),
    ).toEqual({ kind: 'presets', values: [1, 4], default: 1 });
  });

  it('reads a slider finding', () => {
    expect(
      cfgControlFrom({ cfgControl: { kind: 'slider', min: 1, max: 4, step: 0.5, default: 1 } }),
    ).toEqual({ kind: 'slider', min: 1, max: 4, step: 0.5, default: 1 });
  });
});

describe('switching modes', () => {
  it('preserves the reference between Clone and Direction', () => {
    const state: ModeState = {
      ...INITIAL_MODE,
      mode: 'clone',
      reference: { source: 'library', voiceId: 'v1', name: 'Narrator', durationSeconds: 12 },
      refText: 'exact words',
    };
    // It is the same reference either way.
    const directed = switchMode(state, 'direction');
    expect(directed.reference?.voiceId).toBe('v1');
    expect(directed.refText).toBe('exact words');
  });

  it('drops a reference on the way to Design, which cannot send one', () => {
    const state: ModeState = {
      ...INITIAL_MODE,
      mode: 'clone',
      reference: { source: 'upload', name: 'a.wav', durationSeconds: null },
      refText: 'words',
    };
    expect(switchMode(state, 'design').reference).toBeNull();
  });

  it('never touches the console text, which is not a property of the mode', () => {
    render(<Harness initial={{ mode: 'clone', refText: 'kept' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Direction' }));
    expect((screen.getByLabelText('Reference transcript') as HTMLInputElement).value).toBe(
      'kept',
    );
  });
});

describe('the instruction actually sent', () => {
  it('is the delivery note in Direction', () => {
    expect(
      instructionFor(
        { ...INITIAL_MODE, mode: 'direction', direction: 'urgent and clipped' },
        'a warm reader',
      ),
    ).toBe('urgent and clipped');
  });

  it('is the console instruction everywhere else', () => {
    expect(instructionFor({ ...INITIAL_MODE, mode: 'clone' }, 'a warm reader')).toBe(
      'a warm reader',
    );
  });
});
