/**
 * The voice library, as the browser sees it.
 *
 * A voice is reference audio plus its exact transcript. The model stores
 * neither, so the library is entirely local — and selecting from it must fill
 * both halves at once, or it would simply be a nicer way to build the request
 * the vendor rejects.
 *
 * @module
 */

/** Where a voice came from, kept so the library stays legible. */
export interface VoiceOrigin {
  readonly kind: 'designed' | 'cloned';
  readonly instruction?: string;
  readonly seed?: number;
  readonly sourceClipId?: string;
  readonly sourceFilename?: string;
}

/** A stored voice, as `GET /api/voices` returns it. */
export interface Voice {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly transcript: string;
  readonly defaultDirection: string | null;
  readonly origin: VoiceOrigin;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  /** False when the gateway cannot find the audio; such a voice is unselectable. */
  readonly available: boolean;
}

/**
 * The origin line shown under each entry.
 *
 * @param voice - The voice.
 * @returns A short provenance description.
 */
export function originLine(voice: Voice): string {
  if (voice.origin.kind === 'designed') {
    const instruction = voice.origin.instruction?.trim();
    return instruction ? `DESIGNED / ${instruction.toUpperCase()}` : 'DESIGNED';
  }
  const from = voice.origin.sourceFilename ?? 'supplied audio';
  return `CLONED / FROM ${from.toUpperCase()}`;
}

/**
 * What the empty library should say.
 *
 * The option is present and explains itself rather than being hidden — a
 * missing affordance teaches nothing, and the operator needs to learn that
 * saving a clip is how voices get here.
 */
export const EMPTY_LIBRARY_COPY = 'No saved voices yet — saving a clip is how voices get here.';

/**
 * Whether a voice can be selected into a request.
 *
 * @param voice - The voice.
 * @returns True when its audio is present.
 */
export function isSelectable(voice: Voice): boolean {
  return voice.available;
}

/**
 * Both halves of the vendor's required pair, from one selection.
 *
 * @param voice - The selected voice.
 * @returns The reference id and the exact transcript, together.
 */
export function referenceFromVoice(voice: Voice): { voiceId: string; refText: string } {
  return { voiceId: voice.id, refText: voice.transcript };
}

/** A delete that has happened and can still be undone. */
export interface PendingUndo {
  readonly voice: Voice;
  readonly expiresAt: number;
}

/**
 * Apply a delete optimistically, keeping what is needed to undo it.
 *
 * Undo instead of "are you sure?" — the confirmation dialog shifts
 * responsibility to the operator for a decision the system can simply reverse.
 *
 * @param voices - The current list.
 * @param id - The voice being deleted.
 * @param now - Current epoch milliseconds.
 * @param undoWindowMs - How long the undo stays available.
 * @returns The remaining list and the pending undo, if any.
 */
export function applyDelete(
  voices: readonly Voice[],
  id: string,
  now: number,
  undoWindowMs = 30_000,
): { voices: Voice[]; undo: PendingUndo | null } {
  const target = voices.find((voice) => voice.id === id);
  return {
    voices: voices.filter((voice) => voice.id !== id),
    undo: target ? { voice: target, expiresAt: now + undoWindowMs } : null,
  };
}

/**
 * Put an undone voice back where it belongs.
 *
 * @param voices - The current list.
 * @param voice - The restored voice.
 * @returns The list with the voice reinstated in creation order.
 */
export function applyUndo(voices: readonly Voice[], voice: Voice): Voice[] {
  return [...voices, voice].sort((a, b) => b.createdAt - a.createdAt);
}
