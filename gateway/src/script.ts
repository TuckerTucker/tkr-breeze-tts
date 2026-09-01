/**
 * Scripts: the cue list as the document, and its two exports.
 *
 * One request per cue is forced, not chosen. The model itself supports
 * multi-turn dialogue with a per-turn `speaker_id` — its own generation
 * docstring demonstrates it — but `breeze_infer/api.py` exposes only `text`,
 * `instruction`, `cfg_scale`, `ref_audio`, `ref_text` and `seed`, and
 * `templates.py` hardcodes speaker `S0`. A multi-voice script therefore cannot
 * be a single dialogue call.
 *
 * Staleness is *derived*, not tracked. A cue's clip id is a hash of the four
 * things its audio depends on — text, voice, cfg and seed — so editing any of
 * them changes the id, the new id is not in the cache, and the cue is stale by
 * construction. Everything else still points at cached audio. Correcting one
 * line costs one GPU request rather than forty.
 *
 * @module
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

import type { ClipCache } from './cache.js';
import {
  DEFAULT_DELIVERY_INSTRUCTION,
  cueCacheKey,
  type VoiceMode,
} from './cache-index.js';
import { GatewayError } from './proxy.js';
import { frameWav, type AudioFormat } from './transport.js';
import { emitVtt, parseScriptFile, type CueProblem } from './vtt.js';

/** Where a cue stands. Shown in place, per row. */
export type CueState =
  | 'queued'
  | 'generating'
  | 'done'
  | 'stale'
  | 'failed'
  | 'unrunnable';

/**
 * How many text segments each template contributes, per branch.
 *
 * `infra/extend_warmup_profile.py` records the vendor's two templates:
 * `tts_instruction` is one text segment, `ref_edit_tata` — the template behind
 * both Clone and Direction — is two. Design uses the first; Clone and
 * Direction use the second.
 */
export const SEGMENTS_BY_MODE = { design: 1, clone: 2, direction: 2 } as const;

/**
 * The declared text-encoder ceiling at each batch size.
 *
 * From `configs/fast.json`, recorded in the brief: batch 1 → 32..256, batch 2
 * → 32..512. Batch 4 exists only because `extend_warmup_profile.py` declares
 * it at build time, also to 512. There is no batch 3: the batch is segments ×
 * branches, and both factors are 1 or 2.
 */
export const CEILING_BY_BATCH = { 1: 256, 2: 512, 4: 512 } as const;

/** The highest ceiling any mode reaches, for display before a mode is known. */
export const MAX_CUE_TOKENS = 512;

/**
 * The text-encoder batch a request will produce.
 *
 * Segments × branches. `warmup_profile.py` maps cfg to a binary branch mode —
 * exactly 1.0 is a single branch, anything else is dual — so the batch is the
 * template's segment count doubled at any cfg but 1.0.
 *
 * Keying the ceiling on cfg alone, as this once did, is right for Design and
 * wrong for the other two: Clone at cfg 1.0 carries two segments and so
 * reaches batch 2, where 512 is available, not the 256 a single branch
 * suggests.
 *
 * @param mode - Which template the request will use.
 * @param cfgScale - The requested guidance scale.
 * @returns The batch size the text-encoder graph will be keyed on.
 */
export function textEncoderBatch(mode: VoiceMode, cfgScale: number): 1 | 2 | 4 {
  const segments = SEGMENTS_BY_MODE[mode];
  const branches = cfgScale === 1.0 ? 1 : 2;
  return (segments * branches) as 1 | 2 | 4;
}

/**
 * The captured input-length ceiling this request actually gets.
 *
 * Beyond it the request does **not** degrade to a slower path.
 * `freeze_after_warmup` makes the graph cache raise
 * `RuntimeError: text encoder CUDA graph (b, n) was not declared in the warmup
 * profile`, the connection aborts, and no audio is produced.
 *
 * @param mode - Which template the request will use.
 * @param cfgScale - The requested guidance scale.
 * @returns Maximum tokens in any single text segment.
 */
