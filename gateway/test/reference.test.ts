/**
 * Reference intake: detection, normalisation, the pair rule, and temp files.
 *
 * The fixtures are real audio produced by ffmpeg, not stubs. A container-
 * detection test against a made-up header would pass while the real thing
 * failed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FFMPEG_INSTALL_REMEDY,
  ReferenceError as RefError,
  checkFfmpeg,
  detectAudio,
  isConformingWav,
  normaliseReference,
  validateReferencePair,
} from '../src/reference.js';
import { readWavHeader } from '../src/transport.js';
import { makeAudioFixtures, type AudioFixtures } from './helpers.js';

let fixtures: AudioFixtures;
let workdir: string;

beforeAll(async () => {
  fixtures = await makeAudioFixtures();
  workdir = await mkdtemp(join(tmpdir(), 'breeze-ref-work-'));
});

afterAll(async () => {
  await fixtures.cleanup();
  await rm(workdir, { recursive: true, force: true });
});

describe('detection names what a file actually is', () => {
  it('identifies each container from its leading bytes', () => {
    expect(detectAudio(fixtures.wav).container).toBe('wav');
    expect(detectAudio(fixtures.webm).container).toBe('webm');
    expect(detectAudio(fixtures.mp3).container).toBe('mp3');
    expect(detectAudio(fixtures.m4a).container).toBe('mp4');
    expect(detectAudio(fixtures.flac).container).toBe('flac');
    expect(detectAudio(fixtures.ogg).container).toBe('ogg');
  });

  it('recognises a conforming WAV as forwardable', () => {
    expect(isConformingWav(fixtures.wav)).toBe(true);
    expect(detectAudio(fixtures.wav).conforming).toBe(true);
  });

  it('does not trust an extension over the bytes', () => {
    // A .wav carrying an MP3 payload is a WAV by name only, and forwarding it
    // would fail inside the vendor loader rather than here.
    expect(detectAudio(fixtures.mp3).conforming).toBe(false);
  });

  it('reports an unrecognised file rather than guessing', () => {
    const detected = detectAudio(Buffer.from('this is a text file, not audio'));
    expect(detected.container).toBe('unknown');
    expect(detected.label).toMatch(/not a recognised audio file/);
  });
});

describe('normalisation', () => {
  it('transcodes a browser WebM/Opus recording to WAV', async () => {
    const wav = await normaliseReference(fixtures.webm, { tmpRoot: workdir });
    const header = readWavHeader(wav);
    expect(header.sampleRate).toBe(24000);
    expect(header.channels).toBe(1);
    expect(header.bytesPerSample).toBe(2);
  });

  it.each([
    ['MP3', 'mp3'],
    ['M4A', 'm4a'],
    ['FLAC', 'flac'],
    ['OGG', 'ogg'],
  ] as const)('normalises %s rather than passing it through', async (_label, key) => {
    const source = fixtures[key];
    const wav = await normaliseReference(source, { tmpRoot: workdir });
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.equals(source)).toBe(false);
    expect(readWavHeader(wav).sampleRate).toBe(24000);
  });

  it('passes an already-conforming WAV through unmodified', async () => {
    const result = await normaliseReference(fixtures.wav, { tmpRoot: workdir });
    // Byte-identical: a needless re-encode is a generation loss for no gain.
    expect(result.equals(fixtures.wav)).toBe(true);
  });

  it('rejects a non-audio file with its detected type named, before transcode', async () => {
    await expect(
      normaliseReference(Buffer.from('#!/bin/sh\necho hello\n'), { tmpRoot: workdir }),
    ).rejects.toMatchObject({
      kind: 'unsupported-type',
      message: expect.stringContaining('not a recognised audio file'),
    });
  });

  it('rejects an empty upload before doing any work', async () => {
    await expect(normaliseReference(Buffer.alloc(0))).rejects.toMatchObject({
      kind: 'empty',
    });
  });

  it('reports a missing ffmpeg with the install command', async () => {
    try {
      await normaliseReference(fixtures.webm, {
        tmpRoot: workdir,
        ffmpegAvailable: false,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as RefError).kind).toBe('ffmpeg-missing');
      expect((error as RefError).remedy).toBe(FFMPEG_INSTALL_REMEDY);
    }
  });

  it('names the input problem when a transcode fails', async () => {
    // A truncated WebM: detected as WebM, then undecodable.
    const truncated = fixtures.webm.subarray(0, 40);
    await expect(
      normaliseReference(truncated, { tmpRoot: workdir }),
    ).rejects.toMatchObject({ kind: 'transcode-failed' });
  });

  it('leaves no temporary files behind, on success or on failure', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'breeze-ref-leak-'));
    try {
      await normaliseReference(fixtures.mp3, { tmpRoot: isolated });
      await normaliseReference(fixtures.webm.subarray(0, 40), { tmpRoot: isolated }).catch(
        () => {},
      );
      expect(await readdir(isolated)).toEqual([]);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });
});

describe('the both-or-neither rule is enforced before the request leaves', () => {
  it('accepts a complete pair', () => {
    expect(() =>
      validateReferencePair({ hasAudio: true, refText: 'the exact transcript' }),
    ).not.toThrow();
  });

  it('accepts neither half', () => {
    expect(() => validateReferencePair({ hasAudio: false, refText: '' })).not.toThrow();
    expect(() =>
      validateReferencePair({ hasAudio: false, refText: undefined }),
    ).not.toThrow();
  });

  it('refuses audio without a transcript, naming the missing half', () => {
    try {
      validateReferencePair({ hasAudio: true, refText: '   ' });
      expect.unreachable();
    } catch (error) {
      expect((error as RefError).kind).toBe('incomplete-pair');
      expect((error as RefError).message).toMatch(/without its transcript/);
    }
  });

  it('refuses a transcript without audio, naming the missing half', () => {
    try {
      validateReferencePair({ hasAudio: false, refText: 'some words' });
      expect.unreachable();
    } catch (error) {
      expect((error as RefError).message).toMatch(/without any reference audio/);
    }
  });
});

describe('ffmpeg is looked for at startup', () => {
  it('finds the installed binary', async () => {
    const status = await checkFfmpeg();
    expect(status.available).toBe(true);
    expect(status.version).toMatch(/ffmpeg/i);
  });

  it('reports an absent binary with the install command rather than throwing', async () => {
    const status = await checkFfmpeg('definitely-not-a-real-binary-xyz');
    expect(status.available).toBe(false);
    expect(status.remedy).toBe(FFMPEG_INSTALL_REMEDY);
  });
});
