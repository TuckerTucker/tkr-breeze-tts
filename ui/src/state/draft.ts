/**
 * The console draft: what is typed, what it costs, and why Generate is off.
 *
 * Every rule here answers the same question in a different place — *can this
 * request succeed, and if not, what should the operator be told before they
 * press anything?* Nothing in this module reports a problem after submission.
 *
 * @module
 */

/**
 * Which vocal-event palette to offer.
 *
 * A UI affordance only. The vendor API has no language field and the model
 * infers language from the text, so this selection changes which markers the
 * palette inserts and nothing else. It is never sent.
 */
export type EventLanguage = 'en' | 'zh';

import type { VoiceMode } from './mode.js';

/**
 * How many text segments each template contributes, per branch.
 *
 * Mirrors the gateway's `SEGMENTS_BY_MODE`. Design uses `tts_instruction`, one
 * segment; Clone and Direction use `ref_edit_tata`, two.
 */
export const SEGMENTS_BY_MODE = { design: 1, clone: 2, direction: 2 } as const;

/**
 * The declared text-encoder ceiling at each batch size.
 *
 * Mirrors the gateway's `CEILING_BY_BATCH`, so the number shown while typing is
 * the number the request is judged against. Two copies that disagree would be
 * worse than one that is wrong, so a test asserts they match.
 */
export const CEILING_BY_BATCH = { 1: 256, 2: 512, 4: 512 } as const;

/** The highest ceiling any mode reaches, for display before a mode is known. */
export const MAX_TOKENS = 512;

/**
 * The text-encoder batch a request will produce: segments × branches.
 *
 * @param mode - The voice mode in force.
 * @param cfgScale - The current guidance scale.
 * @returns The batch the graph will be keyed on.
 */
export function textEncoderBatch(mode: VoiceMode, cfgScale: number): 1 | 2 | 4 {
  return (SEGMENTS_BY_MODE[mode] * (cfgScale === 1.0 ? 1 : 2)) as 1 | 2 | 4;
}

/**
 * The ceiling this mode and cfg actually get.
 *
 * Past it the request does not run slowly, it **fails**: the frozen graph cache
 * raises and no audio arrives. Clone at cfg 1.0 already carries two segments,
 * so it reaches batch 2 and gets 512 — keying on cfg alone said 256 and was
 * wrong for both reference modes.
 *
 * @param mode - The voice mode in force.
 * @param cfgScale - The current guidance scale.
 * @returns Maximum tokens in any single text segment.
 */
export function tokenCeilingFor(mode: VoiceMode, cfgScale: number): number {
  return CEILING_BY_BATCH[textEncoderBatch(mode, cfgScale)];
}

/** What the instruction field starts as, and falls back to when cleared. */
export const DEFAULT_INSTRUCTION = 'Speak clearly and naturally.';

/** Vocal events the model recognises, per language. */
export const VOCAL_EVENTS: Record<EventLanguage, readonly { label: string; marker: string }[]> = {
  en: [
    { label: '(laugh)', marker: '(laugh)' },
    { label: '(sigh)', marker: '(sigh)' },
    { label: '(cough)', marker: '(cough)' },
    { label: '(breath)', marker: '(breath)' },
  ],
  zh: [
    { label: '[笑]', marker: '[笑]' },
    { label: '[叹气]', marker: '[叹气]' },
    { label: '[咳嗽]', marker: '[咳嗽]' },
    { label: '[呼吸]', marker: '[呼吸]' },
  ],
};

/** Everything the console holds between reloads. */
export interface Draft {
  text: string;
  instruction: string;
  language: EventLanguage;
  seed: number;
  /** When held, an audible difference is attributable to the setting that changed. */
  seedLocked: boolean;
}

/** The starting draft, with the instruction pre-filled. */
export const INITIAL_DRAFT: Draft = {
  text: '',
  instruction: DEFAULT_INSTRUCTION,
  language: 'en',
  seed: 42,
  seedLocked: true,
};

const STORAGE_KEY = 'breeze.draft.v1';

/**
 * Characters per token for Latin-script text, and tokens per CJK character.
 *
 * Mirrors the gateway's estimator exactly — including the CJK weighting, which
 * is unmeasured and deliberately high. Four characters per token is an English
 * average, and this is a bilingual EN/ZH model whose 中文 palette invites
 * Chinese input; a Han character is three UTF-8 bytes, so byte fallback costs
 * three tokens and good merges cost one. Over-estimating shows a limit early;
 * under-estimating spends a cold start to earn a RuntimeError.
 */
const LATIN_CHARS_PER_TOKEN = 4;
const CJK_TOKENS_PER_CHAR = 2;

/**
 * Whether a code point tokenizes far worse than Latin text.
 *
 * @param codePoint - A Unicode code point.
 * @returns True for Han, kana, Hangul, and the blocks that travel with them.
 */
function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ebef)
  );
}