export function tokenCeilingFor(mode: VoiceMode, cfgScale: number): number {
  return CEILING_BY_BATCH[textEncoderBatch(mode, cfgScale)];
}

/**
 * Characters per token for Latin-script text.
 *
 * Four is the usual English approximation, and it survived the one input that
 * has been checked against the real tokenizer: 2707 characters produced a
 * `(2, 640)` graph, so between 4.2 and 4.5 characters per token, against the
 * 677 this estimate returned. Slightly pessimistic, which is the intended
 * direction.
 */
const LATIN_CHARS_PER_TOKEN = 4;

/**
 * Tokens per CJK character. **Unmeasured, and deliberately pessimistic.**
 *
 * Dividing by four is an English average, and this is a bilingual EN/ZH model.
 * A Han character is three UTF-8 bytes, so a tokenizer with byte fallback and
 * no merge for it costs three tokens; one with good Chinese merges costs one.
 * Two is chosen between those bounds rather than measured, because the
 * tokenizer lives in the image and nothing here can read it.
 *
 * Over-estimating refuses input that would have served — visible, and
 * recoverable by shortening. Under-estimating spends a cold start to earn a
 * RuntimeError. That asymmetry is why this leans high, and why replacing it
 * with a probe figure is worth doing.
 */
const CJK_TOKENS_PER_CHAR = 2;

/**
 * Whether a code point is CJK, and so tokenizes far worse than Latin text.
 *
 * @param codePoint - A Unicode code point.
 * @returns True for Han, kana, Hangul, and the CJK punctuation and fullwidth
 *   blocks that travel with them.
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
 * Deliberately an estimate: the exact count needs the model's tokenizer, which
 * lives on the GPU. Counted by code point rather than by UTF-16 unit, so an
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

/** A field whose estimated length exceeds the ceiling its batch carries. */
export interface CeilingBreach {
  /** Which input was too long, named as the operator knows it. */
  readonly field: 'text' | 'instruction' | 'transcript';
  readonly tokens: number;
  readonly ceiling: number;
  readonly batch: number;
}

/** Every string a request will send that becomes part of a text segment. */
export interface CeilingInput {
  readonly mode: VoiceMode;
  readonly cfgScale: number;
  readonly text: string;
  readonly instruction?: string;
  /** The reference transcript, in Clone and Direction. */
  readonly refText?: string;
}

/**
 * Find the input that will not fit, or null when every one of them will.
 *
 * The graph's `token_length` is the **padded maximum** across the batch, so one
 * long segment sets the bucket for every row and the largest segment decides.
 * Measuring `text` alone — which this once did — is what let a 2707-character
 * reference transcript reach the GPU and raise `(2, 640)` after a 170s cold
 * start.
 *
 * Segment composition is inferred, not read: the vendor runtime is not in this
 * repo, so what is known is the segment *count* per template. `tts_instruction`
 * is one segment, which must therefore carry the instruction and the text
 * together, so Design sums them. `ref_edit_tata` is two, read here as the
 * reference transcript in one and the instruction with the text in the other.
 * Both readings are the conservative one consistent with the counts.
 *
 * @param input - The mode, the cfg, and every string that will be sent.
 * @returns The largest offending field, or null.
 */
export function findCeilingBreach(input: CeilingInput): CeilingBreach | null {
  const ceiling = tokenCeilingFor(input.mode, input.cfgScale);
  const batch = textEncoderBatch(input.mode, input.cfgScale);
  const instruction = input.instruction ?? '';

  const spoken = estimateTokens(`${instruction} ${input.text}`);
  const candidates: Array<{ field: CeilingBreach['field']; tokens: number }> = [
    // The instruction shares its segment with the text, so an over-long pair is
    // reported against whichever half is doing the damage.
    {
      field: estimateTokens(instruction) > estimateTokens(input.text) ? 'instruction' : 'text',
      tokens: spoken,
    },
  ];
  if (input.refText) {
    candidates.push({ field: 'transcript', tokens: estimateTokens(input.refText) });
  }

  const worst = candidates.reduce((a, b) => (b.tokens > a.tokens ? b : a));
  if (worst.tokens <= ceiling) return null;
  return { field: worst.field, tokens: worst.tokens, ceiling, batch };
}

