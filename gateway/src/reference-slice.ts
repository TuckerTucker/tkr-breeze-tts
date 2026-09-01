/**
 * Pure reference-audio transforms.
 *
 * Waveform reduction and transcript slicing deliberately have no filesystem or
 * HTTP dependency. The gateway and the UI both need these rules to be
 * deterministic: a word may only be named by a transcript window when the
 * corresponding audio window contains that word in full.
 *
 * @module
 */

/** A word and the exact interval occupied by its audio. */
export interface TimedWord {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/** PCM encodings accepted by the existing reference intake. */
export type PcmSampleFormat = 's16le' | 's24le' | 's32le' | 'f32le';

/** The format required to interpret a headerless PCM payload. */
export interface PcmFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bytesPerSample: 2 | 3 | 4;
  readonly format: PcmSampleFormat;
}

/** A WAV separated into the PCM and the format that describes it. */
export interface ParsedWav {
  readonly pcm: Buffer;
  readonly format: PcmFormat;
  readonly durationSeconds: number;
}

/** A transcript and the word-safe audio interval it describes. */
export interface TranscriptSlice {
  readonly start: number;
  readonly end: number;
  readonly transcript: string;
  readonly words: readonly TimedWord[];
}

/** The measured reference limits recorded by the benchmark. */
export interface ReferenceCeiling {
  readonly maxReferenceSeconds: number;
  readonly ceilingByBranchMode: {
    readonly noCfg: number;
    readonly singleCfg: number;
  };
}

const OPENING_PUNCTUATION = /[([{“‘「『《〈【〔]$/u;
const CLOSING_PUNCTUATION = /^[,.;:!?，。；：！？、…'’”」』》〉】〕)\]}]/u;
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2ebef}]/u;

/**
 * Parse the PCM payload and format from a RIFF/WAVE file.
 *
 * Chunks are walked instead of assuming the canonical 44-byte layout. The
 * intake intentionally passes already-readable WAV files through untouched,
 * and such files are allowed to carry metadata before their data chunk.
 *
 * @param wav - Complete WAV bytes.
 * @returns The PCM, its actual format, and its exact frame-derived duration.
 * @throws {Error} When the file is not supported uncompressed PCM.
 */
export function parseWavPcm(wav: Buffer): ParsedWav {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a RIFF/WAVE file');
  }

  let offset = 12;
  let formatTag: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let pcm: Buffer | null = null;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const declaredSize = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + declaredSize;
    if (dataEnd > wav.length) throw new Error(`WAV ${chunkId} chunk is truncated`);

    if (chunkId === 'fmt ') {
      if (declaredSize < 16) throw new Error('WAV fmt chunk is too short');
      formatTag = wav.readUInt16LE(dataStart);
      channels = wav.readUInt16LE(dataStart + 2);
      sampleRate = wav.readUInt32LE(dataStart + 4);
      bitsPerSample = wav.readUInt16LE(dataStart + 14);
    } else if (chunkId === 'data' && pcm === null) {
      pcm = wav.subarray(dataStart, dataEnd);
    }

    offset = dataEnd + (declaredSize % 2);
  }

  if (
    formatTag === null ||
    channels === null ||
    sampleRate === null ||
    bitsPerSample === null ||
    pcm === null
  ) {
    throw new Error('WAV is missing its fmt or data chunk');
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error(`WAV channel count ${channels} is invalid`);
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`WAV sample rate ${sampleRate} is invalid`);
  }

  let format: PcmSampleFormat;
  if (formatTag === 1 && bitsPerSample === 16) format = 's16le';
  else if (formatTag === 1 && bitsPerSample === 24) format = 's24le';
  else if (formatTag === 1 && bitsPerSample === 32) format = 's32le';
  else if (formatTag === 3 && bitsPerSample === 32) format = 'f32le';
  else {
    throw new Error(
      `WAV format tag ${formatTag} with ${bitsPerSample}-bit samples is unsupported`,
    );
  }

  const bytesPerSample = (bitsPerSample / 8) as 2 | 3 | 4;
  const bytesPerFrame = bytesPerSample * channels;
  if (pcm.length % bytesPerFrame !== 0) {
    throw new Error('WAV data does not contain a whole number of audio frames');
  }
  const frames = pcm.length / bytesPerFrame;
  return {
    pcm,
    format: { sampleRate, channels, bytesPerSample, format },
    durationSeconds: frames / sampleRate,
  };
}

function sampleMagnitude(pcm: Buffer, offset: number, format: PcmFormat): number {
  switch (format.format) {
    case 's16le':
      return Math.min(1, Math.abs(pcm.readInt16LE(offset)) / 32_768);
    case 's24le':
      return Math.min(1, Math.abs(pcm.readIntLE(offset, 3)) / 8_388_608);
    case 's32le':
      return Math.min(1, Math.abs(pcm.readInt32LE(offset)) / 2_147_483_648);
    case 'f32le': {
      const value = pcm.readFloatLE(offset);
      return Number.isFinite(value) ? Math.min(1, Math.abs(value)) : 0;
    }
  }
}

/**
 * Reduce PCM to one absolute peak per display bucket.
 *
 * Every channel participates and every frame belongs to exactly one bucket.
 * The returned values are normalised to the inclusive range zero to one.
 *
 * @param pcm - Headerless interleaved PCM.
 * @param format - The PCM's actual sample format.
 * @param buckets - Number of peaks to return.
 * @returns Exactly `buckets` normalised peak values.
 */