/**
 * Estimate token count from characters.
 *
 * Matches the gateway's estimate exactly, so the number shown while typing is
 * the number the request is judged against. Counted by code point, so an
 * astral ideograph counts once rather than twice.
 *
 * @param text - The string that will become a text segment.
 * @returns Approximate token count.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of trimmed) {
    if (isCjk(char.codePointAt(0) ?? 0)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other / LATIN_CHARS_PER_TOKEN);
}

/**
 * Insert a vocal-event marker at the caret.
 *
 * @param text - Current text.
 * @param caret - Caret offset.
 * @param marker - The marker to insert.
 * @returns The new text and where the caret should land after it.
 */
export function insertAtCaret(
  text: string,
  caret: number,
  marker: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  // Spacing is added only where it is missing. Inserting a marker next to an
  // existing space would leave a double space the operator then has to notice
  // and remove.
  const lead = at > 0 && !/\s$/.test(before) ? ' ' : '';
  const trail = after.length === 0 || !/^\s/.test(after) ? ' ' : '';
  const insertion = `${lead}${marker}${trail}`;
  return { text: `${before}${insertion}${after}`, caret: at + insertion.length };
}

/** Everything that can stop a request from being sendable. */
export interface GateInput {
  readonly draft: Draft;
  /** From the gateway's health route. */
  readonly gatewayReachable: boolean;
  /** True while an inference is already running upstream. */
  readonly busy: boolean;
  /** True while this client is mid-request. */
  readonly generating: boolean;
  /** Set when the current mode still needs something. */
  readonly modeBlocker: string | null;
  /** The current guidance scale. With the mode, it decides the ceiling. */
  readonly cfgScale: number;
  /** The voice mode, which decides how many text segments are sent. */
  readonly mode: VoiceMode;
  /** The reference transcript in Clone and Direction — itself a text segment. */
  readonly refText?: string;
}

/**
 * Why Generate is disabled, or null when it is not.
 *
 * Returning the *reason* rather than a boolean is the whole point: a disabled
 * control with no explanation is a dead end, and an enabled control that fails
 * is worse.
 *
 * @param input - The current state.
 * @returns A short reason, shown beside the control.
 */
export function generateBlockedReason(input: GateInput): string | null {
  if (!input.gatewayReachable) return 'The gateway is not running — start it to generate.';
  if (input.generating) return 'Generating…';
  if (input.busy) return 'Disabled while a request is running.';
  if (!input.draft.text.trim()) return 'Enter some text to enable.';
  const ceiling = tokenCeilingFor(input.mode, input.cfgScale);
  // Every string that becomes a text segment, because the graph bucket is the
  // padded maximum across the batch — one long segment sets it for every row.
  // The instruction shares the spoken segment; the transcript is its own.
  const spoken = estimateTokens(`${input.draft.instruction} ${input.draft.text}`);
  const transcript = estimateTokens(input.refText ?? '');
  if (spoken > ceiling || transcript > ceiling) {
    // Not a latency warning: past the ceiling the request produces no audio at
    // all, so the remedy names the way out rather than just the limit.
    const overTranscript = transcript > spoken;
    const field = overTranscript ? 'The reference transcript' : 'The line';
    const tokens = overTranscript ? transcript : spoken;
    return input.mode === 'design' && ceiling === CEILING_BY_BATCH[1]
      ? `${field} is about ${tokens} tokens — past the ${ceiling}-token limit at CFG 1.0. Shorten it, or raise CFG for a ${CEILING_BY_BATCH[2]}-token limit.`
      : `${field} is about ${tokens} tokens — past the ${ceiling}-token limit. Shorten it to generate.`;
  }
  if (input.modeBlocker) return input.modeBlocker;
  return null;
}

/**
 * Draw a new seed.
 *
 * @param random - Injected randomness, so a reroll is testable.
 * @returns A seed inside the range the vendor accepts.
 */
export function rollSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 100_000);
}

/** A minimal storage shape, so persistence is testable without a browser. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Read the persisted draft.
 *
 * @param storage - Where to read from.
 * @returns The stored draft, or the initial one. Never throws — a corrupt
 *   entry loses a draft, and losing the whole console with it would be worse.
 */
export function loadDraft(storage: DraftStorage): Draft {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return INITIAL_DRAFT;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : INITIAL_DRAFT.text,
      instruction:
        typeof parsed.instruction === 'string' ? parsed.instruction : DEFAULT_INSTRUCTION,
      language: parsed.language === 'zh' ? 'zh' : 'en',
      seed: typeof parsed.seed === 'number' ? parsed.seed : INITIAL_DRAFT.seed,
      seedLocked: parsed.seedLocked !== false,
    };
  } catch {
    return INITIAL_DRAFT;
  }
}

/**
 * Persist the draft, so a reload loses nothing.
 *
 * @param storage - Where to write.
 * @param draft - What to write.
 */
export function saveDraft(storage: DraftStorage, draft: Draft): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // A full or disabled storage must not take the console down with it.
  }
}
