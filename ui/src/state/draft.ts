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

/**
 * The captured input-length ceiling, **per branch-batch mode**.
 *
 * Mirrors the gateway's. `configs/fast.json` captures batch 1 at 32..256 and
 * batch 2 at 32..512, and the vendor maps cfg to a binary mode — exactly 1.0
 * runs a single branch, anything else runs dual branches. Past the ceiling the
 * request does not run slowly, it **fails**: the frozen graph cache raises and
 * no audio arrives. Verified live at ~299 tokens, which failed at cfg 1.0 and
 * served at cfg 2.5 and 4.0.
 */
export const TOKEN_CEILING_BY_MODE = { noCfg: 256, singleCfg: 512 } as const;

/** The higher of the two, for display before a cfg value is known. */
export const MAX_TOKENS = TOKEN_CEILING_BY_MODE.singleCfg;

/**
 * The ceiling a given cfg value actually gets.
 *
 * @param cfgScale - The current guidance scale.
 * @returns Maximum input tokens that will succeed.
 */
export function tokenCeilingFor(cfgScale: number): number {
  return cfgScale === 1.0
    ? TOKEN_CEILING_BY_MODE.noCfg
    : TOKEN_CEILING_BY_MODE.singleCfg;
}

/** The vendor's default instruction, used as a sensible pre-fill. */
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
 * Estimate token count from characters.
 *
 * Matches the gateway's estimate exactly, so the number shown while typing is
 * the number the request is judged against. Deliberately approximate — the
 * exact count needs the model's tokenizer, which lives on the GPU — and
 * deliberately pessimistic, because a warning that arrives early costs less
 * than a fall-off nobody was told about.
 *
 * @param text - The line to be spoken.
 * @returns Approximate token count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
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
  /** The current guidance scale, which decides the token ceiling. */
  readonly cfgScale: number;
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
  const tokens = estimateTokens(input.draft.text);
  const ceiling = tokenCeilingFor(input.cfgScale);
  if (tokens > ceiling) {
    // Not a latency warning: past the ceiling the request produces no audio at
    // all, so the remedy names the way out rather than just the limit.
    return input.cfgScale === 1.0
      ? `About ${tokens} tokens — past the ${ceiling}-token limit at CFG 1.0. Shorten it, or raise CFG for a ${TOKEN_CEILING_BY_MODE.singleCfg}-token limit.`
      : `About ${tokens} tokens — past the ${ceiling}-token limit. Shorten it to generate.`;
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
