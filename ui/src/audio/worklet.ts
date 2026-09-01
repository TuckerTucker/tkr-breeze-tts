/**
 * Format conversion and worklet plumbing.
 *
 * Kept separate from `player.ts` so the conversion — the part with an exact,
 * checkable answer — is testable without an AudioContext.
 *
 * @module
 */

/** Full scale for signed 16-bit samples. */
export const INT16_SCALE = 32768;

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

/**
 * Split a byte stream on sample boundaries.
 *
 * Chunks arrive at arbitrary lengths, and a chunk ending mid-sample would
 * produce a click at every boundary if the odd byte were dropped or misread.
 * The remainder is carried into the next chunk instead.
 *
 * @param carry - Leftover bytes from the previous chunk.
 * @param chunk - The newly arrived bytes.
 * @returns Whole samples to play, and the remainder to carry.
 */
export function alignSamples(
  carry: Uint8Array,
  chunk: Uint8Array,
): { samples: Float32Array; carry: Uint8Array<ArrayBuffer> } {
  const combined = new Uint8Array(carry.byteLength + chunk.byteLength);
  combined.set(carry, 0);
  combined.set(chunk, carry.byteLength);

  const usable = combined.byteLength - (combined.byteLength % 2);
  return {
    samples: s16leToFloat32(combined.subarray(0, usable)),
    carry: combined.slice(usable),
  };
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
