/** Scripts workspace generation preview: one player, cache-only playback. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ScriptsWorkspace, type ScriptsWorkspaceProps } from '../src/components/ScriptsWorkspace.js';
import {
  INITIAL_SCRIPT_DEFAULTS,
  type Cue,
  type Script,
  type ScriptSummary,
} from '../src/state/script.js';

function cue(index: number, state: Cue['state'] = 'done'): Cue {
  return {
    id: `cue-${index + 1}`,
    index,
    text: `Generated line ${index + 1}.`,
    voiceId: null,
    voiceName: null,
    instruction: INITIAL_SCRIPT_DEFAULTS.instruction,
    cfgScale: 1,
    seed: 42,
    targetStart: null,
    targetEnd: null,
    state,
    clipId: `clip-${index + 1}`,
    actualSeconds: state === 'done' ? 1.5 : null,
    driftSeconds: null,
    problem: null,
  };
}

function script(cues: Cue[]): Script {
  return {
    id: 'script-1',
    name: 'Preview scene',
    source: 'text',
    defaults: INITIAL_SCRIPT_DEFAULTS,
    cues,
    problems: [],
  };
}

function summary(current: Script): ScriptSummary {
  return {
    id: current.id,
    name: current.name,
    source: current.source,
    createdAt: 1,
    updatedAt: 1,
    cueCount: current.cues.length,
    doneCount: current.cues.filter((item) => item.state === 'done').length,
    failedCount: current.cues.filter((item) => item.state === 'failed').length,
    defaults: INITIAL_SCRIPT_DEFAULTS,
  };
}

function props(current: Script): ScriptsWorkspaceProps {
  return {
    summaries: [summary(current)],
    script: current,
    voices: [],
    running: false,
    loading: false,
    problem: null,
    onOpen: vi.fn(),
    onImport: vi.fn(),
    onCreate: vi.fn(),
    onUpdateDefaults: vi.fn(),
    onEditCue: vi.fn(),
    onRun: vi.fn(),
    onExport: vi.fn(),
    clipUrl: (id) => `/api/clips/${id}`,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('script generation preview', () => {
  it('explains automatic chunking beside the imported document', () => {
    const current: Script = {
      ...script([cue(0, 'queued'), cue(1, 'queued'), cue(2, 'queued')]),
      chunking: {
        version: 2,
        sourceCueCount: 1,
        splitSourceCueCount: 1,
        outputCueCount: 3,
        addedCueCount: 2,
        tokenCeiling: 256,
      },
    };
    render(<ScriptsWorkspace {...props(current)} />);

    expect(screen.getByRole('status', { name: 'Script import details' })).toHaveTextContent(
      '1 long line was split. Prepared 3 generation cues from 1 source line',
    );
    expect(screen.getByRole('status', { name: 'Script import details' })).toHaveTextContent(
      '256-token request ceiling',
    );
  });

  it('loads the first ready cue into one shared cache-backed player', () => {
    const current = script([cue(0), cue(1), cue(2, 'stale')]);
    render(<ScriptsWorkspace {...props(current)} />);

    const player = screen.getByLabelText('Preview generated audio for cue 1');
    expect(player).toHaveAttribute('src', '/api/clips/clip-1');
    expect(screen.getAllByLabelText(/Preview generated audio for cue/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Preview cue 3' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview cue 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('switches and starts playback from a ready cue without running synthesis', async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined);
    const load = vi
      .spyOn(HTMLMediaElement.prototype, 'load')
      .mockImplementation(() => {});
    const current = script([cue(0), cue(1)]);
    const handlers = props(current);
    render(<ScriptsWorkspace {...handlers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview cue 2' }));

    const player = await screen.findByLabelText('Preview generated audio for cue 2');
    expect(player).toHaveAttribute('src', '/api/clips/clip-2');
    expect(load).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
    expect(handlers.onRun).not.toHaveBeenCalled();

    fireEvent.playing(player);
    expect(screen.getByRole('button', { name: 'Pause cue 2' })).toHaveTextContent(
      'Pause preview',
    );
    expect(
      within(screen.getByRole('region', { name: 'Generated cue preview' })).getByRole(
        'status',
      ),
    ).toHaveTextContent('Playing cue 2');
  });

  it('keeps playback failures beside the player with a recovery path', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      new Error('Audio output is unavailable.'),
    );
    const current = script([cue(0)]);
    render(<ScriptsWorkspace {...props(current)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview cue 1' }));

    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Generated cue preview' })).getByRole(
          'status',
        ),
      ).toHaveTextContent(/Audio output is unavailable.*remains available in the player/),
    );
  });

  it('explains when no cue has generated audio yet', () => {
    const current = script([cue(0, 'stale'), cue(1, 'queued')]);
    render(<ScriptsWorkspace {...props(current)} />);

    expect(screen.getByText('No generated audio yet.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Generated cue preview' })).getByRole(
        'status',
      ),
    ).toHaveTextContent('Run a cue to make its preview available.');
    expect(screen.queryByLabelText(/Preview generated audio/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview cue 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview cue 2' })).toBeDisabled();
  });
});