export function peaksFrom(
  pcm: Buffer,
  format: PcmFormat,
  buckets: number,
): number[] {
  if (!Number.isInteger(buckets) || buckets <= 0) {
    throw new RangeError(`buckets must be a positive integer, got ${buckets}`);
  }
  const bytesPerFrame = format.bytesPerSample * format.channels;
  if (pcm.length % bytesPerFrame !== 0) {
    throw new RangeError('PCM does not contain a whole number of audio frames');
  }
  const frames = pcm.length / bytesPerFrame;
  if (frames === 0) return Array.from({ length: buckets }, () => 0);

  const peaks: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const firstFrame = Math.floor((bucket * frames) / buckets);
    const exclusiveEnd = Math.floor(((bucket + 1) * frames) / buckets);
    let peak = 0;
    for (let frame = firstFrame; frame < exclusiveEnd; frame += 1) {
      for (let channel = 0; channel < format.channels; channel += 1) {
        const offset =
          frame * bytesPerFrame + channel * format.bytesPerSample;
        peak = Math.max(peak, sampleMagnitude(pcm, offset, format));
      }
    }
    peaks.push(peak);
  }
  return peaks;
}

function nearest(values: readonly number[], target: number): number {
  return values.reduce((best, value) => {
    const distance = Math.abs(value - target);
    const bestDistance = Math.abs(best - target);
    return distance < bestDistance || (distance === bestDistance && value < best)
      ? value
      : best;
  });
}

function joinWords(words: readonly TimedWord[]): string {
  if (words.length === 0) return '';
  // faster-whisper preserves leading spaces in word tokens. When they exist,
  // concatenation exactly reconstructs its transcript, including CJK text.
  if (words.some(({ word }) => /^\s|\s$/u.test(word))) {
    return words.map(({ word }) => word).join('').trim();
  }

  let transcript = '';
  for (const { word: raw } of words) {
    const word = raw.trim();
    if (!word) continue;
    if (!transcript) {
      transcript = word;
      continue;
    }
    const previous = transcript.at(-1) ?? '';
    const needsSpace =
      !CLOSING_PUNCTUATION.test(word) &&
      !OPENING_PUNCTUATION.test(previous) &&
      !(CJK.test(previous) && CJK.test(word.at(0) ?? ''));
    transcript += `${needsSpace ? ' ' : ''}${word}`;
  }
  return transcript;
}

/**
 * Snap a requested interval to word boundaries and derive its transcript.
 *
 * Start handles settle on word starts and end handles on word ends. If two
 * independently nearest boundaries would cross in a silence gap, the closest
 * word is selected in full. The final containment filter is the invariant:
 * the transcript never claims a word not fully present in the returned audio
 * interval.
 *
 * @param words - Timed words from the one intake transcription.
 * @param start - Requested start in seconds.
 * @param end - Requested end in seconds.
 * @returns The snapped interval, contained words, and reconstructed text.
 */
export function sliceTranscript(
  words: readonly TimedWord[],
  start: number,
  end: number,
): TranscriptSlice {
  const ordered = [...words]
    .filter(
      ({ word, start: wordStart, end: wordEnd }) =>
        word.trim().length > 0 &&
        Number.isFinite(wordStart) &&
        Number.isFinite(wordEnd) &&
        wordStart >= 0 &&
        wordEnd >= wordStart,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (ordered.length === 0) {
    return { start, end, transcript: '', words: [] };
  }

  let snappedStart = nearest(ordered.map((word) => word.start), start);
  let snappedEnd = nearest(ordered.map((word) => word.end), end);
  if (snappedStart >= snappedEnd) {
    const midpoint = (start + end) / 2;
    const closest = ordered.reduce((best, word) => {
      const centre = (word.start + word.end) / 2;
      const bestCentre = (best.start + best.end) / 2;
      return Math.abs(centre - midpoint) < Math.abs(bestCentre - midpoint)
        ? word
        : best;
    });
    snappedStart = closest.start;
    snappedEnd = closest.end;
  }

  const contained = ordered.filter(
    (word) => word.start >= snappedStart && word.end <= snappedEnd,
  );
  return {
    start: snappedStart,
    end: snappedEnd,
    transcript: joinWords(contained),
    words: contained,
  };
}

/**
 * Validate and reshape a recorded reference-ceiling finding.
 *
 * @param value - Parsed JSON from `reference-ceiling.json`.
 * @returns A usable measured ceiling, or null for missing/malformed data.
 */
export function parseReferenceCeiling(value: unknown): ReferenceCeiling | null {
  if (typeof value !== 'object' || value === null) return null;
  const finding = value as Record<string, unknown>;
  const modes = finding.ceiling_by_branch_mode;
  if (typeof modes !== 'object' || modes === null) return null;
  const branchModes = modes as Record<string, unknown>;
  const maxReferenceSeconds = finding.max_reference_seconds;
  const noCfg = branchModes.no_cfg;
  const singleCfg = branchModes.single_cfg;
  if (
    typeof maxReferenceSeconds !== 'number' ||
    !Number.isFinite(maxReferenceSeconds) ||
    maxReferenceSeconds <= 0 ||
    typeof noCfg !== 'number' ||
    !Number.isFinite(noCfg) ||
    noCfg <= 0 ||
    typeof singleCfg !== 'number' ||
    !Number.isFinite(singleCfg) ||
    singleCfg <= 0
  ) {
    return null;
  }
  return {
    maxReferenceSeconds,
    ceilingByBranchMode: { noCfg, singleCfg },
  };
}

/**
 * Select the measured audio ceiling for the branch configuration in use.
 *
 * @param ceiling - Parsed measurement.
 * @param cfgScale - CFG 1.0 is unbranched; every other value is single-CFG.
 * @returns Maximum reference seconds for this request.
 */
export function referenceSecondsFor(
  ceiling: ReferenceCeiling,
  cfgScale: number,
): number {
  return cfgScale === 1.0
    ? ceiling.ceilingByBranchMode.noCfg
    : ceiling.ceilingByBranchMode.singleCfg;
}
