/**
 * Speak, as the operator actually meets it.
 *
 * The shipped surface offers exactly one voice source — a kept voice — and it
 * had no suite of its own. `sourceAvailability` here is the real
 * `SPEAK_VOICE_SOURCE_AVAILABILITY` constant rather than a literal, so an
 * assertion that the described and staged sources are absent cannot keep
 * passing after they wake up. The one suite that opens those gates says so in
 * its name.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
  SpeakWorkspace,
  type SpeakWorkspaceProps,
} from '../src/components/SpeakWorkspace.js';
import {
  SPEAK_VOICE_SOURCE_AVAILABILITY,
  type SpeakDraft,
} from '../src/state/workspace.js';
import type { Clip } from '../src/state/history.js';
import type { Voice } from '../src/state/voices.js';

const NARRATOR: Voice = {
  id: 'voice-narrator',
  name: 'Visible narrator',
  createdAt: 2,
  transcript: 'This voice remains ready for Speak.',
  defaultDirection: 'Warm and clear.',
  origin: { kind: 'designed', instruction: 'Warm and clear.' },
  durationSeconds: 4.2,
  sampleRate: 24_000,
  available: true,
};

const HOST: Voice = {
  ...NARRATOR,
  id: 'voice-host',
  name: 'Late-night host',
  createdAt: 1,
  transcript: 'You are listening to the small hours.',
};

const LOST_AUDIO: Voice = {
  ...NARRATOR,
  id: 'voice-lost',
  name: 'Missing take',
  createdAt: 0,
  available: false,
};

const CLIP: Clip = {
  id: 'clip-recent',
  createdAt: 1,
  bytes: 48_000,
  sampleRate: 24_000,
  durationSeconds: 1,
  ttfaMs: 38,
  transport: 'streaming',
  request: {
    text: 'A line that was already generated.',
    instruction: 'Warm and clear.',
    mode: 'clone',
    cfgScale: 1,
    seed: 42,
    voiceId: NARRATOR.id,
    voiceName: NARRATOR.name,
  },
};

const SAVED_DRAFT: SpeakDraft = {
  text: 'Read this in the kept voice.',
  instruction: 'Warm and clear.',
  language: 'en',
  seed: 42,
  seedLocked: true,
  cfgScale: 1,
  voice: { kind: 'saved', voiceId: NARRATOR.id, voiceName: NARRATOR.name },
};

function props(overrides: Partial<SpeakWorkspaceProps> = {}): SpeakWorkspaceProps {
  return {
    draft: SAVED_DRAFT,
    onDraftChange: vi.fn(),
    voices: [NARRATOR, HOST],
    blockedReason: null,
    statusLine: 'Warm — expected 38ms to first audio.',
    onGenerate: vi.fn(),
    generating: false,
    clips: [],
    selectedClipId: null,
    onSelectClip: vi.fn(),
    onReplay: vi.fn(),
    onLoadVariation: vi.fn(),
    onCreateVoiceFromClip: vi.fn(),
    onSaveVoice: vi.fn(),
    clipUrl: (id) => `/api/clips/${id}`,
    historyReadOnlyReason: null,
    playbackReadout: null,
    sourceAvailability: SPEAK_VOICE_SOURCE_AVAILABILITY,
    onStage: async () => {
      throw new Error('no reference is staged in this test');
    },
    canRecord: true,
    recordDisabledReason: null,
    referenceMaxSeconds: 14.08,
    referenceMaxMeasured: true,
    referenceBranchLimits: { noCfg: 14.08, singleCfg: 28.16 },
    referenceTokenCeiling: 256,
    referenceAudioUrl: (id, start, end) => `/api/reference/${id}/audio?start=${start}&end=${end}`,
    asrRemedy: null,
    ...overrides,
  };
}

describe('Speak, in the shipped configuration', () => {
  it('offers kept voices only, with nothing else to choose between', () => {
    render(<SpeakWorkspace {...props()} />);

    expect(screen.queryByRole('group', { name: 'Speak voice source' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Describe' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Temporary reference' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Upload reference audio')).not.toBeInTheDocument();

    expect(screen.getByText('Choose one of your kept voices.')).toBeInTheDocument();
    expect(screen.getByLabelText('Saved voice')).toHaveValue(NARRATOR.id);
  });

  it('hides the diagnostic seed controls this surface does not carry', () => {
    render(<SpeakWorkspace {...props()} />);

    expect(screen.queryByLabelText('Seed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reroll' })).not.toBeInTheDocument();
  });

  it('carries both halves of a chosen voice into the draft, not just its id', () => {
    // A voice is reference audio plus its exact transcript; a selection that
    // moved only the id would be a nicer way to build the rejected request.
    const onDraftChange = vi.fn();
    render(<SpeakWorkspace {...props({ onDraftChange })} />);

    fireEvent.change(screen.getByLabelText('Saved voice'), { target: { value: HOST.id } });

    expect(onDraftChange).toHaveBeenCalledWith({
      ...SAVED_DRAFT,
      voice: { kind: 'saved', voiceId: HOST.id, voiceName: HOST.name },
    });
  });

  it('makes a voice whose audio is missing unselectable rather than failing later', () => {
    render(<SpeakWorkspace {...props({ voices: [NARRATOR, LOST_AUDIO] })} />);

    const missing = screen.getByRole('option', { name: /Missing take/ });
    expect(missing).toBeDisabled();
    expect(missing).toHaveTextContent('unavailable');
  });

  it('ignores a selection that names no voice at all', () => {
    // The placeholder option is reachable; taking it must not blank the draft.
    const onDraftChange = vi.fn();
    render(<SpeakWorkspace {...props({ onDraftChange })} />);

    fireEvent.change(screen.getByLabelText('Saved voice'), { target: { value: '' } });

    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it('says where voices come from when the library is empty', () => {
    render(<SpeakWorkspace {...props({ voices: [] })} />);

    expect(screen.getByText('Create or keep a voice in Voices first.')).toBeInTheDocument();
  });

  it('sends the visible line and delivery when nothing blocks it', () => {
    const onGenerate = vi.fn();
    render(<SpeakWorkspace {...props({ onGenerate })} />);

    expect(screen.getByLabelText('Text to speak')).toHaveValue(SAVED_DRAFT.text);
    expect(screen.getAllByLabelText('Instruction')).toHaveLength(1);
    expect(screen.getByLabelText('Instruction')).toHaveValue(SAVED_DRAFT.instruction);

    const generate = screen.getByRole('button', { name: /generate/i });
    expect(generate).toBeEnabled();
    expect(screen.getByRole('status', { name: 'Generate status' })).toHaveTextContent(
      'Warm — expected 38ms to first audio.',
    );

    fireEvent.click(generate);
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it('carries the reason Generate is off beside the control, never as a toast', () => {
    render(<SpeakWorkspace {...props({ blockedReason: 'Choose a saved voice.' })} />);

    expect(screen.getByRole('button', { name: /generate/i })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Generate status' })).toHaveTextContent(
      'Choose a saved voice.',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps recent clips beside the console and replays the selected one', () => {
    const onSelectClip = vi.fn();
    const onReplay = vi.fn();
    const { rerender } = render(
      <SpeakWorkspace {...props({ clips: [CLIP], onSelectClip, onReplay })} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /A line that was already generated/ }));
    expect(onSelectClip).toHaveBeenCalledWith(CLIP);

    rerender(
      <SpeakWorkspace
        {...props({ clips: [CLIP], selectedClipId: CLIP.id, onSelectClip, onReplay })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(onReplay).toHaveBeenCalledWith(CLIP);
  });

  it('renders history read-only rather than removing it when the cache is unreachable', () => {
    render(
      <SpeakWorkspace
        {...props({
          clips: [CLIP],
          historyReadOnlyReason: 'The gateway is unreachable — history is read-only.',
        })}
      />,
    );

    expect(screen.getByText(/history is read-only/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Clips this session' })).toBeInTheDocument();
  });

  it('shows the measured first-audio readout the app hands it', () => {
    render(
      <SpeakWorkspace
        {...props({ playbackReadout: <p aria-label="Measured latency">19ms to first audio</p> })}
      />,
    );

    expect(screen.getByLabelText('Measured latency')).toBeInTheDocument();
  });
});

describe('dormant Speak voice sources', () => {
  const ALL_SOURCES = { described: true, saved: true, staged: true } as const;

  it('dormant capability — the source picker appears only once its gates are opened', () => {
    // Overrides the shipped availability deliberately. This asserts the dormant
    // sources are intact, not that the operator can reach them.
    const onDraftChange = vi.fn();
    render(<SpeakWorkspace {...props({ sourceAvailability: ALL_SOURCES, onDraftChange })} />);

    const picker = screen.getByRole('group', { name: 'Speak voice source' });
    expect(picker).toBeInTheDocument();
    expect(screen.getByText('Choose an available voice source.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Describe' }));
    expect(onDraftChange).toHaveBeenCalledWith({ ...SAVED_DRAFT, voice: { kind: 'described' } });

    fireEvent.click(screen.getByRole('button', { name: 'Temporary reference' }));
    expect(onDraftChange).toHaveBeenCalledWith({
      ...SAVED_DRAFT,
      voice: { kind: 'staged', reference: null },
    });
  });

  it('dormant capability — a staged source renders reference capture when gated on', () => {
    render(
      <SpeakWorkspace
        {...props({
          sourceAvailability: ALL_SOURCES,
          draft: { ...SAVED_DRAFT, voice: { kind: 'staged', reference: null } },
        })}
      />,
    );

    expect(screen.getByLabelText('Upload reference audio')).toBeInTheDocument();
    expect(screen.queryByLabelText('Saved voice')).not.toBeInTheDocument();
  });
});
