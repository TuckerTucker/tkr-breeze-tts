/**
 * Reference audio intake: detect, normalise, and enforce the pair rule.
 *
 * The browser's `MediaRecorder` produces WebM/Opus. The vendor reads reference
 * audio through `soundfile`, which does not decode WebM at all, so a recorded
 * reference forwarded as-is fails inside the model loader rather than here.
 * Absorbing that gap is exactly the kind of work the operator should never
 * see — `ffmpeg` is already on the machine.
 *
 * The both-or-neither rule is enforced locally, before the request leaves the
 * machine. The vendor enforces it too, but by then an incomplete pair has
 * already paid the full GPU wake, weight-load, and graph-capture cost.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Containers this gateway recognises. */
export type Container =
  | 'wav'
  | 'webm'
  | 'ogg'
  | 'mp3'
  | 'mp4'
  | 'flac'
  | 'aiff'
  | 'unknown';

/** What sniffing a file's leading bytes concluded. */
export interface DetectedAudio {
  /** The container, or `unknown` when nothing matched. */
  readonly container: Container;
  /** A human-readable type name, used verbatim in rejection messages. */
  readonly label: string;
  /** Whether this can be forwarded untouched. */
  readonly conforming: boolean;
}

/** Raised for any reference-audio problem the operator can act on. */
export class ReferenceError extends Error {
  /** Machine-readable kind, so the UI can render the right disabled state. */
  readonly kind:
    | 'unsupported-type'
    | 'empty'
    | 'transcode-failed'
    | 'ffmpeg-missing'
    | 'incomplete-pair';
  /** What to do about it, when there is something to do. */
  readonly remedy: string | undefined;

  constructor(kind: ReferenceError['kind'], message: string, remedy?: string) {
    super(message);
    this.name = 'ReferenceError';
    this.kind = kind;
    this.remedy = remedy;
  }
}

/** Target format for every normalised reference. */
export const TARGET_SAMPLE_RATE = 24_000;

function startsWith(buffer: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

/**
 * Whether a WAV is one the vendor can read without a round trip through ffmpeg.
 *
 * Conforming means uncompressed PCM. A `.wav` carrying an ADPCM or MP3 payload
 * is a WAV by extension only, and forwarding it would fail inside the loader.
 *
 * @param buffer - The file's bytes.
 * @returns Whether it can be forwarded untouched.
 */
export function isConformingWav(buffer: Buffer): boolean {
  if (buffer.length < 44) return false;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return false;
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') return false;
  const formatTag = buffer.readUInt16LE(20);
  const bitsPerSample = buffer.readUInt16LE(34);
  const isPcm = formatTag === 1;
  const isFloat = formatTag === 3;
  return (isPcm && [16, 24, 32].includes(bitsPerSample)) || (isFloat && bitsPerSample === 32);
}

/**
 * Identify a file from its leading bytes.
 *
 * Sniffed rather than trusted from the filename or the browser's declared
 * MIME type, because a rejection that names the *detected* type tells the
 * operator something they did not already know.
 *
 * @param buffer - The file's bytes.
 * @returns What it appears to be.
 */
export function detectAudio(buffer: Buffer): DetectedAudio {
  if (buffer.length === 0) {
    return { container: 'unknown', label: 'an empty file', conforming: false };
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
    return {
      container: 'wav',
      label: 'WAV',
      conforming: isConformingWav(buffer),
    };
  }
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { container: 'webm', label: 'WebM/Matroska', conforming: false };
  }
  if (buffer.toString('ascii', 0, 4) === 'OggS') {
    return { container: 'ogg', label: 'Ogg', conforming: false };
  }
  if (buffer.toString('ascii', 0, 4) === 'fLaC') {
    return { container: 'flac', label: 'FLAC', conforming: false };
  }
  if (buffer.toString('ascii', 0, 4) === 'FORM' && buffer.toString('ascii', 8, 12).startsWith('AIF')) {
    return { container: 'aiff', label: 'AIFF', conforming: false };
  }
  if (buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    return { container: 'mp4', label: 'MP4/M4A', conforming: false };
  }
  if (buffer.toString('ascii', 0, 3) === 'ID3') {
    return { container: 'mp3', label: 'MP3', conforming: false };
  }
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  if (first === 0xff && (second & 0xe0) === 0xe0) {
    return { container: 'mp3', label: 'MP3', conforming: false };
  }
  return { container: 'unknown', label: 'not a recognised audio file', conforming: false };
}

/** The outcome of looking for ffmpeg at startup. */
export interface FfmpegStatus {
  /** Whether a usable ffmpeg was found. */
  readonly available: boolean;
  /** Its version banner, when found. */
  readonly version: string | null;
  /** The install command, when it was not. */
  readonly remedy: string | null;
}

