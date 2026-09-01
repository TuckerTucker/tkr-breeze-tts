/**
 * The voice index: record shape, validation, naming, and the undo window.
 *
 * Kept free of filesystem access so the naming and delete-with-undo rules are
 * testable on their own. `voices.ts` owns the IO.
 *
 * @module
 */

/** Where a voice came from. */
export type VoiceOriginKind = 'designed' | 'cloned';

/** A voice's provenance, kept so a library stays legible months later. */
export interface VoiceOrigin {
  /** Designed from an instruction, or cloned from supplied audio. */
  readonly kind: VoiceOriginKind;
  /** The instruction that produced it, when it was designed. */
  readonly instruction?: string;
  /** The seed it was generated at, when it was designed. */
  readonly seed?: number;
  /** The clip it was promoted from, when it came from one. */
  readonly sourceClipId?: string;
  /** The uploaded filename, when it was cloned from a file. */
  readonly sourceFilename?: string;
}

/**
 * A stored voice.
 *
 * The model has no saved-voice primitive — no embedding, no voice id, and
 * `speaker` is only a text prefix token — so a voice can only persist as
 * reference audio plus its exact transcript. This record *is* the product's
 * answer to that gap.
 */
export interface VoiceRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The exact transcript of the reference audio. Never optional. */
  readonly transcript: string;
  /** A delivery instruction this voice defaults to, when it has one. */
  readonly defaultDirection: string | null;
  readonly origin: VoiceOrigin;
  /** Length of the stored WAV. */
  readonly bytes: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationSeconds: number;
  /**
   * When a delete was requested. The record stays readable through the undo
   * window, then goes for good. Undo instead of "are you sure?".
   */
  readonly deletedAt?: number;
}

/**
 * How long a deleted voice remains restorable.
 *
 * Long enough for the operator to notice and act, short enough that the store
 * is not quietly full of things they believe are gone.
 */
export const UNDO_WINDOW_MS = 30_000;

/**
 * Validate a parsed voice sidecar.
 *
 * @param value - A parsed sidecar, of unknown shape.
 * @returns The record when usable, otherwise null.
 */
export function validateVoice(value: unknown): VoiceRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) return null;
  // A voice without its transcript is a voice that can only produce the
  // half-formed pair the vendor rejects, so it is not a voice.
  if (typeof candidate.transcript !== 'string' || candidate.transcript.trim().length === 0) {
    return null;
  }
  if (typeof candidate.bytes !== 'number' || candidate.bytes <= 0) return null;
  if (typeof candidate.sampleRate !== 'number' || candidate.sampleRate <= 0) return null;

  const origin = candidate.origin as VoiceOrigin | undefined;
  const kind: VoiceOriginKind = origin?.kind === 'cloned' ? 'cloned' : 'designed';
  const channels = typeof candidate.channels === 'number' ? candidate.channels : 1;

  return {
    id: candidate.id,
    name: candidate.name,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
    transcript: candidate.transcript,
    defaultDirection:
      typeof candidate.defaultDirection === 'string' ? candidate.defaultDirection : null,
    origin: { ...(origin ?? {}), kind },
    bytes: candidate.bytes,
    sampleRate: candidate.sampleRate,
    channels,
    durationSeconds:
      typeof candidate.durationSeconds === 'number'
        ? candidate.durationSeconds
        : candidate.bytes / 2 / channels / candidate.sampleRate,
    ...(typeof candidate.deletedAt === 'number' ? { deletedAt: candidate.deletedAt } : {}),
  };
}

/**
 * Make a name unique without ever refusing one.
 *
 * The operator is naming, not keying. Blocking a duplicate mid-typing makes
 * them solve a problem the system can solve, so a suffix is appended instead.
 *
 * @param desired - The name as typed.
 * @param taken - Names already in use.
 * @returns A name that is not in `taken`.
 */
export function disambiguateName(desired: string, taken: Iterable<string>): string {
  const trimmed = desired.trim() || 'Untitled voice';
  const existing = new Set(taken);
  if (!existing.has(trimmed)) return trimmed;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${trimmed} ${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/**
 * Suggest a voice name from the instruction that produced the clip.
 *
 * Naming happens at the moment the operator decides they like a voice, not
 * later from memory — so the field arrives pre-filled and editable.
 *
 * @param instruction - The voice description.
 * @param fallback - Used when there is no instruction to draw on.
 * @returns A short, editable suggestion.
 */
export function suggestNameFromInstruction(
  instruction: string | undefined,
  fallback = 'New voice',
): string {
  const source = (instruction ?? '').trim();
  if (!source) return fallback;
  const firstClause = source.split(/[,.;]/)[0]?.trim() ?? source;
  const words = firstClause.split(/\s+/).slice(0, 5).join(' ');
  const cleaned = words.replace(/^(a|an|the)\s+/i, '');
  if (!cleaned) return fallback;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Split records into the ones still visible and the ones past their undo window.
 *
 * @param records - Every record on disk.
 * @param now - Current epoch milliseconds.
 * @returns Which to show, and which to purge for good.
 */
export function partitionByUndoWindow(
  records: readonly VoiceRecord[],
  now: number,
): { visible: VoiceRecord[]; purge: VoiceRecord[] } {
  const visible: VoiceRecord[] = [];
  const purge: VoiceRecord[] = [];
  for (const record of records) {
    if (record.deletedAt === undefined) visible.push(record);
    else if (now - record.deletedAt >= UNDO_WINDOW_MS) purge.push(record);
  }
  return { visible, purge };
}
