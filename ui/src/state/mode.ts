/**
 * The three voice modes, and what each one needs.
 *
 * Design, Clone and Direction are not three features — they are two request
 * shapes and one dial. Design sends an instruction alone. Clone and Direction
 * send the *same* request: reference audio, its exact transcript, and an
 * instruction. `cfg_scale` is the only thing separating them, which is why it
 * is present in all three modes rather than only in Direction.
 *
 * @module
 */

import type { StagedReferenceSelection } from './reference.js';

/** How the operator is specifying the voice. */
export type VoiceMode = 'design' | 'clone' | 'direction';

/** Where the reference audio came from. Three peer options, not a fallback chain. */
export type ReferenceSource = 'upload' | 'record' | 'library';

/** A saved voice supplies a durable audio/transcript pair server-side. */
export interface LibraryReference {
  readonly source: 'library';
  readonly voiceId: string;
  readonly name: string;
  readonly durationSeconds: number;
  readonly transcript: string;
}

/** An upload or recording staged once, then addressed and trimmed by id. */
export type StagedReference = StagedReferenceSelection & {
  readonly source: Exclude<ReferenceSource, 'library'>;
};

/** A valid reference attached to the console. */
export type Reference = LibraryReference | StagedReference;

/** The mode-dependent half of the console's state. */
export interface ModeState {
  mode: VoiceMode;
  reference: Reference | null;
  /** How the line should be delivered, in Direction. */
  direction: string;
  cfgScale: number;
}

/** The starting mode state. */
export const INITIAL_MODE: ModeState = {
  mode: 'design',
  reference: null,
  direction: '',
  cfgScale: 1.0,
};

/** One line of in-place explanation per mode — never a help modal. */
export const MODE_BLURB: Record<VoiceMode, string> = {
  design: 'Describe a voice in words. No reference audio needed.',
  clone: 'Clone from reference audio. The transcript must be exact.',
  direction: 'Clone a voice, then steer how it delivers the line.',
};

/** What the CFG dial means in each mode. It is never absent. */
export const CFG_LABEL: Record<VoiceMode, string> = {
  design: 'Instruction strength',
  clone: 'Instruction strength — 1.0 keeps the reference voice',
  direction: 'Balance — 1.0 keeps the reference voice, 4.0 follows the direction',
};

/** Modes that carry a reference, and so reveal the transcript field with it. */
export const REFERENCE_MODES: readonly VoiceMode[] = ['clone', 'direction'];

/**
 * Whether this mode needs reference audio.
 *
 * @param mode - The current mode.
 * @returns True for clone and direction.
 */
export function needsReference(mode: VoiceMode): boolean {
  return REFERENCE_MODES.includes(mode);
}

/**
 * What the current mode is still missing, or null when it is complete.
 *
 * The reference and its transcript are revealed together and validated
 * together, mirroring the vendor's both-or-neither rule, so the invalid state
 * cannot be expressed in the first place — and an incomplete pair never wakes
 * a GPU.
 *
 * @param state - The mode state.
 * @returns A reason naming the missing half, or null.
 */
export function modeBlocker(state: ModeState): string | null {
  if (!needsReference(state.mode)) return null;
  const hasReference = state.reference !== null;
  const hasTranscript = (state.reference?.transcript ?? '').trim().length > 0;

  if (!hasReference) {
    return 'Add a reference voice and its exact transcript.';
  }
  if (!hasTranscript) return 'Add the exact transcript of the reference recording.';
  if (state.mode === 'direction' && !state.direction.trim()) {
    return 'Say how the line should be delivered.';
  }
  return null;
}

/**
 * Switch modes while keeping everything still valid.
 *
 * Typed text is preserved — it always is, because the console's text is not a
 * property of the mode. A reference survives a Clone/Direction switch, because
 * the reference is identical in both; it is dropped on the way to Design,
 * which cannot send one.
 *
 * @param state - The current mode state.
 * @param next - The mode being switched to.
 * @returns The new mode state.
 */
export function switchMode(state: ModeState, next: VoiceMode): ModeState {
  if (next === state.mode) return state;
  if (next === 'design') {
    return { ...state, mode: next, reference: null };
  }
  return { ...state, mode: next };
}

/**
 * The instruction actually sent for a mode.
 *
 * Direction's delivery note *is* the instruction — the vendor exposes one
 * instruction field, and the reference is what makes it a direction rather
 * than a description.
 *
 * @param state - The mode state.
 * @param consoleInstruction - What the console's instruction field holds.
 * @returns The instruction to send.
 */
export function instructionFor(state: ModeState, consoleInstruction: string): string {
  if (state.mode === 'direction' && state.direction.trim()) return state.direction.trim();
  return consoleInstruction;
}

/** The shape the CFG control should take, from the measured finding. */
export type CfgControl =
  | { kind: 'presets'; values: number[]; default: number }
  | { kind: 'slider'; min: number; max: number; step: number; default: number };

/**
 * The conservative control, used until the fall-off probe has run.
 *
 * Presenting a slider whose latency behaviour is unverified would silently
 * contradict the claim the demo exists to make, so absence of evidence selects
 * presets rather than the more permissive option.
 */
export const DEFAULT_CFG_CONTROL: CfgControl = {
  kind: 'presets',
  values: [1.0, 4.0],
  default: 1.0,
};

/**
 * Read the CFG control shape out of a findings payload.
 *
 * @param finding - What `GET /api/findings` returned, or null.
 * @returns The control to render.
 */
export function cfgControlFrom(finding: unknown): CfgControl {
  if (typeof finding !== 'object' || finding === null) return DEFAULT_CFG_CONTROL;
  const control = (finding as { cfgControl?: unknown }).cfgControl;
  if (typeof control !== 'object' || control === null) return DEFAULT_CFG_CONTROL;
  const candidate = control as Record<string, unknown>;

  if (candidate.kind === 'slider') {
    return {
      kind: 'slider',
      min: typeof candidate.min === 'number' ? candidate.min : 1,
      max: typeof candidate.max === 'number' ? candidate.max : 4,
      step: typeof candidate.step === 'number' ? candidate.step : 0.5,
      default: typeof candidate.default === 'number' ? candidate.default : 1,
    };
  }
  if (candidate.kind === 'presets' && Array.isArray(candidate.values)) {
    const values = candidate.values.filter((value): value is number => typeof value === 'number');
    if (values.length > 0) {
      return {
        kind: 'presets',
        values,
        default: typeof candidate.default === 'number' ? candidate.default : values[0]!,
      };
    }
  }
  return DEFAULT_CFG_CONTROL;
}