/** The one command that fixes a missing ffmpeg on the target machine. */
export const FFMPEG_INSTALL_REMEDY = 'brew install ffmpeg — then restart the gateway';

/**
 * Look for ffmpeg once, at startup.
 *
 * Reported at startup rather than at first use, so the operator learns about
 * it while nothing is at stake, and the UI can disable microphone capture with
 * the reason shown instead of accepting a recording it cannot convert.
 *
 * @param ffmpegPath - Binary to probe.
 * @returns What was found.
 */
export async function checkFfmpeg(ffmpegPath = 'ffmpeg'): Promise<FfmpegStatus> {
  try {
    const { stdout } = await run(ffmpegPath, ['-version'], { timeout: 10_000 });
    const version = stdout.split('\n')[0]?.trim() ?? null;
    return { available: true, version, remedy: null };
  } catch {
    return { available: false, version: null, remedy: FFMPEG_INSTALL_REMEDY };
  }
}

/**
 * Enforce the vendor's both-or-neither rule before the request leaves.
 *
 * @param input - Whether reference audio is present, and the transcript given.
 * @throws {ReferenceError} Naming which half is missing.
 */
export function validateReferencePair(input: {
  hasAudio: boolean;
  refText: string | undefined;
}): void {
  const hasText = Boolean(input.refText && input.refText.trim().length > 0);
  if (input.hasAudio === hasText) return;
  throw new ReferenceError(
    'incomplete-pair',
    input.hasAudio
      ? 'reference audio was supplied without its transcript'
      : 'a reference transcript was supplied without any reference audio',
    input.hasAudio
      ? 'The model needs the exact transcript of the reference recording.'
      : 'Attach the reference recording the transcript belongs to.',
  );
}

/** Options for a normalisation run. */
export interface NormaliseOptions {
  /** Binary to invoke. */
  readonly ffmpegPath?: string;
  /** Where temporary files go. */
  readonly tmpRoot?: string;
  /** Whether ffmpeg is known to be present. */
  readonly ffmpegAvailable?: boolean;
}

/**
 * Normalise reference audio to a WAV the vendor can read.
 *
 * An already-conforming WAV is returned untouched — a needless re-encode is a
 * generation loss for no gain. Everything else is converted to mono 24 kHz
 * 16-bit PCM, matching the model's own rate.
 *
 * Temporary files are removed on both the success and the failure path.
 *
 * @param buffer - The uploaded or recorded bytes.
 * @param options - Binary path, temp root, and ffmpeg availability.
 * @returns A WAV payload.
 * @throws {ReferenceError} For an empty upload, an unrecognised type, a
 *   missing ffmpeg, or a transcode failure — each naming what went wrong.
 */
export async function normaliseReference(
  buffer: Buffer,
  options: NormaliseOptions = {},
): Promise<Buffer> {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';

  if (buffer.length === 0) {
    throw new ReferenceError('empty', 'the reference file is empty');
  }

  const detected = detectAudio(buffer);
  if (detected.container === 'unknown') {
    throw new ReferenceError(
      'unsupported-type',
      `the reference file is ${detected.label}`,
      'Supply a WAV, MP3, M4A, OGG, FLAC or a browser recording.',
    );
  }
  if (detected.conforming) return buffer;

  if (options.ffmpegAvailable === false) {
    throw new ReferenceError(
      'ffmpeg-missing',
      `${detected.label} needs converting before the model can read it, but ffmpeg is not installed`,
      FFMPEG_INSTALL_REMEDY,
    );
  }

  const workdir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), 'breeze-ref-'));
  const input = join(workdir, `input.${detected.container}`);
  const output = join(workdir, 'reference.wav');
  try {
    await writeFile(input, buffer);
    await run(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', input,
        '-ac', '1',
        '-ar', String(TARGET_SAMPLE_RATE),
        '-c:a', 'pcm_s16le',
        '-f', 'wav',
        output,
      ],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return await readFile(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n').slice(-3).join(' ').trim() : String(error);
    if (detail.includes('ENOENT')) {
      throw new ReferenceError(
        'ffmpeg-missing',
        'ffmpeg is not installed, so recorded audio cannot be converted',
        FFMPEG_INSTALL_REMEDY,
      );
    }
    throw new ReferenceError(
      'transcode-failed',
      `the ${detected.label} reference could not be decoded: ${detail}`,
      'Try a different recording, or export it as WAV first.',
    );
  } finally {
    // Both paths. A demo that leaks a temp file per reference is a demo that
    // fills a disk over a weekend.
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
