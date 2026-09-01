/**
 * Clip history: settings visible, replay free, promote fills the pair.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { History } from '../src/components/History.js';
import {
  clipFilename,
  formatDuration,
  promoteToReference,
  restoreFromClip,
  settingsLine,
  type Clip,
} from '../src/state/history.js';

const CLIPS: Clip[] = [
  {
    id: 'c2',
    createdAt: 2,
    bytes: 96_000,
    sampleRate: 24000,
    durationSeconds: 2,
    ttfaMs: 41,
    transport: 'streaming',
    request: {
      text: 'Welcome aboard, traveller.',
      instruction: 'A warm, thoughtful young woman, calm delivery.',
      mode: 'design',
      cfgScale: 1,
      seed: 17,
    },
  },
  {
    id: 'c1',
    createdAt: 1,
    bytes: 48_000,
    sampleRate: 24000,
    durationSeconds: 1,
    ttfaMs: 38,
    transport: 'streaming',
    request: {
      text: 'It is good to hear your voice again.',
      instruction: 'A warm, thoughtful young woman, calm delivery.',
      mode: 'clone',
      cfgScale: 4,
      seed: 42,
      refText: 'the exact transcript',
      voiceId: 'v1',
      voiceName: 'Narrator — calm',
    },
  },
];

function renderHistory(overrides: Partial<Parameters<typeof History>[0]> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onReplay: vi.fn(),
    onLoadIntoConsole: vi.fn(),
    onPromoteToReference: vi.fn(),
    onSaveAsVoice: vi.fn(),
  };
  render(
    <History
      clips={CLIPS}
      selectedId="c2"
      clipUrl={(id) => `/api/clips/${id}`}
      readOnlyReason={null}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe('every generation appears with its settings', () => {
  it('shows mode, cfg, seed and first-audio time without opening anything', () => {
    renderHistory();
    expect(screen.getByText(/DESIGN \/ CFG 1 \/ SEED 17 \/ 41MS/)).toBeInTheDocument();
    expect(screen.getByText(/CLONE \/ CFG 4 \/ SEED 42 \/ NARRATOR — CALM \/ 38MS/)).toBeInTheDocument();
  });

  it('builds the settings line from the request that produced the clip', () => {
    expect(settingsLine(CLIPS[1]!)).toContain('SEED 42');
    expect(settingsLine({ ...CLIPS[0]!, ttfaMs: null })).not.toMatch(/MS$/);
  });

  it('explains an empty history rather than showing nothing', () => {
    renderHistory({ clips: [] });
    expect(screen.getByText(/replay for free, even while the GPU is asleep/i)).toBeInTheDocument();
  });

  it('renders read-only with the reason when the cache is unreachable', () => {
    renderHistory({ readOnlyReason: 'The gateway is unreachable — history is read-only.' });
    expect(screen.getByRole('status').textContent).toMatch(/read-only/);
    // It does not disappear.
    expect(screen.getByText(/Welcome aboard/)).toBeInTheDocument();
  });
});

describe('replay costs nothing and reaches no GPU', () => {
  it('replays from the gateway cache route', () => {
    const handlers = renderHistory();
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(handlers.onReplay).toHaveBeenCalledWith(CLIPS[0]);
  });

  it('offers a save that goes through the cache route, framed as WAV at read', () => {
    renderHistory();
    const link = screen.getByRole('link', { name: 'Save WAV' });
    expect(link).toHaveAttribute('href', '/api/clips/c2');
    expect(link).toHaveAttribute('download');
  });

  it('names a saved file from the text that produced it', () => {
    expect(clipFilename('Welcome aboard, traveller.')).toBe('welcome-aboard-traveller.wav');
    expect(clipFilename('   ')).toBe('clip.wav');
  });

  it('does not reset the console when a clip is played', () => {
    // Replay must not destroy the work in progress that prompted the
    // comparison.
    const handlers = renderHistory();
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(handlers.onLoadIntoConsole).not.toHaveBeenCalled();
  });
});

describe('loading a clip back into the console', () => {
  it('restores every field of the original request, seed included', () => {
    const restore = restoreFromClip(CLIPS[1]!);
    expect(restore).toEqual({
      text: 'It is good to hear your voice again.',
      instruction: 'A warm, thoughtful young woman, calm delivery.',
      cfgScale: 4,
      seed: 42,
      mode: 'clone',
      voiceId: 'v1',
      refText: 'the exact transcript',
    });
  });

  it('is an explicit action, never automatic', () => {
    const handlers = renderHistory();
    fireEvent.click(screen.getByRole('button', { name: 'Load into console' }));
    expect(handlers.onLoadIntoConsole).toHaveBeenCalledWith(CLIPS[0]);
  });
});

describe('promote to reference', () => {
  it('switches to Clone and fills ref_text from the originating text', () => {
    // The model has no saved-voice primitive, so promoting a clip is how a
    // created voice actually persists.
    const promotion = promoteToReference(CLIPS[0]!);
    expect(promotion.mode).toBe('clone');
    expect(promotion.clipId).toBe('c2');
    expect(promotion.refText).toBe('Welcome aboard, traveller.');
  });

  it('never leaves the operator in a mode that cannot send a reference', () => {
    for (const clip of CLIPS) {
      expect(promoteToReference(clip).mode).toBe('clone');
    }
  });

  it('is offered on the selected clip', () => {
    const handlers = renderHistory();
    fireEvent.click(screen.getByRole('button', { name: 'Use as voice →' }));
    expect(handlers.onPromoteToReference).toHaveBeenCalledWith(CLIPS[0]);
  });

  it('offers saving to the library as a separate action', () => {
    const handlers = renderHistory();
    fireEvent.click(screen.getByRole('button', { name: 'Save to library' }));
    expect(handlers.onSaveAsVoice).toHaveBeenCalledWith(CLIPS[0]);
  });
});

describe('formatting', () => {
  it('renders duration as minutes and tenths', () => {
    expect(formatDuration(2)).toBe('0:02.0');
    expect(formatDuration(75.5)).toBe('1:15.5');
  });
});
