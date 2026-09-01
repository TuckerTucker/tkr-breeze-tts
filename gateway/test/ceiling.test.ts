/**
 * The input ceiling: which batch a request lands on, and which field is asked
 * to fit inside it.
 *
 * This exists because the check that preceded it measured `text` alone and
 * keyed the ceiling on cfg alone. Both were wrong, and the second one hid the
 * first: a Clone request at cfg 1.0 was told its ceiling was 256 while its
 * uninspected reference transcript sailed past 512 to the GPU.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  CEILING_BY_BATCH,
  SEGMENTS_BY_MODE,
  ceilingRefusal,
  estimateTokens,
  findCeilingBreach,
  textEncoderBatch,
  tokenCeilingFor,
} from '../src/script.js';

/** The transcript that actually produced `(2, 640)` on a deployed H100. */
const PODCAST_TRANSCRIPT = 'x'.repeat(2707);

describe('the batch a request lands on', () => {
  it('is segments times branches, for all six combinations', () => {
    // tts_instruction is one text segment, ref_edit_tata is two; cfg 1.0 is a
    // single branch and anything else is dual. There is no batch 3 because
    // both factors are 1 or 2.
    expect(textEncoderBatch('design', 1.0)).toBe(1);
    expect(textEncoderBatch('design', 2.5)).toBe(2);
    expect(textEncoderBatch('clone', 1.0)).toBe(2);
    expect(textEncoderBatch('clone', 4.0)).toBe(4);
    expect(textEncoderBatch('direction', 1.0)).toBe(2);
    expect(textEncoderBatch('direction', 2.5)).toBe(4);
  });

  it('gives Clone 512 at cfg 1.0, which keying on cfg alone got wrong', () => {
    // The defect: cfg 1.0 was read as "single branch, so 256". True for
    // Design. Clone already carries two segments, so it reaches batch 2 and
    // 512 is captured for it — the old table refused input that would serve.
    expect(tokenCeilingFor('design', 1.0)).toBe(256);
    expect(tokenCeilingFor('clone', 1.0)).toBe(512);
    expect(tokenCeilingFor('direction', 1.0)).toBe(512);
  });

  it('caps every dual-branch mode at 512, batch 4 included', () => {
    // Batch 4 exists only because extend_warmup_profile.py declares it at
    // build time. Drop that step and Clone at cfg != 1.0 has no graph at all.
    expect(tokenCeilingFor('design', 4.0)).toBe(512);
    expect(tokenCeilingFor('clone', 4.0)).toBe(512);
    expect(CEILING_BY_BATCH[4]).toBe(512);
    expect(SEGMENTS_BY_MODE.clone).toBe(2);
  });
});

describe('every string that becomes a segment is measured', () => {
  it('refuses the reference transcript that reached the GPU as (2, 640)', () => {
    // The live failure, reproduced: a twelve-character line and a
    // 2707-character transcript. The line is trivially inside any ceiling,
    // which is exactly why measuring it alone let this through — twice, after
    // a 170s cold start each time.
    const breach = findCeilingBreach({
      mode: 'clone',
      cfgScale: 1.0,
      text: 'Hello there.',
      instruction: 'A warm, thoughtful young woman, calm and unhurried.',
      refText: PODCAST_TRANSCRIPT,
    });

    expect(breach).not.toBeNull();
    expect(breach!.field).toBe('transcript');
    expect(breach!.ceiling).toBe(512);
    expect(breach!.batch).toBe(2);
    expect(breach!.tokens).toBeGreaterThan(600);
  });

  it('names the transcript, not the line, so the operator knows which box', () => {
    const breach = findCeilingBreach({
      mode: 'clone',
      cfgScale: 1.0,
      text: 'Hello there.',
      refText: PODCAST_TRANSCRIPT,
    })!;
    const { message, remedy } = ceilingRefusal(breach, 'clone');

    expect(message).toMatch(/reference transcript/);
    expect(message).not.toMatch(/the line is/);
    // Raising CFG moves Clone from batch 2 to batch 4 — a different graph, the
    // same 512. Offering it would be advice that does not work.
    expect(remedy).not.toMatch(/raise CFG/i);
    expect(remedy).toMatch(/Shorten the reference transcript/);
  });

  it('offers the CFG escape only where it actually raises the ceiling', () => {
    // Design at 1.0 is the one place it does: batch 1 → batch 2, 256 → 512.
    const breach = findCeilingBreach({
      mode: 'design',
      cfgScale: 1.0,
      text: 'word '.repeat(300),
    })!;
    expect(ceilingRefusal(breach, 'design').remedy).toMatch(/raise CFG above 1\.0/);
  });

  it('counts the instruction with the line, since they share one segment', () => {
    // tts_instruction is a single text segment, so the instruction is not free
    // — a long one plus a long line overflows a segment that either alone fits.
    const half = 'word '.repeat(130); // ~163 tokens each
    expect(findCeilingBreach({ mode: 'design', cfgScale: 1.0, text: half })).toBeNull();
    expect(
      findCeilingBreach({ mode: 'design', cfgScale: 1.0, text: half, instruction: half }),
    ).not.toBeNull();
  });

  it('takes the largest segment, never their sum', () => {
    // The graph bucket is the padded maximum across the batch, so two segments
    // of 400 tokens fit a 512 ceiling. Summing them would refuse a request the
    // GPU serves happily.
    const four_hundred = 'word '.repeat(320);
    expect(estimateTokens(four_hundred)).toBeGreaterThan(300);
    expect(estimateTokens(four_hundred)).toBeLessThan(512);
    expect(
      findCeilingBreach({
        mode: 'clone',
        cfgScale: 1.0,
        text: four_hundred,
        refText: four_hundred,
      }),
    ).toBeNull();
  });

  it('passes a request that fits', () => {
    expect(
      findCeilingBreach({
        mode: 'clone',
        cfgScale: 1.0,
        text: '(laugh) Welcome aboard, traveller.',
        instruction: 'A warm, thoughtful young woman.',
        refText: 'It is good to hear your voice again, after all this time.',
      }),
    ).toBeNull();
  });
});

