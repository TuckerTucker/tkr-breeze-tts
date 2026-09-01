/**
 * WebVTT parsing and emission.
 *
 * Import is forgiving by design: a malformed cue is *named and skipped*, and
 * the rest of the file still imports. Rejecting a forty-cue script because one
 * timestamp has a typo makes the operator fix a file by hand to find out
 * whether the feature works at all.
 *
 * Export is strict in the other direction: the timings emitted are the
 * durations actually generated, re-flowed from zero. Emitting the imported
 * targets would produce a file that claims a synchronisation the audio does
 * not have.
 *
 * @module
 */

/** A cue as it arrived from a file. */
export interface ParsedCue {
  /** Position in the file, from zero. */
  readonly index: number;
  /** The line to speak. */
  readonly text: string;
  /** Target start in seconds, or null for untimed plain text. */
  readonly targetStart: number | null;
  /** Target end in seconds, or null for untimed plain text. */
  readonly targetEnd: number | null;
}

/** A cue that could not be read, kept so the operator sees what was skipped. */
export interface CueProblem {
  /** Which block in the file, from zero. */
  readonly block: number;
  /** What was wrong with it. */
  readonly reason: string;
  /** The raw text, so it can be shown and fixed in place. */
  readonly raw: string;
}

/** The result of importing a file. */
export interface ParseResult {
  readonly cues: ParsedCue[];
  readonly problems: CueProblem[];
}

const TIMING_LINE = /^(\S+)\s+-->\s+(\S+)/;

/**
 * Parse a WebVTT timestamp.
 *
 * @param value - `HH:MM:SS.mmm`, `MM:SS.mmm`, or either with a comma.
 * @returns Seconds, or null when it does not parse.
 */
export function parseTimestamp(value: string): number | null {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, millis] = match;
  const m = Number(minutes);
  const s = Number(seconds);
  if (m > 59 || s > 59) return null;
  return (
    Number(hours ?? 0) * 3600 + m * 60 + s + Number((millis ?? '0').padEnd(3, '0')) / 1000
  );
}

/**
 * Render seconds as a WebVTT timestamp.
 *
 * @param seconds - Time offset.
 * @returns `HH:MM:SS.mmm`.
 */
export function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(millis, 3)}`;
}

/**
 * Parse a WebVTT file into cues.
 *
 * @param source - The file's text.
 * @returns The cues that read cleanly, plus a named problem for each that did
 *   not. The file is never rejected wholesale.
 */
export function parseVtt(source: string): ParseResult {
  const normalised = source.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const blocks = normalised.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);

  const cues: ParsedCue[] = [];
  const problems: CueProblem[] = [];

  blocks.forEach((block, blockIndex) => {
    if (blockIndex === 0 && /^WEBVTT/i.test(block)) return;
    if (/^(NOTE|STYLE|REGION)\b/i.test(block)) return;

    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => TIMING_LINE.test(line));
    if (timingIndex === -1) {
      problems.push({
        block: blockIndex,
        reason: 'no “-->” timing line, so this block is not a cue',
        raw: block,
      });
      return;
    }

    const timing = TIMING_LINE.exec(lines[timingIndex] ?? '');
    const start = parseTimestamp(timing?.[1] ?? '');
    const end = parseTimestamp(timing?.[2] ?? '');
    if (start === null || end === null) {
      problems.push({
        block: blockIndex,
        reason: `unreadable timestamp in “${lines[timingIndex]?.trim() ?? ''}”`,
        raw: block,
      });
      return;
    }
    if (end < start) {
      problems.push({
        block: blockIndex,
        reason: 'the cue ends before it starts',
        raw: block,
      });
      return;
    }

    const text = lines
      .slice(timingIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!text) {
      problems.push({ block: blockIndex, reason: 'the cue has no text', raw: block });
      return;
    }

    cues.push({ index: cues.length, text, targetStart: start, targetEnd: end });
  });

  return { cues, problems };
}

/**
 * Read plain text as untimed cues, one per non-empty line.
 *
 * No timings are invented. A cue with a fabricated target would produce drift
 * figures measured against a number nobody chose.
 *
 * @param source - The file's text.
 * @returns One cue per line.
 */
export function parsePlainText(source: string): ParseResult {
  const cues = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text, index) => ({ index, text, targetStart: null, targetEnd: null }));
  return { cues, problems: [] };
}

/**
 * Choose a parser from the filename and the content.
 *
 * @param source - The file's text.
 * @param filename - The name it arrived under, when there was one.
 * @returns The parse result, and which parser ran.
 */
export function parseScriptFile(
  source: string,
  filename?: string,
): ParseResult & { format: 'vtt' | 'text' } {
  const looksLikeVtt =
    /^﻿?WEBVTT/i.test(source.trimStart()) ||
    (filename ?? '').toLowerCase().endsWith('.vtt') ||
    /-->/.test(source);
  return looksLikeVtt
    ? { ...parseVtt(source), format: 'vtt' }
    : { ...parsePlainText(source), format: 'text' };
}

/** One line of an exported VTT. */
export interface EmittedCue {
  readonly text: string;
  /** The duration actually generated, in seconds. */
  readonly durationSeconds: number;
}

/**
 * Emit WebVTT carrying real generated timings, re-flowed from zero.
 *
 * @param cues - Cues in order, each with its generated duration.
 * @param gapSeconds - Silence inserted between cues, matching the concatenated
 *   export so the two agree.
 * @returns A WebVTT document.
 */
export function emitVtt(cues: readonly EmittedCue[], gapSeconds = 0): string {
  const lines = ['WEBVTT', ''];
  let cursor = 0;
  cues.forEach((cue, index) => {
    const start = cursor;
    const end = start + cue.durationSeconds;
    lines.push(String(index + 1));
    lines.push(`${formatTimestamp(start)} --> ${formatTimestamp(end)}`);
    lines.push(cue.text);
    lines.push('');
    cursor = end + gapSeconds;
  });
  return lines.join('\n');
}
