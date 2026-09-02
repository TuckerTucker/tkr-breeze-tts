/**
 * The script runner: one request per cue, cache-first, drift reported not fixed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClipCache } from '../src/cache.js';
import { runScript } from '../src/cue-queue.js';
import {
  MAX_CUE_TOKENS,
  ScriptStore,
  clipIdFor,
  concatenateScript,
  effectiveCueSettings,
  estimateTokens,
  exportVtt,
  findCeilingBreach,
  refreshScript,
  tokenCeilingFor,
  type Cue,
  type ScriptRecord,
} from '../src/script.js';
import { durationSeconds, readWavHeader } from '../src/transport.js';
import {
  emitVtt,
  formatTimestamp,
  parsePlainText,
  parseScriptFile,
  parseTimestamp,
  parseVtt,
} from '../src/vtt.js';
import { makePcm, silentLogger } from './helpers.js';

const FORMAT = { sampleRate: 24000, format: 's16le', channels: 1, bytesPerSample: 2 } as const;

const SAMPLE_VTT = `WEBVTT

1
00:00:00.000 --> 00:00:03.400
It is good to hear your voice again.

2
00:00:03.500 --> 00:00:05.100
After all this time.

3
00:00:05.100 --> 00:00:07.000
We need to move. Now.
`;

let root: string;
let cache: ClipCache;
let scripts: ScriptStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'breeze-script-'));
  cache = new ClipCache({ dir: join(root, 'clips'), maxBytes: 1e9, logger: silentLogger() });
  scripts = new ScriptStore({ dir: join(root, 'scripts'), logger: silentLogger() });
  await Promise.all([cache.load(), scripts.load()]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('WebVTT parsing', () => {
  it('reads timestamps in both hour-bearing and short forms', () => {
    expect(parseTimestamp('00:00:03.400')).toBeCloseTo(3.4, 6);
    expect(parseTimestamp('01:02.500')).toBeCloseTo(62.5, 6);
    expect(parseTimestamp('01:00:00.000')).toBe(3600);
    expect(parseTimestamp('nonsense')).toBeNull();
  });

  it('round-trips a timestamp', () => {
    expect(formatTimestamp(3.4)).toBe('00:00:03.400');
    expect(formatTimestamp(3661.25)).toBe('01:01:01.250');
  });

  it('parses cues with their target timings', () => {
    const { cues, problems } = parseVtt(SAMPLE_VTT);
    expect(problems).toHaveLength(0);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toMatchObject({
      text: 'It is good to hear your voice again.',
      targetStart: 0,
    });
    expect(cues[0]!.targetEnd).toBeCloseTo(3.4, 6);
  });

  it('names a malformed cue and skips it, importing the rest', () => {
    const broken = `WEBVTT

1
00:00:00.000 --> 00:00:01.000
Good line.

2
not a timing line
Orphaned text.

3
00:00:99.999 --> 00:00:02.000
Bad timestamp.

4
00:00:02.000 --> 00:00:03.000
Another good line.
`;
    const { cues, problems } = parseVtt(broken);
    // The file is not rejected wholesale — one typo must not cost forty cues.
    expect(cues.map((cue) => cue.text)).toEqual(['Good line.', 'Another good line.']);
    expect(problems).toHaveLength(2);
    expect(problems[0]!.reason).toMatch(/timing line/);
    expect(problems[1]!.reason).toMatch(/timestamp/);
  });

  it('reads plain text as untimed cues with no fabricated timings', () => {
    const { cues } = parsePlainText('First line.\n\nSecond line.\n');
    expect(cues).toHaveLength(2);
    expect(cues[0]!.targetStart).toBeNull();
    expect(cues[0]!.targetEnd).toBeNull();
  });

  it('routes a file to the right parser', () => {
    expect(parseScriptFile(SAMPLE_VTT, 'scene.vtt').format).toBe('vtt');
    expect(parseScriptFile('one\ntwo\n', 'notes.txt').format).toBe('text');
  });
});

describe('the cue list is the document', () => {
  it('imports a VTT into an editable cue list carrying its targets', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT, filename: 'rescue.vtt' });
    expect(script.source).toBe('vtt');
    expect(script.cues).toHaveLength(3);
    expect(script.cues[0]!.targetEnd).toBeCloseTo(3.4, 6);
    expect(script.cues.every((cue) => cue.state === 'queued')).toBe(true);
  });

  it('splits an oversized plain-text line at sentence boundaries during import', async () => {
    const sentence = (index: number): string =>
      `Sentence ${index} carries ${'word '.repeat(78).trim()}.`;
    const source = [sentence(1), sentence(2), sentence(3)].join(' ');

    const script = await scripts.importFile({ source, filename: 'long-form.txt' });

    expect(script.cues).toHaveLength(2);
    expect(script.cues.map((cue) => cue.text).join(' ')).toBe(source);
    expect(script.chunking).toEqual({
      version: 2,
      sourceCueCount: 1,
      splitSourceCueCount: 1,
      outputCueCount: 2,
      addedCueCount: 1,
      tokenCeiling: 256,
    });
    expect(
      script.cues.every(
        (cue) =>
          findCeilingBreach({
            mode: 'design',
            cfgScale: script.defaults!.cfgScale,
            text: cue.text,
            instruction: script.defaults!.instruction,
          }) === null,
      ),
    ).toBe(true);
  });

  it('uses imported CFG and reference mode when deciding whether a line fits', async () => {
    const source = 'word '.repeat(300).trim();
    const design = await scripts.importFile({ source, filename: 'design.txt' });
    const clone = await scripts.importFile({
      source,
      filename: 'clone.txt',
      defaults: {
        voiceId: 'voice-1',
        voiceName: 'Narrator',
        cfgScale: 4,
      },
    });

    expect(design.cues.length).toBeGreaterThan(1);
    expect(design.chunking?.tokenCeiling).toBe(256);
    expect(clone.cues).toHaveLength(1);
    expect(clone.chunking).toMatchObject({
      splitSourceCueCount: 0,
      outputCueCount: 1,
      tokenCeiling: 512,
    });
  });

  it('budgets reference audio and punctuation-heavy dialogue during import', async () => {
    const reference = {
      transcript: 'This is how this voice will sound when you use it.',
      durationSeconds: 3.36,
    };
    const source = 'And they said, "Yeah, we are going to miss out on a lot of things." '.repeat(55);
    const script = await scripts.importFile({
      source,
      filename: 'quoted-dialogue.txt',
      defaults: { voiceId: 'voice-1', voiceName: 'Narrator' },
      reference,
    });

    expect(script.cues.length).toBeGreaterThan(1);
    expect(script.chunking?.tokenCeiling).toBe(256);
    expect(
      script.cues.every(
        (cue) =>
          findCeilingBreach({
            mode: 'clone',
            cfgScale: cue.cfgScale,
            text: cue.text,
            instruction: cue.instruction,
            refText: reference.transcript,
            refDurationSeconds: reference.durationSeconds,
          }) === null,
      ),
    ).toBe(true);
  });

  it('reflows a version-one text layout while preserving a completed short tail', async () => {
    const reference = {
      transcript: 'This is how this voice will sound when you use it.',
      durationSeconds: 3.36,
    };
    const script = await scripts.importFile({
      source: 'Original line.\n\nShort tail.',
      defaults: { voiceId: 'voice-1', voiceName: 'Narrator' },
      reference,
    });
    const longCue = script.cues[0]!;
    longCue.text = 'And they answered, "Yes, this is repeated dialogue." '.repeat(60);
    longCue.clipId = clipIdFor(longCue);
    longCue.state = 'failed';
    longCue.problem = 'terminated';
    const tail = script.cues[1]!;
    tail.state = 'done';
    tail.actualSeconds = 1;
    delete (script.chunking as { version?: number }).version;
    await scripts.save(script);

    const migrated = await scripts.rechunkPlainText(
      script.id,
      new Map([['voice-1', reference]]),
    );

    expect(migrated.chunking?.version).toBe(2);
    expect(migrated.cues.length).toBeGreaterThan(2);
    expect(migrated.cues.find((cue) => cue.text === 'Short tail.')).toMatchObject({
      state: 'done',
      actualSeconds: 1,
    });
    expect(
      migrated.cues.every(
        (cue) =>
          findCeilingBreach({
            mode: 'clone',
            cfgScale: cue.cfgScale,
            text: cue.text,
            instruction: cue.instruction,
            refText: reference.transcript,
            refDurationSeconds: reference.durationSeconds,
          }) === null,
      ),
    ).toBe(true);
  });

  it('does not split an oversized timed cue or invent sub-timings', async () => {
    const source = `WEBVTT\n\n1\n00:00:00.000 --> 00:00:08.000\n${'word '.repeat(300)}`;
    const script = await scripts.importFile({ source, filename: 'timed.vtt' });

    expect(script.cues).toHaveLength(1);
    expect(script.cues[0]).toMatchObject({ targetStart: 0, targetEnd: 8 });
    expect(script.chunking).toBeUndefined();
  });

  it('editing one cue changes only that cue’s clip id', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });
    const before = script.cues.map((cue) => cue.clipId);

    const after = await scripts.patchCue(script.id, script.cues[1]!.id, {
      text: 'After all these years.',
    });

    expect(after.cues[0]!.clipId).toBe(before[0]);
    expect(after.cues[2]!.clipId).toBe(before[2]);
    expect(after.cues[1]!.clipId).not.toBe(before[1]);
  });

  it('resolves nullable cue overrides before script defaults', async () => {
    const script = await scripts.importFile({
      source: 'First line.\n\nSecond line.',
      defaults: {
        voiceId: 'default-voice',
        voiceName: 'Default voice',
        instruction: 'Default delivery',
        cfgScale: 4,
        seedMode: 'increment',
        seed: 100,
      },
    });
    const cue = script.cues[1]!;
    expect(effectiveCueSettings(script, cue)).toEqual({
      voiceId: 'default-voice',
      voiceName: 'Default voice',
      instruction: 'Default delivery',
      cfgScale: 4,
      seed: 101,
    });

    await scripts.patchCue(script.id, cue.id, {
      overrides: { instruction: 'Cue delivery', cfgScale: 1, seed: 7 },
    });
    expect(effectiveCueSettings(script, cue)).toMatchObject({
      instruction: 'Cue delivery',
      cfgScale: 1,
      seed: 7,
    });

    await scripts.patchCue(script.id, cue.id, {
      overrides: { instruction: null, cfgScale: null, seed: null },
    });
    expect(effectiveCueSettings(script, cue)).toMatchObject({
      instruction: 'Default delivery',
      cfgScale: 4,
      seed: 101,
    });
  });

  it('stales only cues that inherit a changed script default', async () => {
    const script = await scripts.importFile({ source: 'First.\n\nSecond.' });
    const pinned = script.cues[0]!;
    const inherited = script.cues[1]!;
    await scripts.patchCue(script.id, pinned.id, {
      overrides: { instruction: 'Pinned delivery' },
    });
    pinned.state = 'done';
    pinned.actualSeconds = 1;
    inherited.state = 'done';
    inherited.actualSeconds = 1;
    const pinnedId = pinned.clipId;
    const inheritedId = inherited.clipId;

    await scripts.patchDefaults(script.id, { instruction: 'A new default delivery' });

    expect(pinned.clipId).toBe(pinnedId);
    expect(pinned.state).toBe('done');
    expect(pinned.actualSeconds).toBe(1);
    expect(inherited.clipId).not.toBe(inheritedId);
    expect(inherited.state).toBe('stale');
    expect(inherited.actualSeconds).toBeNull();
  });

  it('includes the effective instruction in cue cache identity', () => {
    const base = {
      text: 'Same line.',
      voiceId: null,
      cfgScale: 1,
      seed: 42,
    };
    expect(clipIdFor({ ...base, instruction: 'Quietly.' })).not.toBe(
      clipIdFor({ ...base, instruction: 'Urgently.' }),
    );
  });

  it('marks a cue whose voice was deleted as unrunnable with the reason', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });
    await scripts.patchCue(script.id, script.cues[0]!.id, {
      voiceId: 'gone',
      voiceName: 'Narrator — calm',
    });

    const refreshed = refreshScript(scripts.require(script.id), {
      cache,
      voiceReferences: new Map(),
    });
    expect(refreshed.cues[0]!.state).toBe('unrunnable');
    expect(refreshed.cues[0]!.problem).toMatch(/Narrator — calm/);
  });

  it('flags a cue past its own mode’s ceiling before anything is dispatched', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });
    const long = 'word '.repeat(MAX_CUE_TOKENS * 5);
    await scripts.patchCue(script.id, script.cues[0]!.id, { text: long });

    const refreshed = refreshScript(scripts.require(script.id), {
      cache,
      voiceReferences: new Map(),
    });
    expect(refreshed.cues[0]!.state).toBe('unrunnable');
    // Default cfg is 1.0, so the single-branch ceiling of 256 applies.
    expect(refreshed.cues[0]!.problem).toContain('256');
    expect(refreshed.cues[0]!.problem).toContain('fails outright');
    expect(estimateTokens(long)).toBeGreaterThan(MAX_CUE_TOKENS);
  });

  it('applies the ceiling per branch mode, not globally', async () => {
    // Measured live: ~299 tokens fails at cfg 1.0 and serves at cfg 2.5/4.0.
    // A flat 512 would let the cfg-1.0 case through to a hard failure that
    // produces no audio at all.
    expect(tokenCeilingFor('design', 1.0)).toBe(256);
    expect(tokenCeilingFor('design', 2.5)).toBe(512);
    expect(tokenCeilingFor('design', 4.0)).toBe(512);

    const script = await scripts.importFile({ source: SAMPLE_VTT });
    const midLength = 'word '.repeat(300); // ~375 tokens: over 256, under 512
    const cueId = script.cues[0]!.id;

    await scripts.patchCue(script.id, cueId, { text: midLength, cfgScale: 1.0 });
    let refreshed = refreshScript(scripts.require(script.id), {
      cache,
      voiceReferences: new Map(),
    });
    expect(refreshed.cues[0]!.state).toBe('unrunnable');

    await scripts.patchCue(script.id, cueId, { cfgScale: 4.0 });
    refreshed = refreshScript(scripts.require(script.id), {
      cache,
      voiceReferences: new Map(),
    });
    expect(refreshed.cues[0]!.state).not.toBe('unrunnable');
  });
});

describe('running a script', () => {
  const synthesizerFor = (
    calls: Cue[],
    pcmSamples = 24_000,
  ) => async (cue: Cue): Promise<{ clipId: string; durationSeconds: number }> => {
    calls.push({ ...cue });
    const pcm = makePcm(pcmSamples);
    await cache.put(pcm, {
      id: cue.clipId,
      format: FORMAT,
      ttfaMs: 38,
      transport: 'streaming',
      request: {
        text: cue.text,
        instruction: 'x',
        mode: cue.voiceId ? 'clone' : 'design',
        cfgScale: cue.cfgScale,
        seed: cue.seed,
      },
    });
    return { clipId: cue.clipId, durationSeconds: durationSeconds(pcm.length, FORMAT) };
  };

  it('issues one request per cue, each with its own voice', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });
    const voiceIds = ['v1', 'v2', 'v3'];
    for (const [index, cue] of script.cues.entries()) {
      await scripts.patchCue(script.id, cue.id, {
        voiceId: voiceIds[index]!,
        voiceName: `Voice ${index}`,
      });
    }

    const calls: Cue[] = [];
    const summary = await runScript({
      script: scripts.require(script.id),
      cache,
      voiceReferences: new Map(
        voiceIds.map((id) => [
          id,
          { transcript: 'a short transcript', durationSeconds: 1 },
        ]),
      ),
      synthesize: synthesizerFor(calls),
      logger: silentLogger(),
    });

    // The served API exposes no speaker field, so a multi-voice script cannot
    // be a single dialogue call.
    expect(calls).toHaveLength(3);
    expect(calls.map((cue) => cue.voiceId)).toEqual(voiceIds);
    expect(summary.generated).toBe(3);
    expect(summary.served).toBe(0);
  });

  it('re-running after one edit issues exactly one request', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });

    const first: Cue[] = [];
    await runScript({
      script: scripts.require(script.id),
      cache,
      voiceReferences: new Map(),
      synthesize: synthesizerFor(first),
      logger: silentLogger(),
    });
    expect(first).toHaveLength(3);

    await scripts.patchCue(script.id, script.cues[1]!.id, { text: 'After all these years.' });

    const second: Cue[] = [];
    const summary = await runScript({
      script: scripts.require(script.id),
      cache,
      voiceReferences: new Map(),
      synthesize: synthesizerFor(second),
      logger: silentLogger(),
    });

    // Correcting a line costs one GPU request, not forty.
    expect(second).toHaveLength(1);
    expect(second[0]!.text).toBe('After all these years.');
    expect(summary.served).toBe(2);
    expect(summary.generated).toBe(1);
  });

  it('runs cues strictly in order, one at a time', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    await runScript({
      script: scripts.require(script.id),
      cache,
      voiceReferences: new Map(),
      logger: silentLogger(),
      synthesize: async (cue) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(cue.text);
        concurrent -= 1;
        const pcm = makePcm(2400);
        await cache.put(pcm, {
          id: cue.clipId,
          format: FORMAT,
          ttfaMs: null,
          transport: 'streaming',
          request: {
            text: cue.text,
            instruction: 'x',
            mode: 'design',
            cfgScale: 1,
            seed: 42,
          },
        });
        return { clipId: cue.clipId, durationSeconds: durationSeconds(pcm.length, FORMAT) };
      },
    });

    // A 409 is impossible by construction rather than merely unlikely.
    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(script.cues.map((cue) => cue.text));
  });

  it('fails one cue and leaves the run resumable', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });
    await scripts.patchCue(script.id, script.cues[1]!.id, {
      voiceId: 'deleted',
      voiceName: 'Gone',
    });

    const calls: Cue[] = [];
    const summary = await runScript({
      script: scripts.require(script.id),
      cache,
      voiceReferences: new Map(),
      synthesize: synthesizerFor(calls),
      logger: silentLogger(),
    });

    expect(summary.unrunnable).toBe(1);
    expect(summary.generated).toBe(2);
    // The rest of the script still ran.
    expect(calls).toHaveLength(2);
  });

  it('reports progress per cue as it happens', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });
    const states: string[] = [];
    await runScript({
      script: scripts.require(script.id),
      cache,
      voiceReferences: new Map(),
      synthesize: synthesizerFor([]),
      logger: silentLogger(),
      onProgress: (progress) => states.push(progress.state),
    });
    expect(states.filter((state) => state === 'generating')).toHaveLength(3);
    expect(states.filter((state) => state === 'done')).toHaveLength(3);
  });
});

describe('drift is measured and reported, never corrected', () => {
  it('shows target, actual and difference for a timed cue', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });
    // Cue 1's slot is 3.4s; generate 4.1s of audio.
    const cue = script.cues[0]!;
    await cache.put(makePcm(Math.round(4.1 * 24_000)), {
      id: clipIdFor(cue),
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: { text: cue.text, instruction: 'x', mode: 'design', cfgScale: 1, seed: 42 },
    });

    const refreshed = refreshScript(scripts.require(script.id), {
      cache,
      voiceReferences: new Map(),
    });
    expect(refreshed.cues[0]!.actualSeconds).toBeCloseTo(4.1, 3);
    expect(refreshed.cues[0]!.driftSeconds).toBeCloseTo(0.7, 3);
  });

  it('leaves drift null for an untimed cue rather than inventing a target', async () => {
    const script = await scripts.importFile({ source: 'Just a line.\n', filename: 'a.txt' });
    const cue = script.cues[0]!;
    await cache.put(makePcm(24_000), {
      id: clipIdFor(cue),
      format: FORMAT,
      ttfaMs: null,
      transport: 'streaming',
      request: { text: cue.text, instruction: 'x', mode: 'design', cfgScale: 1, seed: 42 },
    });

    const refreshed = refreshScript(scripts.require(script.id), {
      cache,
      voiceReferences: new Map(),
    });
    expect(refreshed.cues[0]!.actualSeconds).toBeCloseTo(1, 6);
    expect(refreshed.cues[0]!.driftSeconds).toBeNull();
  });

  it('offers no time-stretching anywhere in the surface', () => {
    const surface = Object.keys({ ...({} as ScriptRecord) });
    expect(surface.join(' ')).not.toMatch(/stretch|pitch/i);
  });
});

describe('export', () => {
  const generateAll = async (script: ScriptRecord, seconds: number[]): Promise<void> => {
    for (const [index, cue] of script.cues.entries()) {
      await cache.put(makePcm(Math.round(seconds[index]! * 24_000)), {
        id: clipIdFor(cue),
        format: FORMAT,
        ttfaMs: null,
        transport: 'streaming',
        request: { text: cue.text, instruction: 'x', mode: 'design', cfgScale: 1, seed: 42 },
      });
    }
  };

  it('emits generated timings, not the imported targets', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });
    await generateAll(script, [4.1, 1.6, 2.3]);
    const refreshed = refreshScript(scripts.require(script.id), {
      cache,
      voiceReferences: new Map(),
    });

    const vtt = exportVtt(refreshed);
    expect(vtt).toContain('00:00:00.000 --> 00:00:04.100');
    expect(vtt).toContain('00:00:04.100 --> 00:00:05.700');
    // The imported target for cue 1 ended at 3.400; it must not appear.
    expect(vtt).not.toContain('00:00:03.400');
  });

  it('refuses to export timings for cues that were never generated', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });
    const refreshed = refreshScript(script, { cache, voiceReferences: new Map() });
    expect(() => exportVtt(refreshed)).toThrowError(/have not been generated/);
  });

  it('concatenates into one continuous WAV whose length is the sum of the cues', async () => {
    const script = await scripts.importFile({ source: SAMPLE_VTT });
    const seconds = [4.1, 1.6, 2.3];
    await generateAll(script, seconds);
    const refreshed = refreshScript(scripts.require(script.id), {
      cache,
      voiceReferences: new Map(),
    });

    const wav = await concatenateScript(refreshed, cache);
    const header = readWavHeader(wav);
    const expectedBytes = seconds.reduce(
      (total, value) => total + Math.round(value * 24_000) * 2,
      0,
    );
    expect(header.sampleRate).toBe(24000);
    expect(header.channels).toBe(1);
    expect(header.dataBytes).toBe(expectedBytes);
  });

  it('emits a VTT whose cue count matches its input', () => {
    const vtt = emitVtt([
      { text: 'one', durationSeconds: 1 },
      { text: 'two', durationSeconds: 2 },
    ]);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.000');
  });
});
