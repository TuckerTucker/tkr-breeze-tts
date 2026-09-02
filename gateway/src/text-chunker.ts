/**
 * Sentence-aware text chunking with an injected capacity rule.
 *
 * This module knows nothing about models or tokens. Its caller defines what
 * "fits", which keeps the boundary algorithm independently testable and lets
 * script import use the exact same ceiling rule as generation.
 *
 * @module
 */

/** Decide whether one proposed chunk can be processed as a cue. */
export type ChunkFits = (text: string) => boolean;

/** Natural break characters used after sentence segmentation. */
const CLAUSE_BOUNDARIES = new Set([',', ';', ':', '，', '；', '：', '、', '—', '–']);

/** A progressively finer way to divide a piece of source text. */
type Splitter = (text: string) => string[];

/**
 * Divide text into Unicode-aware sentences while retaining their whitespace.
 *
 * `Intl.Segmenter` handles abbreviations and both Latin and CJK sentence
 * punctuation more reliably than a punctuation-only regular expression.
 *
 * @param text - Source text to segment.
 * @returns Ordered segments whose concatenation is the input.
 */
function splitSentences(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  return [...segmenter.segment(text)].map(({ segment }) => segment);
}

/**
 * Divide an oversized sentence after clause punctuation.
 *
 * Whitespace following punctuation stays with the preceding piece so joining
 * the returned values reproduces the source exactly.
 *
 * @param text - Sentence or fragment to divide.
 * @returns Ordered clause-like pieces.
 */
function splitClauses(text: string): string[] {
  const characters = Array.from(text);
  const pieces: string[] = [];
  let buffer = '';

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? '';
    buffer += character;
    if (!CLAUSE_BOUNDARIES.has(character)) continue;

    while (/\s/u.test(characters[index + 1] ?? '')) {
      index += 1;
      buffer += characters[index] ?? '';
    }
    pieces.push(buffer);
    buffer = '';
  }

  if (buffer) pieces.push(buffer);
  return pieces;
}

/**
 * Divide a clause into words, keeping inter-word whitespace intact.
 *
 * @param text - Clause or fragment to divide.
 * @returns Ordered word-like pieces.
 */
function splitWords(text: string): string[] {
  const pieces = text.match(/\s*\S+(?:\s+|$)/gu) ?? [];
  return pieces.join('') === text ? pieces : [text];
}

/**
 * Final Unicode-safe fallback for text without usable word boundaries.
 *
 * @param text - Text to divide.
 * @returns One Unicode code point per entry.
 */
function splitCharacters(text: string): string[] {
  return Array.from(text);
}

const SPLITTERS: readonly Splitter[] = [
  splitSentences,
  splitClauses,
  splitWords,
  splitCharacters,
];

/**
 * Recursively find the coarsest source pieces that each fit.
 *
 * @param text - Source fragment.
 * @param fits - Injected capacity rule.
 * @param level - Current splitter index.
 * @returns Ordered source pieces that fit independently.
 */
function fittingPieces(text: string, fits: ChunkFits, level = 0): string[] {
  const candidate = text.trim();
  if (!candidate) return [];
  if (fits(candidate)) return [text];
  if (level >= SPLITTERS.length) return [text];

  const pieces = SPLITTERS[level]!(text);
  if (pieces.length <= 1) return fittingPieces(text, fits, level + 1);
  return pieces.flatMap((piece) => fittingPieces(piece, fits, level + 1));
}

/**
 * Greedily combine fitting pieces into the fewest capacity-safe chunks.
 *
 * @param pieces - Ordered source pieces that each fit.
 * @param fits - Injected capacity rule.
 * @returns Packed, trimmed chunks.
 */
function packPieces(pieces: readonly string[], fits: ChunkFits): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const piece of pieces) {
    const combined = `${current}${piece}`.trim();
    if (!current || fits(combined)) {
      current += piece;
      continue;
    }

    chunks.push(current.trim());
    current = piece;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Split one imported line only when it exceeds the caller's capacity.
 *
 * Boundaries are attempted from least disruptive to most granular: sentence,
 * clause, word, then Unicode code point. If even an individual source
 * character cannot fit—normally because the instruction consumes the entire
 * budget—the original line is retained so import never explodes into hundreds
 * of equally unrunnable one-character cues.
 *
 * @param text - One non-empty imported line.
 * @param fits - Injected capacity rule for a complete cue.
 * @returns One unchanged line, or multiple ordered capacity-safe chunks.
 */
export function chunkText(text: string, fits: ChunkFits): string[] {
  const trimmed = text.trim();
  if (!trimmed || fits(trimmed)) return trimmed ? [trimmed] : [];

  const contentCharacters = Array.from(trimmed).filter((character) => !/\s/u.test(character));
  if (contentCharacters.some((character) => !fits(character))) return [trimmed];

  return packPieces(fittingPieces(trimmed, fits), fits);
}
