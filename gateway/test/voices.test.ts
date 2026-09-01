/**
 * The voice library: a durable identity the model itself cannot provide.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClipCache } from '../src/cache.js';
import type { ClipRequest } from '../src/cache-index.js';
import { VoiceStore } from '../src/voices.js';
import {
  UNDO_WINDOW_MS,
  disambiguateName,
  partitionByUndoWindow,
  suggestNameFromInstruction,
  validateVoice,
  type VoiceRecord,
} from '../src/voices-index.js';
import { frameWav, readWavHeader } from '../src/transport.js';
import { makePcm, silentLogger } from './helpers.js';

const FORMAT = { sampleRate: 24000, format: 's16le', channels: 1, bytesPerSample: 2 } as const;

const clipRequest = (overrides: Partial<ClipRequest> = {}): ClipRequest => ({
  text: 'It is good to hear your voice again.',
  instruction: 'A warm, thoughtful young woman, calm delivery.',
  mode: 'design',
  cfgScale: 1,
  seed: 42,
  ...overrides,
});

let root: string;
let cache: ClipCache;
let voices: VoiceStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'breeze-voices-'));
  cache = new ClipCache({
    dir: join(root, 'clips'),
    maxBytes: 10 * 1024 * 1024,
    logger: silentLogger(),
  });
  voices = new VoiceStore({ dir: join(root, 'voices'), logger: silentLogger() });
  await Promise.all([cache.load(), voices.load()]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const pcmHash = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

describe('saving a voice from a clip', () => {
  it('copies the exact sample data with no transcode', async () => {
    const pcm = makePcm(24_000);
    const clip = await cache.put(pcm, {
      format: FORMAT,
      ttfaMs: 38,
      transport: 'streaming',
      request: clipRequest(),
    });

    const voice = await voices.createFromClip({
      cache,
      clipId: clip!.id,
      name: 'Narrator — calm',
    });

    const stored = (await voices.read(voice.id)).wav;
    // A container write, not a re-encode: the PCM inside is byte-identical.
    expect(pcmHash(stored.subarray(44))).toBe(pcmHash(pcm));
    expect(readWavHeader(stored).sampleRate).toBe(24000);
  });

  it('fills the transcript from the text that produced the clip', async () => {
    const clip = await cache.put(makePcm(600), {
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: clipRequest({ text: 'Welcome aboard, traveller.' }),
    });
    const voice = await voices.createFromClip({ cache, clipId: clip!.id, name: 'Greeter' });
    // The system already holds that text and the vendor requires the
    // transcript to be exact, so asking the operator to retype it would be
    // asking for work already done.
    expect(voice.transcript).toBe('Welcome aboard, traveller.');
  });

  it('records where the voice came from', async () => {
    const designed = await cache.put(makePcm(600), {
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: clipRequest({ mode: 'design', seed: 17 }),
    });
    const cloned = await cache.put(makePcm(600, 3), {
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: clipRequest({ mode: 'clone' }),
    });

    const a = await voices.createFromClip({ cache, clipId: designed!.id, name: 'Designed' });
    const b = await voices.createFromClip({ cache, clipId: cloned!.id, name: 'Cloned' });

    expect(a.origin.kind).toBe('designed');
    expect(a.origin.seed).toBe(17);
    expect(a.origin.instruction).toContain('thoughtful');
    expect(b.origin.kind).toBe('cloned');
  });

  it('survives eviction of the clip it came from', async () => {
    const clip = await cache.put(makePcm(600), {
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: clipRequest(),
    });
    const voice = await voices.createFromClip({ cache, clipId: clip!.id, name: 'Kept' });

    await cache.remove(clip!.id);
    expect(cache.get(clip!.id)).toBeUndefined();

    // Two lifetimes, deliberately separated: clips are exhaust, voices are kept.
    const read = await voices.read(voice.id);
    expect(read.record.name).toBe('Kept');
    expect(read.wav.length).toBeGreaterThan(44);
  });

  it('refuses to save from a clip that has already been evicted', async () => {
    await expect(
      voices.createFromClip({ cache, clipId: 'never-existed', name: 'Ghost' }),
    ).rejects.toMatchObject({ type: 'not-found' });
  });
});

describe('reads always hand back both halves', () => {
  it('returns audio and transcript together', async () => {
    const voice = await voices.create({
      wav: frameWav(makePcm(600), FORMAT),
      transcript: 'the exact words',
      name: 'Pairish',
      origin: { kind: 'cloned' },
    });
    const read = await voices.read(voice.id);
    expect(read.record.transcript).toBe('the exact words');
    expect(read.wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('refuses to store a voice with no transcript', async () => {
    await expect(
      voices.create({
        wav: frameWav(makePcm(600), FORMAT),
        transcript: '   ',
        name: 'Half-formed',
        origin: { kind: 'cloned' },
      }),
    ).rejects.toMatchObject({ type: 'validation' });
  });

  it('reports a voice whose audio has gone as unavailable, not selectable', async () => {
    const voice = await voices.create({
      wav: frameWav(makePcm(600), FORMAT),
      transcript: 'words',
      name: 'Vanishing',
      origin: { kind: 'cloned' },
    });
    await unlink(join(voices.dir, `${voice.id}.wav`));

    expect(await voices.isAvailable(voice.id)).toBe(false);
    await expect(voices.read(voice.id)).rejects.toMatchObject({ type: 'not-found' });
  });
});

describe('naming', () => {
  it('disambiguates a duplicate rather than refusing it', () => {
    expect(disambiguateName('Narrator', [])).toBe('Narrator');
    expect(disambiguateName('Narrator', ['Narrator'])).toBe('Narrator 2');
    expect(disambiguateName('Narrator', ['Narrator', 'Narrator 2'])).toBe('Narrator 3');
  });

  it('accepts a duplicate through the store, with a suffix', async () => {
    const wav = frameWav(makePcm(600), FORMAT);
    const first = await voices.create({
      wav,
      transcript: 'a',
      name: 'Narrator',
      origin: { kind: 'cloned' },
    });
    const second = await voices.create({
      wav,
      transcript: 'b',
      name: 'Narrator',
      origin: { kind: 'cloned' },
    });
    expect(first.name).toBe('Narrator');
    expect(second.name).toBe('Narrator 2');
  });

  it('suggests a name from the instruction that produced the clip', () => {
    expect(
      suggestNameFromInstruction('A warm, thoughtful young woman, calm delivery.'),
    ).toBe('Warm');
    expect(suggestNameFromInstruction('crisp light quick to the point')).toBe(
      'Crisp light quick to the',
    );
    expect(suggestNameFromInstruction(undefined)).toBe('New voice');
  });

  it('renames without touching the audio', async () => {
    const voice = await voices.create({
      wav: frameWav(makePcm(600), FORMAT),
      transcript: 'words',
      name: 'Before',
      origin: { kind: 'cloned' },
    });
    const before = (await voices.read(voice.id)).wav;
    const renamed = await voices.update(voice.id, { name: 'After' });
    expect(renamed.name).toBe('After');
    expect((await voices.read(voice.id)).wav.equals(before)).toBe(true);
  });
});

describe('delete is undoable, not confirmable', () => {
  it('takes effect immediately and can be undone inside the window', async () => {
    const voice = await voices.create({
      wav: frameWav(makePcm(600), FORMAT),
      transcript: 'words',
      name: 'Regretted',
      origin: { kind: 'cloned' },
    });

    await voices.remove(voice.id);
    expect(voices.list().map((entry) => entry.id)).not.toContain(voice.id);

    await voices.restore(voice.id);
    expect(voices.list().map((entry) => entry.id)).toContain(voice.id);
  });

  it('never touches the clips a voice was made from', async () => {
    const clip = await cache.put(makePcm(600), {
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: clipRequest(),
    });
    const voice = await voices.createFromClip({ cache, clipId: clip!.id, name: 'Doomed' });

    await voices.remove(voice.id);
    expect(cache.get(clip!.id)).toBeDefined();
  });

  it('purges only what is past the undo window', () => {
    const now = 1_000_000;
    const records = [
      { id: 'live' },
      { id: 'just-deleted', deletedAt: now - 1_000 },
      { id: 'long-gone', deletedAt: now - UNDO_WINDOW_MS - 1 },
    ] as VoiceRecord[];
    const { visible, purge } = partitionByUndoWindow(records, now);
    expect(visible.map((record) => record.id)).toEqual(['live']);
    expect(purge.map((record) => record.id)).toEqual(['long-gone']);
  });
});

describe('persistence', () => {
  it('survives a restart with name, transcript and provenance intact', async () => {
    const created = await voices.create({
      wav: frameWav(makePcm(600), FORMAT),
      transcript: 'the exact transcript',
      name: 'Persisted',
      origin: { kind: 'designed', instruction: 'a bright reader', seed: 7 },
      defaultDirection: 'urgent and clipped',
    });

    const reopened = new VoiceStore({ dir: join(root, 'voices'), logger: silentLogger() });
    await reopened.load();
    const record = reopened.get(created.id)!;

    expect(record.name).toBe('Persisted');
    expect(record.transcript).toBe('the exact transcript');
    expect(record.origin).toMatchObject({ kind: 'designed', seed: 7 });
    expect(record.defaultDirection).toBe('urgent and clipped');
  });

  it('rejects a sidecar with no transcript on load', () => {
    expect(validateVoice({ id: 'x', name: 'y', bytes: 1, sampleRate: 24000 })).toBeNull();
    expect(
      validateVoice({
        id: 'x',
        name: 'y',
        transcript: 'z',
        bytes: 1,
        sampleRate: 24000,
      }),
    ).not.toBeNull();
  });
});
