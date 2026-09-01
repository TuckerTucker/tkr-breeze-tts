/** Pure waveform reduction, word-boundary slicing, and measured limits. */

import { describe, expect, it } from 'vitest';

import {
  parseReferenceCeiling,
  parseWavPcm,
  peaksFrom,
  referenceSecondsFor,
  sliceTranscript,
  type PcmFormat,
  type TimedWord,
} from '../src/reference-slice.js';
import { frameWav } from '../src/transport.js';

const MONO: PcmFormat = {
  sampleRate: 24_000,
  channels: 1,
  bytesPerSample: 2,
  format: 's16le',
};

const pcm16 = (...samples: number[]): Buffer => {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
};

describe('waveform peaks', () => {
  it('takes the largest absolute sample in each bucket', () => {
    const peaks = peaksFrom(
      pcm16(0, 8_192, -16_384, 1_000, 2_000, -24_576, 0, 3_000),
      MONO,
      2,
    );
    expect(peaks).toEqual([0.5, 0.75]);
  });

  it('includes every channel rather than reading interleaved stereo as mono', () => {
    const stereo: PcmFormat = { ...MONO, channels: 2 };
    expect(peaksFrom(pcm16(0, 32_767, 1_000, 0), stereo, 1)[0]).toBeCloseTo(1, 4);
  });

  it('returns the requested shape for an empty payload', () => {
    expect(peaksFrom(Buffer.alloc(0), MONO, 3)).toEqual([0, 0, 0]);
    expect(peaksFrom(pcm16(32_767), MONO, 2)).toEqual([
      0,
      32_767 / 32_768,
    ]);
  });

  it('rejects a partial frame and an invalid bucket count', () => {
    expect(() => peaksFrom(Buffer.alloc(1), MONO, 1)).toThrow(/whole number/);
    expect(() => peaksFrom(Buffer.alloc(2), MONO, 0)).toThrow(/positive integer/);
  });
});

describe('WAV parsing', () => {
  it('reads the actual sample rate and PCM instead of assuming them', () => {
    const pcm = pcm16(1, 2, 3, 4);
    const wav = frameWav(pcm, {
      sampleRate: 16_000,
      channels: 1,
      bytesPerSample: 2,
      format: 's16le',
    });
    const parsed = parseWavPcm(wav);
    expect(parsed.format.sampleRate).toBe(16_000);
    expect(parsed.pcm.equals(pcm)).toBe(true);
    expect(parsed.durationSeconds).toBe(4 / 16_000);
  });

  it('walks chunks, so metadata before data does not break intake', () => {
    const pcm = pcm16(10, 20);
    const canonical = frameWav(pcm, {
      sampleRate: 24_000,
      channels: 1,
      bytesPerSample: 2,
      format: 's16le',
    });
    const junk = Buffer.alloc(12);
    junk.write('JUNK', 0, 'ascii');
    junk.writeUInt32LE(4, 4);
    const withMetadata = Buffer.concat([
      canonical.subarray(0, 36),
      junk,
      canonical.subarray(36),
    ]);
    withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
    expect(parseWavPcm(withMetadata).pcm.equals(pcm)).toBe(true);
  });
});

describe('timed transcript slicing', () => {
  const words: TimedWord[] = [
    { word: 'Hello', start: 0.1, end: 0.5 },
    { word: ' world', start: 0.6, end: 1.0 },
    { word: ' again', start: 1.2, end: 1.6 },
  ];

  it('snaps both handles and returns only fully contained words', () => {
    const sliced = sliceTranscript(words, 0.15, 1.05);
    expect(sliced.start).toBe(0.1);
    expect(sliced.end).toBe(1.0);
    expect(sliced.transcript).toBe('Hello world');
    expect(sliced.words.map((word) => word.word.trim())).toEqual(['Hello', 'world']);
    expect(
      sliced.words.every(
        (word) => word.start >= sliced.start && word.end <= sliced.end,
      ),
    ).toBe(true);
  });

  it('selects one whole word when independently nearest handles cross in a gap', () => {
    const sliced = sliceTranscript(words, 1.05, 1.1);
    expect(sliced.start).toBeLessThan(sliced.end);
    expect(sliced.words).toHaveLength(1);
    expect(sliced.words[0]!.start).toBeGreaterThanOrEqual(sliced.start);
    expect(sliced.words[0]!.end).toBeLessThanOrEqual(sliced.end);
  });

  it('preserves an exact window when recognition is unavailable', () => {
    expect(sliceTranscript([], 0.25, 0.75)).toEqual({
      start: 0.25,
      end: 0.75,
      transcript: '',
      words: [],
    });
  });

  it('adds spaces for timestamp APIs that return bare Latin words', () => {
    const bare = words.map((word) => ({ ...word, word: word.word.trim() }));
    expect(sliceTranscript(bare, 0, 2).transcript).toBe('Hello world again');
  });
});

describe('reference ceiling finding', () => {
  const finding = {
    max_reference_seconds: 14.08,
    ceiling_by_branch_mode: { no_cfg: 14.08, single_cfg: 28.16 },
  };

  it('selects the measured branch-specific ceiling', () => {
    const parsed = parseReferenceCeiling(finding)!;
    expect(referenceSecondsFor(parsed, 1)).toBe(14.08);
    expect(referenceSecondsFor(parsed, 4)).toBe(28.16);
  });

  it('does not turn malformed or absent measurements into an invented limit', () => {
    expect(parseReferenceCeiling(null)).toBeNull();
    expect(parseReferenceCeiling({ ...finding, max_reference_seconds: null })).toBeNull();
  });
});
