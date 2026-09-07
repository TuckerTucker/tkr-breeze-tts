/**
 * Voices, as the operator actually meets it.
 *
 * This surface renders in the shipped build and had no suite of its own: the
 * 63 tests that once stood for it belonged to `VoiceLibrary`, a component with
 * no production importer, retired in slice 20. Everything asserted here is
 * reachable in the configuration the operator runs — Scripts dormant, so the
 * library offers "Use in Speak" and nothing else.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { VoiceWorkspace, type VoiceWorkspaceProps } from '../src/components/VoiceWorkspace.js';
import { DEFAULT_CFG_CONTROL } from '../src/state/mode.js';
import {
  INITIAL_CREATION_DRAFT,
  WORKSPACE_AVAILABILITY,
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

const LOST_AUDIO: Voice = {
  ...NARRATOR,
  id: 'voice-lost',
  name: 'Missing take',
  createdAt: 1,
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
    instruction: 'A late-night host, close and unhurried.',
    mode: 'design',
    cfgScale: 1,
    seed: 42,
  },
};

/**
 * Props for the shipped configuration.
 *
 * `scriptsAvailable` reads the real gate rather than a literal, so a test that
 * claims "no Use in Script" cannot keep passing after the capability wakes up.
 */
function props(overrides: Partial<VoiceWorkspaceProps> = {}): VoiceWorkspaceProps {
  return {
    voices: [NARRATOR],
    clips: [],
    draft: INITIAL_CREATION_DRAFT,
    onDraftChange: vi.fn(),
    cfgControl: DEFAULT_CFG_CONTROL,
    cfgUnmeasured: true,
    busy: false,
    problem: null,
    pendingUndo: null,
    onAudition: vi.fn(),
    onSave: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onUndo: vi.fn(),
    onUseInSpeak: vi.fn(),
    onUseInScript: vi.fn(),
    scriptsAvailable: WORKSPACE_AVAILABILITY.scripts,
    voiceAudioUrl: (id) => `/api/voices/${id}/audio`,
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

function cardFor(name: string): HTMLElement {
  return screen.getByRole('heading', { name, level: 4 }).closest('article') as HTMLElement;
}

describe('the voice library, in the shipped configuration', () => {
  it('carries a kept voice into Speak and offers no dormant destination', () => {
    const onUseInSpeak = vi.fn();
    render(<VoiceWorkspace {...props({ onUseInSpeak })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Use in Speak' }));

    expect(onUseInSpeak).toHaveBeenCalledWith(NARRATOR);
    // Scripts is gated dormant, so its destination must not be offered here.
    expect(screen.queryByRole('button', { name: 'Use in Script' })).not.toBeInTheDocument();
  });

  it('renames a voice in place, committing on Enter', () => {
    const onRename = vi.fn();
    render(<VoiceWorkspace {...props({ onRename })} />);

    fireEvent.click(within(cardFor('Visible narrator')).getByRole('button', { name: 'Rename' }));
    const field = screen.getByLabelText('Rename Visible narrator');
    expect(field).toHaveValue('Visible narrator');

    fireEvent.change(field, { target: { value: 'Evening narrator' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith(NARRATOR, 'Evening narrator');
    expect(screen.queryByLabelText('Rename Visible narrator')).not.toBeInTheDocument();
  });

  it('commits a rename the operator clicked away from rather than discarding it', () => {
    // Losing a typed name to a stray click is the kind of silent work loss the
    // library exists to avoid; blur has to mean the same thing Enter does.
    const onRename = vi.fn();
    render(<VoiceWorkspace {...props({ onRename })} />);

    fireEvent.click(within(cardFor('Visible narrator')).getByRole('button', { name: 'Rename' }));
    const field = screen.getByLabelText('Rename Visible narrator');
    fireEvent.change(field, { target: { value: 'Evening narrator' } });
    fireEvent.blur(field);

    expect(onRename).toHaveBeenCalledWith(NARRATOR, 'Evening narrator');
  });

  it('deletes without a confirmation dialog and offers undo instead', () => {
    const onDelete = vi.fn();
    const onUndo = vi.fn();
    const { rerender } = render(<VoiceWorkspace {...props({ onDelete, onUndo })} />);

    fireEvent.click(within(cardFor('Visible narrator')).getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(NARRATOR);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const undo = { voice: NARRATOR, expiresAt: 30_000 };
    rerender(<VoiceWorkspace {...props({ voices: [], onDelete, onUndo, pendingUndo: undo })} />);

    const strip = screen.getByRole('status');
    expect(strip).toHaveTextContent('Deleted “Visible narrator”.');
    fireEvent.click(within(strip).getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledWith(undo);
  });

  it('refuses to send a voice whose audio the gateway cannot find', () => {
    render(<VoiceWorkspace {...props({ voices: [NARRATOR, LOST_AUDIO] })} />);

    const lost = within(cardFor('Missing take'));
    expect(lost.getByRole('button', { name: 'Use in Speak' })).toBeDisabled();
    expect(lost.getByText(/Audio unavailable\. Save it again\./)).toBeInTheDocument();
    // Rename and Delete stay reachable: an unusable entry must still be fixable.
    expect(lost.getByRole('button', { name: 'Rename' })).toBeEnabled();
    expect(lost.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('names the empty library rather than showing an empty grid', () => {
    render(<VoiceWorkspace {...props({ voices: [] })} />);

    expect(screen.getByText('No voices kept yet')).toBeInTheDocument();
    expect(screen.getByText('Create your first voice')).toBeInTheDocument();
  });

  it('counts the library in words that match its size', () => {
    const { rerender } = render(<VoiceWorkspace {...props()} />);
    expect(screen.getByText('1 kept voice')).toBeInTheDocument();

    rerender(<VoiceWorkspace {...props({ voices: [NARRATOR, LOST_AUDIO] })} />);
    expect(screen.getByText('2 kept voices')).toBeInTheDocument();
  });
});

describe('creating a voice', () => {
  it('auditions the drafted description and reports it is ready to keep', () => {
    const onAudition = vi.fn();
    const { rerender } = render(<VoiceWorkspace {...props({ onAudition })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Audition voice' }));
    expect(onAudition).toHaveBeenCalledTimes(1);

    rerender(
      <VoiceWorkspace
        {...props({
          onAudition,
          draft: { ...INITIAL_CREATION_DRAFT, auditionClipId: 'clip-audition' },
        })}
      />,
    );
    expect(screen.getByText('Audition ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Audition again' })).toBeInTheDocument();
  });

  it('withholds Audition while there is no line to hear, or work already running', () => {
    const { rerender } = render(
      <VoiceWorkspace {...props({ draft: { ...INITIAL_CREATION_DRAFT, sampleText: '  ' } })} />,
    );
    expect(screen.getByRole('button', { name: 'Audition voice' })).toBeDisabled();

    rerender(<VoiceWorkspace {...props({ busy: true })} />);
    expect(screen.getByRole('button', { name: 'Audition voice' })).toBeDisabled();
  });

  it('keeps a voice only once something has actually been heard', () => {
    // "Keep voice" without an audition would save a clip that does not exist.
    const onSave = vi.fn();
    const { rerender } = render(<VoiceWorkspace {...props({ onSave })} />);
    expect(screen.getByRole('button', { name: 'Keep voice' })).toBeDisabled();

    rerender(
      <VoiceWorkspace
        {...props({
          onSave,
          draft: { ...INITIAL_CREATION_DRAFT, auditionClipId: 'clip-audition' },
        })}
      />,
    );
    const keep = screen.getByRole('button', { name: 'Keep voice' });
    expect(keep).toBeEnabled();
    fireEvent.click(keep);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('withholds Keep when the name has been cleared', () => {
    render(
      <VoiceWorkspace
        {...props({
          draft: {
            ...INITIAL_CREATION_DRAFT,
            auditionClipId: 'clip-audition',
            name: '   ',
          },
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Keep voice' })).toBeDisabled();
  });

  it('drops a stale audition whenever the draft that produced it changes', () => {
    // The audition clip is evidence for one exact draft. Keeping it across an
    // edit would let Keep save audio that no longer matches what is on screen.
    const onDraftChange = vi.fn();
    render(
      <VoiceWorkspace
        {...props({
          onDraftChange,
          draft: { ...INITIAL_CREATION_DRAFT, auditionClipId: 'clip-audition' },
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText('Voice description'), {
      target: { value: 'Close, unhurried, a little amused.' },
    });
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Close, unhurried, a little amused.',
        auditionClipId: null,
      }),
    );
  });

  it('keeps a chosen name while renaming the untouched default from the clip', () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(
      <VoiceWorkspace
        {...props({
          onDraftChange,
          clips: [CLIP],
          draft: { ...INITIAL_CREATION_DRAFT, method: 'from-clip' },
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText('Generated clip'), { target: { value: CLIP.id } });
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ sourceClipId: CLIP.id, name: 'Late-night host' }),
    );

    onDraftChange.mockClear();
    rerender(
      <VoiceWorkspace
        {...props({
          onDraftChange,
          clips: [CLIP],
          draft: { ...INITIAL_CREATION_DRAFT, method: 'from-clip', name: 'Chosen by hand' },
        })}
      />,
    );
    fireEvent.change(screen.getByLabelText('Generated clip'), { target: { value: CLIP.id } });
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ sourceClipId: CLIP.id, name: 'Chosen by hand' }),
    );
  });

  it('says an evicted source clip is gone rather than saving nothing', () => {
    render(
      <VoiceWorkspace
        {...props({
          clips: [],
          draft: {
            ...INITIAL_CREATION_DRAFT,
            method: 'from-clip',
            sourceClipId: 'clip-evicted',
          },
        })}
      />,
    );

    expect(screen.getByText(/That source clip was evicted/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep voice' })).toBeDisabled();
  });

  it('shows the failure beside the creator rather than as a toast', () => {
    render(<VoiceWorkspace {...props({ problem: 'That staged reference has expired.' })} />);

    expect(screen.getByText('That staged reference has expired.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers reference capture and the CFG dial only where they apply', () => {
    const { rerender } = render(<VoiceWorkspace {...props()} />);
    expect(screen.queryByLabelText('Upload reference audio')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'CFG scale' })).toBeInTheDocument();

    rerender(
      <VoiceWorkspace
        {...props({ draft: { ...INITIAL_CREATION_DRAFT, method: 'clone-audio' } })}
      />,
    );
    expect(screen.getByLabelText('Upload reference audio')).toBeInTheDocument();
    expect(screen.getByLabelText('Cloned voice default delivery')).toBeInTheDocument();

    // A promoted clip carries its own audio and settings, so neither a CFG dial
    // nor an audition applies to it.
    rerender(
      <VoiceWorkspace
        {...props({ draft: { ...INITIAL_CREATION_DRAFT, method: 'from-clip' } })}
      />,
    );
    expect(screen.queryByRole('group', { name: 'CFG scale' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Audition/ })).not.toBeInTheDocument();
  });
});

describe('the dormant Scripts destination', () => {
  it('dormant capability — Use in Script appears only when Scripts is gated on', () => {
    // Overrides the shipped gate deliberately: this asserts the dormant
    // capability is intact, not that the operator can reach it.
    const onUseInScript = vi.fn();
    render(<VoiceWorkspace {...props({ scriptsAvailable: true, onUseInScript })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Use in Script' }));
    expect(onUseInScript).toHaveBeenCalledWith(NARRATOR);
  });
});