/** How each field is named in a refusal. */
const FIELD_LABEL: Record<CeilingBreach['field'], string> = {
  text: 'the line',
  instruction: 'the instruction',
  transcript: 'the reference transcript',
};

/**
 * Say what is too long and what to do about it.
 *
 * Three inputs can each be the cause, so a refusal that says only "shorten it"
 * leaves the operator to guess which box.
 *
 * @param breach - What the check found.
 * @param mode - The mode in force, which decides whether raising CFG helps.
 * @returns A message and a remedy.
 */
export function ceilingRefusal(
  breach: CeilingBreach,
  mode: VoiceMode,
): { message: string; remedy: string } {
  const message =
    `${FIELD_LABEL[breach.field]} is about ${breach.tokens} tokens, past the ` +
    `${breach.ceiling}-token ceiling this request carries`;
  // Raising CFG moves Design from batch 1 to batch 2 and so from 256 to 512.
  // For Clone and Direction it changes the batch but not the ceiling, so
  // offering it there would be advice that does not work.
  const remedy =
    mode === 'design' && breach.ceiling === CEILING_BY_BATCH[1]
      ? `Shorten ${FIELD_LABEL[breach.field]}, or raise CFG above 1.0 — dual-branch ` +
        `Design carries a ${CEILING_BY_BATCH[2]}-token ceiling.`
      : `Shorten ${FIELD_LABEL[breach.field]}. Every CFG value carries the same ` +
        `${breach.ceiling}-token ceiling in this mode.`;
  return { message, remedy };
}

/**
 * Which template a cue will use.
 *
 * A cue carries a library voice or it does not, and that is exactly the
 * difference between `ref_edit_tata` and `tts_instruction` — so the mode is
 * derived rather than stored, and cannot drift from the request it describes.
 *
 * @param cue - The cue.
 * @returns The voice mode its request will take.
 */
export function cueMode(cue: Pick<Cue, 'voiceId'>): VoiceMode {
  return cue.voiceId ? 'clone' : 'design';
}

/**
 * Everything about a cue the ceiling check needs.
 *
 * The reference transcript comes from the library rather than the cue, because
 * a cue stores only the voice id — and the transcript is the field that
 * silently blew the ceiling before this check existed.
 *
 * @param cue - The cue.
 * @param transcripts - Library transcripts by voice id.
 * @returns The check's input.
 */
export function cueCeilingInput(
  cue: Pick<Cue, 'voiceId' | 'text' | 'instruction' | 'cfgScale'>,
  transcripts: ReadonlyMap<string, string>,
): CeilingInput {
  const refText = cue.voiceId ? transcripts.get(cue.voiceId) : undefined;
  return {
    mode: cueMode(cue),
    cfgScale: cue.cfgScale,
    text: cue.text,
    instruction: cue.instruction ?? DEFAULT_DELIVERY_INSTRUCTION,
    ...(refText ? { refText } : {}),
  };
}

/** One line of a script. */
export interface Cue {
  readonly id: string;
  index: number;
  text: string;
  /** The library voice assigned to this line, or null in a single-voice script. */
  voiceId: string | null;
  /** That voice's name at assignment time, so a deleted voice is still legible. */
  voiceName: string | null;
  /** Effective delivery after script defaults and cue overrides are resolved. */
  instruction?: string;
  cfgScale: number;
  seed: number;
  /** Explicit exceptions. Null means inherit the script default. */
  overrides?: CueOverrides;
  /** Imported target start, in seconds. Null for untimed plain text. */
  targetStart: number | null;
  /** Imported target end, in seconds. Null for untimed plain text. */
  targetEnd: number | null;
  state: CueState;
  /** Deterministic cache key for this cue's audio. */
  clipId: string;
  /** Duration actually generated, in seconds. */
  actualSeconds: number | null;
  /** Generated minus target, in seconds. Reported, never corrected. */
  driftSeconds: number | null;
  /** Why this cue failed or cannot run. */
  problem: string | null;
}

