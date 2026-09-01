/**
 * Pure staged-reference selection rules.
 */

import { describe, expect, it } from 'vitest';

import {
  CONSERVATIVE_REFERENCE_MAX_SECONDS,
  createInitialReferenceSelection,
  editReferenceTranscript,
  moveReferenceWindow,
  nudgeReferenceWindow,
  referenceCeilingFor,
  referenceSelectionBlocker,
  referenceSelectionMetrics,
  restoreReferenceTranscript,
  sliceReferenceTranscript,
  type StagedReferenceResource,
  type StagedReferenceSelection,
  type TimedWord,
} from '../src/state/reference.js';

const WORDS: readonly TimedWord[] = [
  { word: 'The', start: 0.2, end: 0.6 },
  { word: 'quick', start: 0.7, end: 1.1 },
  { word: 'brown', start: 1.2, end: 1.6 },
  { word: 'fox', start: 1.7, end: 2 },
  { word: '.', start: 2, end: 2.1 },
];

function resource(overrides: Partial<StagedReferenceResource> = {}): StagedReferenceResource {
  return {
    id: 'reference-1',
    createdAt: 1_700_000_000_000,
    bytes: 96_000,
    durationSeconds: 3,
    sampleRate: 24_000,
    format: 's16le',
    channels: 1,
    peaks: [0, 0.5, 1, 0.25],
    words: WORDS,
    transcript: 'The quick brown fox.',
    language: 'en',
    ...overrides,
  };
}

function selection(
  overrides: Partial<StagedReferenceSelection> = {},
): StagedReferenceSelection {
  return {
    referenceId: 'reference-1',
    name: 'clean-reference.wav',
    durationSeconds: 3,
    sampleRate: 24_000,
    peaks: [0, 0.5, 1, 0.25],
    words: WORDS,
    language: 'en',
    start: 0.2,
    end: 2.1,
    transcript: 'The quick brown fox.',
    transcriptEdited: false,
    ...overrides,
  };
}

describe('reference transcript slicing', () => {
  it('names only complete words and reconstructs punctuation exactly', () => {
    expect(sliceReferenceTranscript(WORDS, 0.7, 2.1)).toBe('quick brown fox.');
    expect(sliceReferenceTranscript(WORDS, 0.8, 2.1)).toBe('brown fox.');
  });

  it('preserves ASR token spacing, including CJK output', () => {
    expect(
      sliceReferenceTranscript(
        [
          { word: ' Hello', start: 0, end: 0.4 },
          { word: ' world', start: 0.4, end: 0.8 },
          { word: '!', start: 0.8, end: 0.9 },
        ],
        0,
        0.9,
      ),
    ).toBe('Hello world!');
    expect(
      sliceReferenceTranscript(
        [
          { word: '你', start: 0, end: 0.2 },
          { word: '好', start: 0.2, end: 0.4 },
          { word: '！', start: 0.4, end: 0.5 },
        ],
        0,
        0.5,
      ),
    ).toBe('你好！');
  });
});

describe('reference selection lifecycle', () => {
  it('starts with a word-safe window no longer than the supplied ceiling', () => {
    const initial = createInitialReferenceSelection(
      resource({ durationSeconds: 30 }),
      'clean-reference.wav',
      1.5,
    );

    expect(initial.referenceId).toBe('reference-1');
    expect(initial.name).toBe('clean-reference.wav');
    expect(initial.start).toBe(0.2);
    expect(initial.end).toBe(1.6);
    expect(initial.end - initial.start).toBeLessThanOrEqual(1.5);
    expect(initial.transcript).toBe('The quick brown');
    expect(initial.transcriptEdited).toBe(false);
  });

  it('moves one duration-bounded window and settles it on complete words', () => {
    const moved = moveReferenceWindow(selection(), 0.82, 1.5);
    expect(moved.start).toBe(0.7);
    expect(moved.end).toBe(2.1);
    expect(moved.end - moved.start).toBeLessThanOrEqual(1.5);
    expect(moved.transcript).toBe('quick brown fox.');
  });

  it('moves to the previous or next word window as one keyboard step', () => {
    const current = moveReferenceWindow(selection(), 0.7, 1.5);
    const later = nudgeReferenceWindow(current, 1, 1.5);
    expect(later.start).toBe(1.2);
    expect(later.end).toBe(2.1);
    expect(nudgeReferenceWindow(later, -1, 1.5).start).toBe(0.7);
  });

  it('keeps a hand edit through later drags until undo resumes tracking', () => {
    const edited = editReferenceTranscript(selection(), 'The precise spoken words.');
    const moved = moveReferenceWindow(edited, 1.08, 1.5);

    expect(moved.start).toBe(1.2);
    expect(moved.transcript).toBe('The precise spoken words.');
    expect(moved.transcriptEdited).toBe(true);

    const restored = restoreReferenceTranscript(moved);
    expect(restored.transcript).toBe('brown fox.');
    expect(restored.transcriptEdited).toBe(false);
  });

  it('still creates and moves a trimmer selection when ASR produced no words', () => {
    const initial = createInitialReferenceSelection(
      resource({ words: [], transcript: '', durationSeconds: 20 }),
      'untranscribed.wav',
      10,
    );
    expect(initial).toMatchObject({ start: 0, end: 10, transcript: '' });

    const moved = moveReferenceWindow(initial, 2.25, 10);
    expect(moved.start).toBe(2.25);
    expect(moved.end).toBe(12.25);
    expect(moved.transcript).toBe('');
  });
});

describe('reference preflight ceilings', () => {
  it('selects the measured wall for the active branch configuration', () => {
    const finding = {
      referenceCeiling: {
        measured: true,
        maxReferenceSeconds: 14.08,
        ceilingByBranchMode: { noCfg: 14.08, singleCfg: 28.16 },
      },
    };
    expect(referenceCeilingFor(finding, 1)).toEqual({
      maxSeconds: 14.08,
      measured: true,
    });
    expect(referenceCeilingFor(finding, 4)).toEqual({
      maxSeconds: 28.16,
      measured: true,
    });
  });

  it('uses and labels the conservative wall when no usable finding exists', () => {
    expect(referenceCeilingFor(null, 1)).toEqual({
      maxSeconds: CONSERVATIVE_REFERENCE_MAX_SECONDS,
      measured: false,
    });
    expect(referenceCeilingFor({ referenceCeiling: { measured: false } }, 4)).toEqual({
      maxSeconds: CONSERVATIVE_REFERENCE_MAX_SECONDS,
      measured: false,
    });
  });

  it('measures both independent limits and returns blocking reasons', () => {
    const overDuration = selection({ start: 0, end: 2.1 });
    expect(referenceSelectionMetrics(overDuration, 2, 512)).toEqual({
      durationSeconds: 2.1,
      transcriptTokens: 5,
      durationExceeded: true,
      tokenCeilingExceeded: false,
    });
    expect(referenceSelectionBlocker(overDuration, 2, 512)).toMatch(
      /past the 2\.00s limit/i,
    );

    const overTokens = selection({ transcript: 'x'.repeat(41) });
    expect(referenceSelectionBlocker(overTokens, 10, 10)).toMatch(
      /past the 10-token limit/i,
    );
    expect(referenceSelectionBlocker(selection({ transcript: '' }), 10, 512)).toMatch(
      /exact transcript/i,
    );
    expect(referenceSelectionBlocker(selection(), 10, 512)).toBeNull();
  });
});