describe('the estimate', () => {
  it('holds on the one input checked against the real tokenizer', () => {
    // 2707 characters bucketed to a (2, 640) graph, so the true count is in
    // (608, 640]. The estimate should be at or above it — pessimistic is the
    // intended direction, because the failure it prevents is a hard one.
    const estimate = estimateTokens(PODCAST_TRANSCRIPT);
    expect(estimate).toBeGreaterThanOrEqual(640);
    expect(estimate).toBeLessThan(800);
  });

  it('counts CJK far higher than Latin, on a model that invites both', () => {
    // Four characters per token is an English average. A Han character is
    // three UTF-8 bytes: byte fallback costs three tokens, good merges cost
    // one. Treating 中文 like English is what makes a 2000-character line look
    // like 500 tokens and arrive as roughly 2000.
    const latin = 'a'.repeat(100);
    const han = '字'.repeat(100);
    expect(estimateTokens(latin)).toBe(25);
    expect(estimateTokens(han)).toBeGreaterThan(estimateTokens(latin) * 4);
  });

  it('counts an astral ideograph once, not twice', () => {
    // Two UTF-16 units, one character. Measuring by `.length` would double it.
    expect(estimateTokens('\u{20000}')).toBe(estimateTokens('字'));
  });

  it('is zero for nothing, so an empty instruction costs no ceiling', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   \n  ')).toBe(0);
  });
});

describe('the gateway and the UI agree', () => {
  // Compared as source text rather than by importing across the package
  // boundary: the two are separate builds with separate tsconfigs, and a test
  // that reaches over that line typechecks in neither. Reading the literals is
  // also the stricter check — it catches a table that drifts even if some
  // accessor still happens to return the same number.
  const gatewaySource = readFileSync(
    new URL('../src/script.ts', import.meta.url),
    'utf8',
  );
  const uiSource = readFileSync(
    new URL('../../ui/src/state/draft.ts', import.meta.url),
    'utf8',
  );

  /**
   * Pull one declaration's right-hand side out of a source file.
   *
   * @param source - The file's text.
   * @param name - The declared name.
   * @returns The declaration text, whitespace-normalised.
   */
  const declaration = (source: string, name: string): string => {
    const match = new RegExp(`(?:const|function)\\s+${name}\\b([^;]*?);`, 's').exec(source);
    // A regex that stops matching would otherwise compare undefined to
    // undefined and pass while the tables diverged.
    expect(match, `no declaration of ${name} found`).not.toBeNull();
    return match![1]!.replace(/\s+/g, ' ').trim();
  };

  it.each(['CEILING_BY_BATCH', 'SEGMENTS_BY_MODE'])(
    'declares the same %s in both packages',
    (name) => {
      // Two copies that disagree are worse than one that is wrong: the UI
      // control would enable into a refusal, or refuse what would have served.
      expect(declaration(uiSource, name)).toBe(declaration(gatewaySource, name));
    },
  );

  it.each(['LATIN_CHARS_PER_TOKEN', 'CJK_TOKENS_PER_CHAR', 'isCjk', 'estimateTokens'])(
    'estimates with the same %s in both packages',
    (name) => {
      // A meter that counted differently from the check would sit comfortably
      // inside the limit for a request the gateway then refuses.
      expect(declaration(uiSource, name)).toBe(declaration(gatewaySource, name));
    },
  );

  it('agrees on the ceiling for every mode and cfg the UI can produce', () => {
    // The table is shared above; this pins the arithmetic over it, which is
    // where Clone at cfg 1.0 was previously read as 256.
    expect(tokenCeilingFor('clone', 1.0)).toBe(512);
    expect(tokenCeilingFor('design', 1.0)).toBe(256);
    expect(estimateTokens(PODCAST_TRANSCRIPT)).toBe(677);
  });
});
