/**
 * Format conversion and worklet plumbing.
 *
 * Kept separate from `player.ts` so the conversion — the part with an exact,
 * checkable answer — is testable without an AudioContext.
 *
 * The transport declaration is parsed here too, for the same reason: refusing a
 * rate the browser cannot honour is a rule with one right answer, and a rule
 * that only runs inside a live audio graph is a rule nobody checks. The gateway
 * applies the same rule to its own upstream in `gateway/src/transport.ts`; this
 * is the browser end of that contract, not a second opinion about it.
 *
 * @module
 */

/** Full scale for signed 16-bit samples. */
export const INT16_SCALE = 32768;

/**
 * The only encoding this client can convert.
 *
 * It matches the gateway's `SUPPORTED_FORMAT` because the gateway refuses to
 * relay anything else — so a differently declared format means the contract
 * moved, and guessing at it would produce noise rather than a diagnosis.
 */
const SUPPORTED_SAMPLE_FORMAT = 's16le';

/**
 * Plausible bounds for a declared sample rate.
 *
 * Outside these a header is corrupt rather than unusual. Accepting it would not
 * fail — it would play at the wrong speed, which sounds like a broken model
 * rather than a broken header.
 */
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 192_000;

/**
 * Raised when the response describes audio this client cannot play.
 *
 * Distinct from a generation failure on purpose: the operator needs to know the
 * declaration was unusable, not that "speech could not be generated".
 */
export class TransportDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportDeclarationError';
  }
}

/** A minimal header bag, so this works against `fetch` and against a test double. */
export interface HeaderSource {
  get(name: string): string | null;
}

/** How raw upstream bytes become the float32 samples the worklet plays. */
export interface SampleConverter {
  /** The encoding this converter was selected for, as the service declared it. */
  readonly format: string;
  /** Bytes per sample per channel; what a sample boundary is measured in. */
  readonly bytesPerSample: number;
  /**
   * Convert whole samples.
   *
   * @param bytes - Raw bytes, a whole number of samples long.
   * @returns The converted samples.
   */
  toFloat32(bytes: Uint8Array): Float32Array;
}

/** What the response declared, once it has been found usable. */
export interface DeclaredTransport {
  /** Frames per second, from `X-Sample-Rate`. */
  readonly sampleRate: number;
  /** The conversion selected by `X-Sample-Format`. */
  readonly converter: SampleConverter;
}

/**
 * Convert little-endian signed 16-bit PCM to float32 in [-1, 1).
 *
 * Dividing by 32768 rather than 32767 is deliberate: it makes the mapping
 * exact for the negative full-scale sample, so no value can clip on the way
 * in.
 *
 * @param bytes - Raw s16le bytes. An odd trailing byte is left for the next
 *   chunk by the caller, since half a sample is not a sample.
 * @returns The converted samples.
 */
export function s16leToFloat32(bytes: Uint8Array): Float32Array {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    out[i] = view.getInt16(i * 2, true) / INT16_SCALE;
  }
  return out;
}

/** The conversion for the one encoding the service emits. */
export const S16LE_CONVERTER: SampleConverter = {
  format: SUPPORTED_SAMPLE_FORMAT,
  bytesPerSample: 2,
  toFloat32: s16leToFloat32,
};

/**
 * Select the conversion for a declared encoding.
 *
 * Refusal is the honest answer for an encoding this client cannot convert:
 * reading s24le or f32le bytes as s16le yields sound, and sound that is wrong
 * is harder to diagnose than an error that names the format.
 *
 * @param declared - The value of `X-Sample-Format`.
 * @returns The matching converter.
 * @throws {TransportDeclarationError} When nothing here converts that encoding.
 */
export function converterFor(declared: string): SampleConverter {
  if (declared.trim().toLowerCase() !== SUPPORTED_SAMPLE_FORMAT) {
    return raise(
      `the service declared sample format ${JSON.stringify(declared)}, ` +
        `which this browser cannot convert; expected ${SUPPORTED_SAMPLE_FORMAT}`,
    );
  }
  return S16LE_CONVERTER;
}

