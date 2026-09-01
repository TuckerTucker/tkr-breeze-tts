/**
 * The two playback transports, and the WAV framing they share.
 *
 * `streaming` pipes the upstream PCM through untouched; `buffered` reads it to
 * completion and prepends a WAV header. The request contract the browser uses
 * is identical either way, so the switch is invisible to the caller.
 *
 * Both the header and the framing take sample rate and format from the
 * upstream `X-Sample-Rate` / `X-Sample-Format` response headers. Hardcoding
 * 24000 and s16le a second time is exactly how the two paths would drift, and
 * a wrong rate does not fail — it plays at the wrong speed, which is worse.
 *
 * @module
 */

/** A parsed upstream audio format. */
export interface AudioFormat {
  /** Frames per second, from `X-Sample-Rate`. */
  readonly sampleRate: number;
  /** Sample encoding, from `X-Sample-Format`. */
  readonly format: 's16le';
  /** Channel count. The vendor emits mono. */
  readonly channels: number;
  /** Bytes per sample per channel. */
  readonly bytesPerSample: number;
}

/** Raised when the upstream format cannot be trusted. */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

/** The only encoding the vendor emits, and the only one this can frame. */
export const SUPPORTED_FORMAT = 's16le';

/**
 * Plausible bounds for a sample rate. Outside these, a header is corrupt
 * rather than unusual, and silently accepting it would produce audio that
 * plays at the wrong speed instead of failing.
 */
export const MIN_SAMPLE_RATE = 8_000;
export const MAX_SAMPLE_RATE = 192_000;

/** A minimal header bag, so this works against `fetch` and against a test double. */
export interface HeaderSource {
  get(name: string): string | null;
}

/**
 * Read and validate the upstream audio format.
 *
 * @param headers - Upstream response headers.
 * @returns The parsed format.
 * @throws {FormatError} When a header is absent, unparseable, or out of range.
 *   Failing loudly is deliberate: assuming a rate produces audio at the wrong
 *   speed, which reads as a broken model rather than a broken header.
 */
export function parseAudioFormat(headers: HeaderSource): AudioFormat {
  const rawRate = headers.get('x-sample-rate');
  const rawFormat = headers.get('x-sample-format');

  if (!rawRate) {
    throw new FormatError(
      'upstream response carried no X-Sample-Rate header; refusing to assume a rate',
    );
  }
  if (!rawFormat) {
    throw new FormatError(
      'upstream response carried no X-Sample-Format header; refusing to assume an encoding',
    );
  }

  const sampleRate = Number(rawRate);
  if (!Number.isInteger(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new FormatError(
      `upstream X-Sample-Rate ${JSON.stringify(rawRate)} is not a plausible sample rate ` +
        `(${MIN_SAMPLE_RATE}-${MAX_SAMPLE_RATE})`,
    );
  }
  if (rawFormat.toLowerCase() !== SUPPORTED_FORMAT) {
    throw new FormatError(
      `upstream X-Sample-Format ${JSON.stringify(rawFormat)} is not supported; expected ${SUPPORTED_FORMAT}`,
    );
  }

  return { sampleRate, format: SUPPORTED_FORMAT, channels: 1, bytesPerSample: 2 };
}

/**
 * Build a 44-byte canonical WAV header.
 *
 * @param format - The audio format, taken from upstream.
 * @param dataBytes - Length of the PCM payload that follows.
 * @returns The header.
 */
export function wavHeader(format: AudioFormat, dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = format.channels * format.bytesPerSample;
  const byteRate = format.sampleRate * blockAlign;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(format.bytesPerSample * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * Frame raw PCM as a complete WAV file.
 *
 * Framing happens at read, never at write: the cache holds exactly one on-disk
 * format regardless of which transport produced a clip, so a clip generated
 * while streaming is interchangeable with one generated buffered.
 *
 * @param pcm - Raw PCM payload.
 * @param format - The format it was captured in.
 * @returns A complete WAV file.
 */
export function frameWav(pcm: Buffer, format: AudioFormat): Buffer {
  return Buffer.concat([wavHeader(format, pcm.length), pcm]);
}

/**
 * Read a WAV header back, for verification.
 *
 * @param wav - A WAV file.
 * @returns The format and payload length it declares.
 * @throws {FormatError} If the file is not a PCM WAV.
 */
export function readWavHeader(wav: Buffer): AudioFormat & { dataBytes: number } {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new FormatError('not a RIFF/WAVE file');
  }
  const audioFormat = wav.readUInt16LE(20);
  if (audioFormat !== 1) throw new FormatError(`not PCM (format tag ${audioFormat})`);
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  return {
    sampleRate,
    format: SUPPORTED_FORMAT,
    channels,
    bytesPerSample: bits / 8,
    dataBytes: wav.readUInt32LE(40),
  };
}

/**
 * Derive audio duration from a PCM byte count.
 *
 * Exact, not estimated: `bytes / bytesPerSample / channels / sampleRate`. The
 * script runner's drift figures and the UI's clip lengths are both this
 * number, so an estimate here would make every timing downstream an estimate.
 *
 * @param pcmBytes - Raw PCM length.
 * @param format - The format it was captured in.
 * @returns Duration in seconds.
 */
export function durationSeconds(pcmBytes: number, format: AudioFormat): number {
  return pcmBytes / format.bytesPerSample / format.channels / format.sampleRate;
}
