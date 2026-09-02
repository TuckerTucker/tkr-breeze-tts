/** Sentence-aware text chunking independent of model-specific limits. */

import { describe, expect, it } from 'vitest';

import { chunkText } from '../src/text-chunker.js';

describe('sentence-aware text chunking', () => {
  it('leaves a fitting line unchanged', () => {
    const source = 'One sentence. A second sentence stays with it.';
    expect(chunkText(source, (text) => text.length <= 100)).toEqual([source]);
  });

  it('packs complete sentences into the fewest fitting chunks', () => {
    const source = 'First sentence is here. Second sentence is here. Third sentence is here.';
    const chunks = chunkText(source, (text) => text.length <= 48);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 48)).toBe(true);
    expect(chunks.join(' ')).toBe(source);
    expect(chunks[0]).toMatch(/\.$/u);
  });

  it('falls back through clauses and words for one oversized sentence', () => {
    const source =
      'Alpha beta gamma delta, epsilon zeta eta theta, iota kappa lambda mu without stopping.';
    const chunks = chunkText(source, (text) => text.length <= 28);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 28)).toBe(true);
    expect(chunks.join(' ')).toBe(source);
  });

  it('uses Unicode code points when text has no word boundaries', () => {
    const source = '這是一段沒有空格而且非常長的中文內容需要安全分段';
    const chunks = chunkText(source, (text) => Array.from(text).length <= 6);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 6)).toBe(true);
    expect(chunks.join('')).toBe(source);
  });

  it('retains the original line when even one character cannot fit', () => {
    const source = 'The instruction has consumed the whole budget.';
    expect(chunkText(source, () => false)).toEqual([source]);
  });
});
