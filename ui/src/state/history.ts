/**
 * Clip history: what was made, with what, and how to get back to it.
 *
 * History is backed by the gateway's clip cache rather than by browser
 * storage, so replay reaches no GPU, costs nothing, works while the container
 * is scaled to zero, and survives a reload without the browser holding audio.
 *
 * @module
 */

import type { VoiceMode } from './mode.js';

/** The request that produced a clip, as the gateway records it. */
export interface ClipRequestSummary {
  readonly text: string;
  readonly instruction: string;
  readonly mode: VoiceMode;
  readonly cfgScale: number;
  readonly seed: number;
  readonly refText?: string;
  readonly voiceId?: string;
  readonly voiceName?: string;
}

/** One entry in history. */
export interface Clip {
  readonly id: string;
  readonly createdAt: number;
  readonly bytes: number;
  readonly sampleRate: number;
  readonly durationSeconds: number;
  readonly ttfaMs: number | null;
  readonly transport: 'streaming' | 'buffered';
  readonly request: ClipRequestSummary;
}

/**
 * The one-line summary shown under each entry.
 *
 * Every setting that produced the clip is visible without opening anything,
 * because comparing two generations means comparing what differed between
 * them.
 *
 * @param clip - The clip.
 * @returns A compact settings line.
 */
export function settingsLine(clip: Clip): string {
  const parts = [
    clip.request.mode.toUpperCase(),
    `CFG ${clip.request.cfgScale}`,
    `SEED ${clip.request.seed}`,
  ];
  if (clip.request.voiceName) parts.push(clip.request.voiceName.toUpperCase());
  if (clip.ttfaMs != null) parts.push(`${Math.round(clip.ttfaMs)}MS`);
  return parts.join(' / ');
}

/**
 * Format a duration for display.
 *
 * @param seconds - Duration.
 * @returns `m:ss.s`.
 */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** Everything needed to put a clip's settings back into the console. */
export interface ConsoleRestore {
  readonly text: string;
  readonly instruction: string;
  readonly cfgScale: number;
  readonly seed: number;
  readonly mode: VoiceMode;
  readonly voiceId: string | undefined;
  readonly refText: string | undefined;
}

/**
 * Turn a clip back into console state, as the starting point for a variation.
 *
 * The seed is included: without it, a "variation" differs by both the setting
 * that was changed and the draw, which makes the comparison meaningless.
 *
 * @param clip - The clip to reload.
 * @returns Console fields, ready to apply.
 */
export function restoreFromClip(clip: Clip): ConsoleRestore {
  return {
    text: clip.request.text,
    instruction: clip.request.instruction,
    cfgScale: clip.request.cfgScale,
    seed: clip.request.seed,
    mode: clip.request.mode,
    voiceId: clip.request.voiceId,
    refText: clip.request.refText,
  };
}

/**
 * Turn a generated clip into reference audio for cloning.
 *
 * The model has no saved-voice primitive — no embedding, no voice id, and
 * `speaker` is only a text prefix token — so promoting a clip to a reference
 * is how a created voice actually persists. `ref_text` comes from the text
 * that produced the clip: the system already holds it, the vendor requires it
 * to be exact, and asking the operator to retype it would be asking for work
 * already done.
 *
 * @param clip - The clip to promote.
 * @returns The mode to switch to, the reference, and the transcript.
 */
export function promoteToReference(clip: Clip): {
  mode: VoiceMode;
  clipId: string;
  refText: string;
  referenceName: string;
} {
  return {
    // Never silently attach a reference the current mode cannot send.
    mode: 'clone',
    clipId: clip.id,
    refText: clip.request.text,
    referenceName: `${clip.request.text.slice(0, 32)}…`,
  };
}

/**
 * A filename for a saved clip, derived from the text that produced it.
 *
 * @param text - The source text.
 * @returns A safe slug.
 */
export function clipFilename(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'clip'}.wav`;
}