/**
 * Read the rate and encoding the response declared.
 *
 * Nothing here defaults. The rate is named once, by the service that generated
 * the audio, and a client-side fallback would only ever be right by luck —
 * which is why a wrong rate is worse than no rate.
 *
 * @param headers - The response headers.
 * @returns The declared transport.
 * @throws {TransportDeclarationError} When a header is absent, unparseable, out
 *   of range, or names an encoding this client cannot convert.
 */
export function parseDeclaredTransport(headers: HeaderSource): DeclaredTransport {
  const rawRate = headers.get('x-sample-rate');
  const rawFormat = headers.get('x-sample-format');

  if (!rawRate) {
    return raise('the service declared no sample rate, so its audio cannot be played at the right speed');
  }
  if (!rawFormat) {
    return raise('the service declared no sample format, so its audio cannot be converted');
  }

  const sampleRate = Number(rawRate);
  if (!Number.isInteger(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    return raise(
      `the service declared sample rate ${JSON.stringify(rawRate)}, which is not a playable rate ` +
        `(${MIN_SAMPLE_RATE}-${MAX_SAMPLE_RATE})`,
    );
  }

  return { sampleRate, converter: converterFor(rawFormat) };
}

/**
 * Split a byte stream on sample boundaries.
 *
 * Chunks arrive at arbitrary lengths, and a chunk ending mid-sample would
 * produce a click at every boundary if the odd byte were dropped or misread.
 * The remainder is carried into the next chunk instead.
 *
 * The converter is passed rather than assumed so the boundary and the
 * conversion can never disagree about how wide a sample is.
 *
 * @param carry - Leftover bytes from the previous chunk.
 * @param chunk - The newly arrived bytes.
 * @param converter - The conversion the service's declaration selected.
 * @returns Whole samples to play, and the remainder to carry.
 */
export function alignSamples(
  carry: Uint8Array,
  chunk: Uint8Array,
  converter: SampleConverter,
): { samples: Float32Array; carry: Uint8Array<ArrayBuffer> } {
  const combined = new Uint8Array(carry.byteLength + chunk.byteLength);
  combined.set(carry, 0);
  combined.set(chunk, carry.byteLength);

  const usable = combined.byteLength - (combined.byteLength % converter.bytesPerSample);
  return {
    samples: converter.toFloat32(combined.subarray(0, usable)),
    carry: combined.slice(usable),
  };
}

/**
 * Wrap raw PCM in a canonical 44-byte WAV header.
 *
 * The buffered path plays through an `<audio>` element, which decodes
 * containers and not bare samples. Handing it unframed PCM labelled
 * `audio/wav` is silence with a content type on it — so the fallback the
 * player promises has to build the container the element is waiting for, using
 * the rate the service declared rather than a remembered one.
 *
 * @param pcm - The raw samples exactly as they arrived.
 * @param transport - The declared rate and encoding.
 * @returns A complete WAV file.
 */
export function wavFromPcm(
  pcm: Uint8Array,
  transport: DeclaredTransport,
): Uint8Array<ArrayBuffer> {
  const channels = 1; // The vendor emits mono; the worklet plays one channel.
  const { bytesPerSample } = transport.converter;
  const blockAlign = channels * bytesPerSample;
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format: integer PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, transport.sampleRate, true);
  view.setUint32(28, transport.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** The messages the processor sends back. */
export type WorkletMessage =
  | { type: 'started' }
  | { type: 'drained' }
  | { type: 'underrun' };

/**
 * Load the processor module into an AudioContext.
 *
 * @param context - The context to load into.
 * @param moduleUrl - URL of the processor module.
 * @returns Whether the worklet is usable. A false result is not fatal: the
 *   player falls back to buffered playback, so the operator gets audio rather
 *   than silence.
 */
export async function loadPcmWorklet(
  context: AudioContext,
  moduleUrl: string,
): Promise<boolean> {
  if (typeof context.audioWorklet?.addModule !== 'function') return false;
  try {
    await context.audioWorklet.addModule(moduleUrl);
    return true;
  } catch {
    return false;
  }
}

/** Throw as an expression, so each refusal reads as one statement. */
function raise(message: string): never {
  throw new TransportDeclarationError(message);
}