/** How inherited cue seeds are derived. */
export type ScriptSeedMode = 'fixed' | 'increment';

/** Common settings inherited by every cue without an explicit exception. */
export interface ScriptDefaults {
  readonly voiceId: string | null;
  readonly voiceName: string | null;
  readonly instruction: string;
  readonly cfgScale: number;
  readonly seedMode: ScriptSeedMode;
  readonly seed: number;
}

/** Per-cue settings. Null means the corresponding script default is authoritative. */
export interface CueOverrides {
  voiceId: string | null;
  voiceName: string | null;
  instruction: string | null;
  cfgScale: number | null;
  seed: number | null;
}

/** Fully resolved settings used for validation, caching, and synthesis. */
export interface EffectiveCueSettings {
  readonly voiceId: string | null;
  readonly voiceName: string | null;
  readonly instruction: string;
  readonly cfgScale: number;
  readonly seed: number;
}

/** Neutral defaults applied to newly imported and migrated scripts. */
export const INITIAL_SCRIPT_DEFAULTS: ScriptDefaults = {
  voiceId: null,
  voiceName: null,
  instruction: DEFAULT_DELIVERY_INSTRUCTION,
  cfgScale: 1,
  seedMode: 'fixed',
  seed: 42,
};

/** No explicit cue exceptions; every value follows the script defaults. */
export const EMPTY_CUE_OVERRIDES: CueOverrides = {
  voiceId: null,
  voiceName: null,
  instruction: null,
  cfgScale: null,
  seed: null,
};

/** A script and its cues. */
export interface ScriptRecord {
  readonly id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Which parser produced the cues. */
  source: 'vtt' | 'text';
  /** Optional only so pre-contract records remain structurally readable. */
  defaults?: ScriptDefaults;
  cues: Cue[];
  /** Blocks that could not be read, kept so nothing is silently dropped. */
  problems: CueProblem[];
}

/** Lightweight script row returned before any document body is loaded. */
export interface ScriptSummary {
  readonly id: string;
  readonly name: string;
  readonly source: ScriptRecord['source'];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cueCount: number;
  readonly doneCount: number;
  readonly failedCount: number;
  readonly defaults: ScriptDefaults;
}

/** The fields a cue edit may change. */
export interface CuePatch {
  text?: string;
  voiceId?: string | null;
  voiceName?: string | null;
  cfgScale?: number;
  seed?: number;
  instruction?: string;
  overrides?: Partial<CueOverrides>;
}

/** Fields accepted when the script-level defaults are changed. */
export type ScriptDefaultsPatch = Partial<ScriptDefaults>;

