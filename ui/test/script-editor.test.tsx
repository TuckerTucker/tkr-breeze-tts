/**
 * The script editor: one edit costs one row, drift is shown not fixed.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ScriptEditor } from '../src/components/ScriptEditor.js';
import {
  CUE_STATE_LABEL,
  cueBlocker,
  driftLabel,
  editCue,
  formatTarget,
  progressOf,
  targetSeconds,
  type Cue,
  type Script,
} from '../src/state/script.js';
import { MAX_TOKENS } from '../src/state/draft.js';
import type { Voice } from '../src/state/voices.js';

const VOICES: Voice[] = [
  {
    id: 'v1',
    name: 'Narrator — calm',
    createdAt: 1,
    transcript: 'words',
    defaultDirection: null,
    origin: { kind: 'designed' },
    durationSeconds: 12,
    sampleRate: 24000,
    available: true,
  },
];

const cue = (overrides: Partial<Cue> = {}): Cue => ({
  id: 'cue-1',
  index: 0,
  text: 'It is good to hear your voice again.',
  voiceId: 'v1',
  voiceName: 'Narrator — calm',
  cfgScale: 1,
  seed: 42,
  targetStart: 0,
  targetEnd: 3.4,
  state: 'done',
  clipId: 'cue-abc',
  actualSeconds: 3.4,
  driftSeconds: 0,
  problem: null,
  ...overrides,
});

const script = (cues: Cue[]): Script => ({
  id: 's1',
  name: 'rescue-scene.vtt',
  source: 'vtt',
  cues,
  problems: [],
});

describe('a dropped file becomes an editable cue list', () => {
  it('offers a drop target before anything is imported', () => {
    render(
      <ScriptEditor
        script={null}
        voices={VOICES}
        running={false}
        exportUrls={null}
        onImport={vi.fn()}
        onEditCue={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByText(/Drop a WebVTT or plain-text file/i)).toBeInTheDocument();
    expect(screen.getByText(/no invented timings/i)).toBeInTheDocument();
  });

  it('imports a chosen file', async () => {
    const onImport = vi.fn();
    render(
      <ScriptEditor
        script={null}
        voices={VOICES}
        running={false}
        exportUrls={null}
        onImport={onImport}
        onEditCue={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    const file = new File(['WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHi.\n'], 'a.vtt', {
      type: 'text/vtt',
    });
    fireEvent.change(screen.getByLabelText('Import a script file'), {
      target: { files: [file] },
    });
    await vi.waitFor(() => expect(onImport).toHaveBeenCalled());
    expect(onImport.mock.calls[0]![1]).toBe('a.vtt');
  });

  it('surfaces a malformed cue as something needing attention, not a silent drop', () => {
    render(
      <ScriptEditor
        script={{
          ...script([cue()]),
          problems: [{ block: 2, reason: 'unreadable timestamp', raw: 'x' }],
        }}
        voices={VOICES}
        running={false}
        exportUrls={null}
        onImport={vi.fn()}
        onEditCue={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 block\(s\) could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/Block 3: unreadable timestamp/)).toBeInTheDocument();
  });
});

describe('row state is visible in place for every row', () => {
  it('renders each cue with its text, voice, target, actual, drift and state', () => {
    render(
      <ScriptEditor
        script={script([
          cue(),
          cue({ id: 'cue-2', index: 1, state: 'queued', actualSeconds: null, driftSeconds: null }),
        ])}
        voices={VOICES}
        running={false}
        exportUrls={null}
        onImport={vi.fn()}
        onEditCue={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByText('DONE')).toBeInTheDocument();
    expect(screen.getByText('QUEUED')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });

  it('labels every state', () => {
    expect(CUE_STATE_LABEL.stale).toBe('STALE / EDITED');
    expect(CUE_STATE_LABEL.unrunnable).toBe('NEEDS ATTENTION');
  });

  it('shows whole-script progress', () => {
    render(
      <ScriptEditor
        script={script([cue(), cue({ id: 'c2', index: 1, state: 'stale' })])}
        voices={VOICES}
        running={false}
        exportUrls={null}
        onImport={vi.fn()}
        onEditCue={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByRole('status', { name: 'Script progress' }).textContent).toMatch(
      /1 of 2 done/,
    );
  });

  it('counts states for the header', () => {
    const progress = progressOf(
      script([cue(), cue({ id: 'c2', state: 'stale' }), cue({ id: 'c3', state: 'unrunnable' })]),
    );
    expect(progress).toEqual({ total: 3, done: 1, stale: 1, cached: 1, failed: 1 });
  });
});

describe('editing one row marks only that row stale', () => {
  it('leaves every other row’s audio intact', () => {
    const before = script([cue(), cue({ id: 'cue-2', index: 1 })]);
    const after = editCue(before, 'cue-1', { text: 'Changed.' });

    expect(after.cues[0]!.state).toBe('stale');
    expect(after.cues[0]!.actualSeconds).toBeNull();
    // Correcting a line costs one GPU request instead of forty.
    expect(after.cues[1]!.state).toBe('done');
    expect(after.cues[1]!.actualSeconds).toBe(3.4);
  });

  it('reports a text edit through the callback', () => {
    const onEditCue = vi.fn();
    render(
      <ScriptEditor
        script={script([cue()])}
        voices={VOICES}
        running={false}
        exportUrls={null}
        onImport={vi.fn()}
        onEditCue={onEditCue}
        onRun={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Cue 1 text'), { target: { value: 'New line.' } });
    expect(onEditCue).toHaveBeenCalledWith('cue-1', { text: 'New line.' });
  });

  it('assigns a voice per row', () => {
    const onEditCue = vi.fn();
    render(
      <ScriptEditor
        script={script([cue({ voiceId: null, voiceName: null })])}
        voices={VOICES}
        running={false}
        exportUrls={null}
        onImport={vi.fn()}
        onEditCue={onEditCue}
        onRun={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Cue 1 voice'), { target: { value: 'v1' } });
    expect(onEditCue).toHaveBeenCalledWith('cue-1', {
      voiceId: 'v1',
      voiceName: 'Narrator — calm',
    });
  });
});

describe('a row whose voice was deleted is unrunnable with the reason', () => {
  it('names the missing voice', () => {
    expect(cueBlocker(cue(), new Set())).toMatch(/Narrator — calm.*no longer in the library/);
    expect(cueBlocker(cue(), new Set(['v1']))).toBeNull();
  });

  it('flags a row past the token ceiling while typing, not after dispatch', () => {
    const long = cue({ text: 'x'.repeat((MAX_TOKENS + 20) * 4) });
    expect(cueBlocker(long, new Set(['v1']))).toMatch(/past the 256-token ceiling/);
  });

  it('shows the reason on the row', () => {
    render(
      <ScriptEditor
        script={script([cue()])}
        voices={[]}
        running={false}
        exportUrls={null}
        onImport={vi.fn()}
        onEditCue={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByRole('status', { name: 'Cue 1 problem' }).textContent).toMatch(
      /no longer in the library/,
    );
  });
});

describe('drift is shown as target, actual and difference', () => {
  it('renders a signed difference', () => {
    expect(driftLabel(cue({ actualSeconds: 4.1, driftSeconds: 0.7 }))).toBe('+0.7s');
    expect(driftLabel(cue({ actualSeconds: 2.8, driftSeconds: -0.6 }))).toBe('-0.6s');
  });

  it('shows nothing when the cue is untimed or on target', () => {
    expect(driftLabel(cue({ driftSeconds: null }))).toBe('—');
    expect(driftLabel(cue({ driftSeconds: 0.01 }))).toBe('—');
  });

  it('offers reroll, shorten or accept — and no stretch', () => {
    render(
      <ScriptEditor
        script={script([cue({ actualSeconds: 4.1, driftSeconds: 0.7 })])}
        voices={VOICES}
        running={false}
        exportUrls={null}
        onImport={vi.fn()}
        onEditCue={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByText('DRIFTED')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reroll' })).toBeInTheDocument();
    expect(screen.getByText(/shorten the line, or accept/i)).toBeInTheDocument();
    // The audio is never stretched to fit, so no such control exists.
    expect(screen.queryByRole('button', { name: /stretch|fit/i })).not.toBeInTheDocument();
  });

  it('computes the target slot length', () => {
    expect(targetSeconds(cue())).toBeCloseTo(3.4, 6);
    expect(targetSeconds(cue({ targetStart: null, targetEnd: null }))).toBeNull();
    expect(formatTarget(null)).toBe('—');
    expect(formatTarget(65.5)).toBe('1:05.5');
  });
});

describe('export uses real generated timings', () => {
  it('offers both exports once a script exists', () => {
    render(
      <ScriptEditor
        script={script([cue()])}
        voices={VOICES}
        running={false}
        exportUrls={{ vtt: '/api/scripts/s1/export.vtt', wav: '/api/scripts/s1/export.wav' }}
        onImport={vi.fn()}
        onEditCue={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByRole('link', { name: 'Export VTT' })).toHaveAttribute(
      'href',
      '/api/scripts/s1/export.vtt',
    );
    expect(screen.getByText(/never the imported targets/i)).toBeInTheDocument();
  });

  it('disables the run control while a run is in flight', () => {
    render(
      <ScriptEditor
        script={script([cue()])}
        voices={VOICES}
        running
        exportUrls={null}
        onImport={vi.fn()}
        onEditCue={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Running/ })).toBeDisabled();
  });
});
