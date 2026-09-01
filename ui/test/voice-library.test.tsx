/**
 * The voice library: origin visible, undo not confirmation, empty explains.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { SaveAsVoice, VoiceLibrary } from '../src/components/VoiceLibrary.js';
import { suggestName } from '../src/state/name.js';
import {
  EMPTY_LIBRARY_COPY,
  applyDelete,
  applyUndo,
  isSelectable,
  originLine,
  referenceFromVoice,
  type Voice,
} from '../src/state/voices.js';

const VOICES: Voice[] = [
  {
    id: 'v1',
    name: 'Narrator — calm',
    createdAt: 3,
    transcript: 'It is good to hear your voice again.',
    defaultDirection: null,
    origin: { kind: 'designed', instruction: 'A warm, thoughtful young woman' },
    durationSeconds: 12,
    sampleRate: 24000,
    available: true,
  },
  {
    id: 'v2',
    name: 'Sam — recorded',
    createdAt: 2,
    transcript: 'This is the exact transcript.',
    defaultDirection: 'urgent and clipped',
    origin: { kind: 'cloned', sourceFilename: 'sam.wav' },
    durationSeconds: 8,
    sampleRate: 24000,
    available: true,
  },
  {
    id: 'v3',
    name: 'Lost audio',
    createdAt: 1,
    transcript: 'gone',
    defaultDirection: null,
    origin: { kind: 'cloned' },
    durationSeconds: 4,
    sampleRate: 24000,
    available: false,
  },
];

function renderLibrary(overrides: Partial<Parameters<typeof VoiceLibrary>[0]> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onUndo: vi.fn(),
  };
  render(
    <VoiceLibrary
      voices={VOICES}
      selectedId={null}
      pendingUndo={null}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe('each entry shows what it came from', () => {
  it('distinguishes designed from cloned', () => {
    expect(originLine(VOICES[0]!)).toBe('DESIGNED / A WARM, THOUGHTFUL YOUNG WOMAN');
    expect(originLine(VOICES[1]!)).toBe('CLONED / FROM SAM.WAV');
  });

  it('renders origin and default direction on the row', () => {
    renderLibrary();
    expect(screen.getByText(/CLONED \/ FROM SAM.WAV \/ URGENT AND CLIPPED/)).toBeInTheDocument();
  });

  it('degrades gracefully when a designed voice has no instruction', () => {
    expect(originLine({ ...VOICES[0]!, origin: { kind: 'designed' } })).toBe('DESIGNED');
  });
});

describe('selection fills both halves of the required pair', () => {
  it('returns the reference and the transcript together', () => {
    expect(referenceFromVoice(VOICES[0]!)).toEqual({
      voiceId: 'v1',
      refText: 'It is good to hear your voice again.',
    });
  });

  it('makes an unavailable voice unselectable, with the reason', () => {
    renderLibrary();
    expect(screen.getByRole('button', { name: 'Lost audio' })).toBeDisabled();
    expect(screen.getByText(/save it again from a clip/i)).toBeInTheDocument();
    expect(isSelectable(VOICES[2]!)).toBe(false);
  });

  it('selects an available voice', () => {
    const handlers = renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Narrator — calm' }));
    expect(handlers.onSelect).toHaveBeenCalledWith(VOICES[0]);
  });
});

describe('an empty library explains itself instead of hiding', () => {
  it('says how voices get there', () => {
    renderLibrary({ voices: [] });
    expect(screen.getByText(EMPTY_LIBRARY_COPY)).toBeInTheDocument();
  });
});

describe('delete is immediate with an undo, never a dialog', () => {
  it('shows no confirmation', () => {
    const handlers = renderLibrary();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    // A dialog would shift responsibility for a decision the system can
    // simply reverse.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(handlers.onDelete).toHaveBeenCalledWith(VOICES[0]);
  });

  it('removes the voice immediately and keeps what is needed to undo', () => {
    const applied = applyDelete(VOICES, 'v1', 1_000);
    expect(applied.voices.map((voice) => voice.id)).toEqual(['v2', 'v3']);
    expect(applied.undo?.voice.id).toBe('v1');
    expect(applied.undo?.expiresAt).toBe(31_000);
  });

  it('restores the voice in creation order', () => {
    const applied = applyDelete(VOICES, 'v2', 0);
    const restored = applyUndo(applied.voices, applied.undo!.voice);
    expect(restored.map((voice) => voice.id)).toEqual(['v1', 'v2', 'v3']);
  });

  it('offers the undo in place', () => {
    const handlers = renderLibrary({
      pendingUndo: { voice: VOICES[0]!, expiresAt: Date.now() + 30_000 },
    });
    expect(screen.getByRole('status').textContent).toMatch(/Deleted “Narrator — calm”/);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(handlers.onUndo).toHaveBeenCalled();
  });
});

describe('renaming happens in place', () => {
  it('edits the name inline and commits on Enter', () => {
    const handlers = renderLibrary();
    fireEvent.click(screen.getAllByRole('button', { name: 'Rename' })[0]!);
    const input = screen.getByLabelText('Rename Narrator — calm');
    fireEvent.change(input, { target: { value: 'Calm narrator' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onRename).toHaveBeenCalledWith(VOICES[0], 'Calm narrator');
  });
});

describe('save-as-voice pre-fills a name and stays editable', () => {
  it('suggests from the instruction that produced the clip', () => {
    expect(suggestName('A warm, thoughtful young woman, calm delivery.')).toBe('Warm');
    expect(suggestName('crisp light quick reader voice here')).toBe('Crisp light quick reader voice');
    expect(suggestName(undefined)).toBe('New voice');
    expect(suggestName('   ')).toBe('New voice');
  });

  it('renders the suggestion as an editable field', () => {
    const onSave = vi.fn();
    render(<SaveAsVoice suggestedName="Warm" onSave={onSave} disabledReason={null} />);
    const input = screen.getByLabelText('Voice name') as HTMLInputElement;
    expect(input.value).toBe('Warm');
    fireEvent.change(input, { target: { value: 'Warm narrator' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as voice' }));
    expect(onSave).toHaveBeenCalledWith('Warm narrator');
  });

  it('disables the action with the reason when the clip is gone', () => {
    render(
      <SaveAsVoice
        suggestedName="Warm"
        onSave={vi.fn()}
        disabledReason="That clip is no longer cached."
      />,
    );
    expect(screen.getByRole('button', { name: 'Save as voice' })).toBeDisabled();
    expect(screen.getByText('That clip is no longer cached.')).toBeInTheDocument();
  });
});