function validCfgScale(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validSeed(value: number): boolean {
  return Number.isInteger(value);
}

function canonicalDefaults(value: ScriptDefaults | undefined): ScriptDefaults {
  if (!value) return { ...INITIAL_SCRIPT_DEFAULTS };
  return {
    voiceId: typeof value.voiceId === 'string' ? value.voiceId : null,
    voiceName: typeof value.voiceName === 'string' ? value.voiceName : null,
    instruction:
      typeof value.instruction === 'string' && value.instruction.trim()
        ? value.instruction
        : DEFAULT_DELIVERY_INSTRUCTION,
    cfgScale: validCfgScale(value.cfgScale) ? value.cfgScale : 1,
    seedMode: value.seedMode === 'increment' ? 'increment' : 'fixed',
    seed: validSeed(value.seed) ? value.seed : 42,
  };
}

function canonicalOverrides(
  cue: Pick<Cue, 'voiceId' | 'voiceName' | 'instruction' | 'cfgScale' | 'seed' | 'overrides'>,
  defaults: ScriptDefaults,
): CueOverrides {
  if (cue.overrides) {
    return {
      voiceId: typeof cue.overrides.voiceId === 'string' ? cue.overrides.voiceId : null,
      voiceName: typeof cue.overrides.voiceName === 'string' ? cue.overrides.voiceName : null,
      instruction:
        typeof cue.overrides.instruction === 'string' && cue.overrides.instruction.trim()
          ? cue.overrides.instruction
          : null,
      cfgScale:
        typeof cue.overrides.cfgScale === 'number' && validCfgScale(cue.overrides.cfgScale)
          ? cue.overrides.cfgScale
          : null,
      seed:
        typeof cue.overrides.seed === 'number' && validSeed(cue.overrides.seed)
          ? cue.overrides.seed
          : null,
    };
  }

  // Version-one records stored only effective values. Preserve each difference
  // as an explicit exception while introducing neutral script defaults.
  return {
    voiceId: cue.voiceId ?? null,
    voiceName: cue.voiceName ?? null,
    instruction:
      cue.instruction && cue.instruction !== defaults.instruction
        ? cue.instruction
        : null,
    cfgScale: cue.cfgScale !== defaults.cfgScale ? cue.cfgScale : null,
    seed: cue.seed !== defaults.seed ? cue.seed : null,
  };
}

/**
 * Resolve one cue's inherited and explicit delivery values.
 *
 * @param script - Script carrying the common defaults.
 * @param cue - Cue carrying nullable exceptions.
 * @returns The one effective settings object used by every downstream rule.
 */
export function effectiveCueSettings(
  script: Pick<ScriptRecord, 'defaults'>,
  cue: Pick<Cue, 'index' | 'voiceId' | 'voiceName' | 'instruction' | 'cfgScale' | 'seed' | 'overrides'>,
): EffectiveCueSettings {
  const defaults = canonicalDefaults(script.defaults);
  const overrides = canonicalOverrides(cue, defaults);
  return {
    voiceId: overrides.voiceId ?? defaults.voiceId,
    voiceName: overrides.voiceName ?? defaults.voiceName,
    instruction: overrides.instruction ?? defaults.instruction,
    cfgScale: overrides.cfgScale ?? defaults.cfgScale,
    seed:
      overrides.seed ??
      (defaults.seedMode === 'increment' ? defaults.seed + cue.index : defaults.seed),
  };
}

function materializeCue(script: ScriptRecord, cue: Cue): void {
  const effective = effectiveCueSettings(script, cue);
  cue.voiceId = effective.voiceId;
  cue.voiceName = effective.voiceName;
  cue.instruction = effective.instruction;
  cue.cfgScale = effective.cfgScale;
  cue.seed = effective.seed;
  cue.overrides = canonicalOverrides(cue, canonicalDefaults(script.defaults));
  cue.clipId = clipIdFor(cue);
}

function migrateScript(record: ScriptRecord): ScriptRecord {
  record.defaults = canonicalDefaults(record.defaults);
  for (const cue of record.cues) materializeCue(record, cue);
  return record;
}

/**
 * Compute a cue's deterministic clip id.
 *
 * @param cue - The cue whose audio is being keyed.
 * @returns A stable key over text, voice, cfg and seed.
 */
export function clipIdFor(
  cue: Pick<Cue, 'text' | 'voiceId' | 'instruction' | 'cfgScale' | 'seed'>,
): string {
  return `cue-${cueCacheKey({
    text: cue.text,
    voiceId: cue.voiceId,
    cfgScale: cue.cfgScale,
    seed: cue.seed,
    instruction: cue.instruction ?? DEFAULT_DELIVERY_INSTRUCTION,
  })}`;
}

/**
 * Recompute per-cue state against the cache and the voice library.
 *
 * Called on every read, so state reflects the world rather than a stored
 * belief about it: an evicted clip becomes stale again, and a deleted voice
 * makes its cues unrunnable without anything having to notice the deletion.
 *
 * @param script - The script to refresh. Mutated in place.
 * @param context - The cache and the set of voice ids that still exist.
 * @returns The same script.
 */
export function refreshScript(
  script: ScriptRecord,
  context: { cache: ClipCache; voiceTranscripts: ReadonlyMap<string, string> },
): ScriptRecord {
  for (const cue of script.cues) {
    materializeCue(script, cue);

    if (cue.voiceId && !context.voiceTranscripts.has(cue.voiceId)) {
      cue.state = 'unrunnable';
      cue.problem = `the voice “${cue.voiceName ?? cue.voiceId}” is no longer in the library`;
      continue;
    }
    const breach = findCeilingBreach(cueCeilingInput(cue, context.voiceTranscripts));
    if (breach) {
      cue.state = 'unrunnable';
      const { message, remedy } = ceilingRefusal(breach, cueMode(cue));
      cue.problem = `${message} — this fails outright rather than running slowly. ${remedy}`;
      continue;
    }

    const cached = context.cache.get(cue.clipId);
    if (cached) {
      cue.state = 'done';
      cue.actualSeconds = cached.durationSeconds;
      cue.driftSeconds =
        cue.targetStart !== null && cue.targetEnd !== null
          ? Number((cached.durationSeconds - (cue.targetEnd - cue.targetStart)).toFixed(3))
          : null;
      cue.problem = null;
      continue;
    }

    cue.actualSeconds = null;
    cue.driftSeconds = null;
    if (cue.state !== 'failed') cue.state = cue.state === 'done' ? 'stale' : 'queued';
  }
  return script;
}

/** Disk-backed store of scripts. */
export class ScriptStore {
  readonly #dir: string;
  readonly #log: Logger;
  #records = new Map<string, ScriptRecord>();

  /**
   * @param options - Directory and logger.
   */
  constructor(options: { dir: string; logger: Logger }) {
    this.#dir = options.dir;
    this.#log = options.logger.child({ component: 'script-store' });
  }

  /** Load persisted scripts. */
  async load(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const entries = await readdir(this.#dir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.#dir, entry), 'utf8')) as ScriptRecord;
        if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.cues)) {
          this.#records.set(parsed.id, migrateScript(parsed));
        }
      } catch (error) {
        this.#log.warn({ entry, err: error }, 'script unreadable; skipping');
      }
    }
    this.#log.info({ scripts: this.#records.size }, 'script store loaded');
  }

  #path(id: string): string {
    return join(this.#dir, `${id}.json`);
  }

  /**
   * Import a dropped file as an editable cue list.
   *
   * @param input - The file's text, its name, and per-cue defaults.
   * @returns The stored script.
   */
  async importFile(input: {
    source: string;
    filename?: string;
    name?: string;
    cfgScale?: number;
    seed?: number;
    defaults?: ScriptDefaultsPatch;
  }): Promise<ScriptRecord> {
    const parsed = parseScriptFile(input.source, input.filename);
    const now = Date.now();
    const defaults = canonicalDefaults({
      ...INITIAL_SCRIPT_DEFAULTS,
      ...(input.cfgScale === undefined ? {} : { cfgScale: input.cfgScale }),
      ...(input.seed === undefined ? {} : { seed: input.seed }),
      ...input.defaults,
    });

    const record: ScriptRecord = {
      id: randomUUID(),
      name: input.name ?? input.filename ?? 'Untitled script',
      createdAt: now,
      updatedAt: now,
      source: parsed.format,
      defaults,
      problems: parsed.problems,
      cues: parsed.cues.map((cue, index) => {
        const base = {
          text: cue.text,
          voiceId: defaults.voiceId,
          instruction: defaults.instruction,
          cfgScale: defaults.cfgScale,
          seed:
            defaults.seedMode === 'increment' ? defaults.seed + index : defaults.seed,
        };
        return {
          id: randomUUID(),
          index,
          text: cue.text,
          voiceId: base.voiceId,
          voiceName: defaults.voiceName,
          instruction: base.instruction,
          cfgScale: base.cfgScale,
          seed: base.seed,
          overrides: { ...EMPTY_CUE_OVERRIDES },
          targetStart: cue.targetStart,
          targetEnd: cue.targetEnd,
          state: 'queued' as CueState,
          clipId: clipIdFor(base),
          actualSeconds: null,
          driftSeconds: null,
          problem: null,
        };
      }),
    };

    await this.#persist(record);
    this.#log.info(
      { id: record.id, cues: record.cues.length, problems: record.problems.length },
      'script imported',
    );
    return record;
  }

  /** List every stored script, newest first. */
  list(): ScriptRecord[] {
    return [...this.#records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * List document metadata without requiring clients to load every cue body.
   *
   * @returns Newest documents first.
   */
  summaries(): ScriptSummary[] {
    return this.list().map((record) => ({
      id: record.id,
      name: record.name,
      source: record.source,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      cueCount: record.cues.length,
      doneCount: record.cues.filter((cue) => cue.state === 'done').length,
      failedCount: record.cues.filter(
        (cue) => cue.state === 'failed' || cue.state === 'unrunnable',
      ).length,
      defaults: canonicalDefaults(record.defaults),
    }));
  }

  /**
   * Fetch a script.
   *
   * @param id - The script id.
   * @returns The record.
   * @throws {GatewayError} When it does not exist.
   */
  require(id: string): ScriptRecord {
    const record = this.#records.get(id);
    if (!record) throw new GatewayError('not-found', `no script with id ${id}`);
    return migrateScript(record);
  }

  /**
   * Edit one cue.
   *
   * Only that cue's clip id changes, so only that cue goes stale. Every other
   * cue keeps its generated audio and replays from cache.
   *
   * @param scriptId - The script.
   * @param cueId - The cue to edit.
   * @param patch - Fields to change.
   * @returns The updated script.
   * @throws {GatewayError} When either id is unknown.
   */
  async patchCue(scriptId: string, cueId: string, patch: CuePatch): Promise<ScriptRecord> {
    const record = this.require(scriptId);
    const cue = record.cues.find((candidate) => candidate.id === cueId);
    if (!cue) throw new GatewayError('not-found', `no cue with id ${cueId}`);

    const previousClipId = cue.clipId;
    if (patch.text !== undefined) cue.text = patch.text;
    const overrides: CueOverrides = {
      ...EMPTY_CUE_OVERRIDES,
      ...cue.overrides,
      ...patch.overrides,
    };
    if (patch.voiceId !== undefined) overrides.voiceId = patch.voiceId;
    if (patch.voiceName !== undefined) overrides.voiceName = patch.voiceName;
    if (patch.instruction !== undefined) overrides.instruction = patch.instruction;
    if (patch.cfgScale !== undefined) overrides.cfgScale = patch.cfgScale;
    if (patch.seed !== undefined) overrides.seed = patch.seed;
    if (overrides.cfgScale !== null && !validCfgScale(overrides.cfgScale)) {
      throw new GatewayError('validation', 'cue cfgScale must be a positive number');
    }
    if (overrides.seed !== null && !validSeed(overrides.seed)) {
      throw new GatewayError('validation', 'cue seed must be an integer');
    }
    cue.overrides = overrides;
    materializeCue(record, cue);
    cue.problem = null;
    if (cue.clipId !== previousClipId) {
      cue.state = 'stale';
      cue.actualSeconds = null;
      cue.driftSeconds = null;
    } else if (cue.state === 'failed') cue.state = 'queued';

    record.updatedAt = Date.now();
    await this.#persist(record);
    return record;
  }

  /**
   * Change common script delivery and invalidate only inheriting cues whose
   * effective cache identity changes.
   *
   * @param scriptId - Script to update.
   * @param patch - Validated common settings.
   * @returns The updated canonical script.
   */
  async patchDefaults(
    scriptId: string,
    patch: ScriptDefaultsPatch,
  ): Promise<ScriptRecord> {
    const record = this.require(scriptId);
    if (patch.cfgScale !== undefined && !validCfgScale(patch.cfgScale)) {
      throw new GatewayError('validation', 'script cfgScale must be a positive number');
    }
    if (patch.seed !== undefined && !validSeed(patch.seed)) {
      throw new GatewayError('validation', 'script seed must be an integer');
    }
    if (patch.instruction !== undefined && !patch.instruction.trim()) {
      throw new GatewayError('validation', 'script instruction cannot be empty');
    }

    const previousIds = new Map(record.cues.map((cue) => [cue.id, cue.clipId]));
    record.defaults = canonicalDefaults({
      ...canonicalDefaults(record.defaults),
      ...patch,
    });
    for (const cue of record.cues) {
      materializeCue(record, cue);
      if (previousIds.get(cue.id) !== cue.clipId) {
        cue.state = 'stale';
        cue.actualSeconds = null;
        cue.driftSeconds = null;
        cue.problem = null;
      }
    }
    record.updatedAt = Date.now();
    await this.#persist(record);
    return record;
  }

  /**
   * Replace the whole cue list — add, reorder, delete in one write.
   *
   * @param scriptId - The script.
   * @param cues - The new list, in display order.
   * @returns The updated script.
   */
  async replaceCues(scriptId: string, cues: Cue[]): Promise<ScriptRecord> {
    const record = this.require(scriptId);
    record.cues = cues.map((cue, index) => ({ ...cue, index }));
    for (const cue of record.cues) materializeCue(record, cue);
    record.updatedAt = Date.now();
    await this.#persist(record);
    return record;
  }

  /**
   * Persist a script after a run has mutated its cue states.
   *
   * @param record - The script to write.
   */
  async save(record: ScriptRecord): Promise<void> {
    migrateScript(record);
    record.updatedAt = Date.now();
    await this.#persist(record);
  }

  /**
   * Delete a script. Its cached cue audio is untouched.
   *
   * @param id - The script id.
   * @returns Whether it existed.
   */
  async remove(id: string): Promise<boolean> {
    const existed = this.#records.delete(id);
    await rm(this.#path(id), { force: true }).catch(() => {});
    return existed;
  }

  async #persist(record: ScriptRecord): Promise<void> {
    this.#records.set(record.id, record);
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#path(record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
}

/**
 * Export a script as WebVTT carrying the durations actually generated.
 *
 * @param script - The script, already refreshed against the cache.
 * @param gapSeconds - Silence between cues, matching `concatenateScript`.
 * @returns A WebVTT document.
 * @throws {GatewayError} When a cue has no generated audio to time.
 */
export function exportVtt(script: ScriptRecord, gapSeconds = 0): string {
  const missing = script.cues.filter((cue) => cue.actualSeconds === null);
  if (missing.length > 0) {
    throw new GatewayError(
      'validation',
      `${missing.length} cue(s) have not been generated, so there are no real timings to export`,
      { remedy: 'Run the script first — export never emits the imported targets.' },
    );
  }
  return emitVtt(
    script.cues.map((cue) => ({ text: cue.text, durationSeconds: cue.actualSeconds! })),
    gapSeconds,
  );
}

/**
 * Concatenate every cue's audio into one continuous WAV.
 *
 * @param script - The script, already refreshed against the cache.
 * @param cache - Where the cue audio lives.
 * @param gapSeconds - Silence inserted between cues.
 * @returns One WAV whose length is the sum of the cue durations plus the gaps.
 * @throws {GatewayError} When any cue's audio is missing.
 */
export async function concatenateScript(
  script: ScriptRecord,
  cache: ClipCache,
  gapSeconds = 0,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let format: AudioFormat | null = null;

  for (const cue of script.cues) {
    const record = cache.get(cue.clipId);
    const pcm = record ? await cache.readPcm(cue.clipId) : null;
    if (!record || !pcm) {
      throw new GatewayError(
        'validation',
        `cue ${cue.index + 1} has no generated audio to export`,
        { remedy: 'Run the script so every cue has audio, then export again.' },
      );
    }
    const cueFormat: AudioFormat = {
      sampleRate: record.sampleRate,
      format: record.format,
      channels: record.channels,
      bytesPerSample: 2,
    };
    if (format === null) format = cueFormat;
    else if (format.sampleRate !== cueFormat.sampleRate) {
      throw new GatewayError(
        'validation',
        'cues were generated at different sample rates and cannot be concatenated',
      );
    }
    if (parts.length > 0 && gapSeconds > 0) {
      parts.push(
        Buffer.alloc(Math.round(gapSeconds * cueFormat.sampleRate) * cueFormat.channels * 2),
      );
    }
    parts.push(pcm);
  }

  if (!format) {
    throw new GatewayError('validation', 'the script has no cues to export');
  }
  return frameWav(Buffer.concat(parts), format);
}
