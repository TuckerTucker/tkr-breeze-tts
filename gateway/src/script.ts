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
import { cueCacheKey } from './cache-index.js';
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
 * The captured input-length ceiling, **per branch-batch mode**.
 *
 * Measured, not assumed. `configs/fast.json` captures the text encoder and
 * backbone prefill at batch 1 → 32..256 and batch 2 → 32..512, and
 * `warmup_profile.py` maps cfg to a binary mode — `no_cfg` for exactly 1.0,
 * `single_cfg` otherwise. So cfg 1.0 runs a single branch capped at 256
 * tokens and any other cfg runs dual branches capped at 512.
 *
 * Beyond the ceiling the request does **not** degrade to a slower path.
 * `freeze_after_warmup` makes the graph cache raise
 * `RuntimeError: text encoder CUDA graph (b, n) was not declared in the warmup
 * profile`, the connection aborts, and no audio is produced. Verified live:
 * ~299 tokens fails at cfg 1.0 and serves at cfg 2.5 and 4.0.
 */
export const TOKEN_CEILING_BY_MODE = { noCfg: 256, singleCfg: 512 } as const;

/** The higher of the two, for display where the mode is not yet known. */
export const MAX_CUE_TOKENS = TOKEN_CEILING_BY_MODE.singleCfg;

/**
 * The token ceiling a given cfg value actually gets.
 *
 * @param cfgScale - The requested guidance scale.
 * @returns Maximum input tokens that will succeed.
 */
export function tokenCeilingFor(cfgScale: number): number {
  return cfgScale === 1.0
    ? TOKEN_CEILING_BY_MODE.noCfg
    : TOKEN_CEILING_BY_MODE.singleCfg;
}

/**
 * Estimate token count from characters.
 *
 * Deliberately an estimate, and deliberately conservative: the exact count
 * needs the model's tokenizer, which lives on the GPU. Four characters per
 * token is the usual English approximation, and being slightly pessimistic
 * costs a warning where being optimistic costs a silent fall-off.
 *
 * @param text - The line to be spoken.
 * @returns Approximate token count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
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
  cfgScale: number;
  seed: number;
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

/** A script and its cues. */
export interface ScriptRecord {
  readonly id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Which parser produced the cues. */
  source: 'vtt' | 'text';
  cues: Cue[];
  /** Blocks that could not be read, kept so nothing is silently dropped. */
  problems: CueProblem[];
}

/** The fields a cue edit may change. */
export interface CuePatch {
  text?: string;
  voiceId?: string | null;
  voiceName?: string | null;
  cfgScale?: number;
  seed?: number;
}

/**
 * Compute a cue's deterministic clip id.
 *
 * @param cue - The cue whose audio is being keyed.
 * @returns A stable key over text, voice, cfg and seed.
 */
export function clipIdFor(cue: Pick<Cue, 'text' | 'voiceId' | 'cfgScale' | 'seed'>): string {
  return `cue-${cueCacheKey({
    text: cue.text,
    voiceId: cue.voiceId,
    cfgScale: cue.cfgScale,
    seed: cue.seed,
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
  context: { cache: ClipCache; availableVoiceIds: ReadonlySet<string> },
): ScriptRecord {
  for (const cue of script.cues) {
    cue.clipId = clipIdFor(cue);

    if (cue.voiceId && !context.availableVoiceIds.has(cue.voiceId)) {
      cue.state = 'unrunnable';
      cue.problem = `the voice “${cue.voiceName ?? cue.voiceId}” is no longer in the library`;
      continue;
    }
    const ceiling = tokenCeilingFor(cue.cfgScale);
    if (estimateTokens(cue.text) > ceiling) {
      cue.state = 'unrunnable';
      cue.problem =
        `about ${estimateTokens(cue.text)} tokens, past the ${ceiling}-token ceiling ` +
        `at cfg ${cue.cfgScale} — this fails outright rather than running slowly`;
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
          this.#records.set(parsed.id, parsed);
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
  }): Promise<ScriptRecord> {
    const parsed = parseScriptFile(input.source, input.filename);
    const now = Date.now();
    const cfgScale = input.cfgScale ?? 1.0;
    const seed = input.seed ?? 42;

    const record: ScriptRecord = {
      id: randomUUID(),
      name: input.name ?? input.filename ?? 'Untitled script',
      createdAt: now,
      updatedAt: now,
      source: parsed.format,
      problems: parsed.problems,
      cues: parsed.cues.map((cue, index) => {
        const base = {
          text: cue.text,
          voiceId: null as string | null,
          cfgScale,
          seed,
        };
        return {
          id: randomUUID(),
          index,
          text: cue.text,
          voiceId: null,
          voiceName: null,
          cfgScale,
          seed,
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
   * Fetch a script.
   *
   * @param id - The script id.
   * @returns The record.
   * @throws {GatewayError} When it does not exist.
   */
  require(id: string): ScriptRecord {
    const record = this.#records.get(id);
    if (!record) throw new GatewayError('not-found', `no script with id ${id}`);
    return record;
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

    if (patch.text !== undefined) cue.text = patch.text;
    if (patch.voiceId !== undefined) cue.voiceId = patch.voiceId;
    if (patch.voiceName !== undefined) cue.voiceName = patch.voiceName;
    if (patch.cfgScale !== undefined) cue.cfgScale = patch.cfgScale;
    if (patch.seed !== undefined) cue.seed = patch.seed;
    cue.clipId = clipIdFor(cue);
    cue.problem = null;
    if (cue.state === 'failed') cue.state = 'queued';

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
    record.cues = cues.map((cue, index) => ({ ...cue, index, clipId: clipIdFor(cue) }));
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
