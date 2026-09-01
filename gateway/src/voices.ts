/**
 * The voice library store.
 *
 * Two lifetimes, deliberately separated: clips are exhaust and get evicted,
 * voices are kept. A voice therefore owns its own copy of the audio rather
 * than pointing at a cache entry, and survives eviction of the clip it came
 * from.
 *
 * Saving from a generated clip is a container write, not a re-encode: the
 * cached PCM is copied and framed as WAV from that clip's own sidecar. There
 * is no second GPU call, and no generation loss.
 *
 * @module
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

import type { ClipCache } from './cache.js';
import { GatewayError } from './proxy.js';
import { durationSeconds, frameWav, readWavHeader } from './transport.js';
import {
  disambiguateName,
  partitionByUndoWindow,
  validateVoice,
  type VoiceOrigin,
  type VoiceRecord,
} from './voices-index.js';

const WAV_SUFFIX = '.wav';
const SIDECAR_SUFFIX = '.json';

/** A voice read back in full: audio and transcript, always together. */
export interface VoiceWithAudio {
  readonly record: VoiceRecord;
  /** The stored WAV. */
  readonly wav: Buffer;
}

/** Disk-backed store of named, reusable voices. */
export class VoiceStore {
  readonly #dir: string;
  readonly #log: Logger;
  #records = new Map<string, VoiceRecord>();

  /**
   * @param options - Directory and logger.
   */
  constructor(options: { dir: string; logger: Logger }) {
    this.#dir = options.dir;
    this.#log = options.logger.child({ component: 'voice-store' });
  }

  /** The directory voices are written to. */
  get dir(): string {
    return this.#dir;
  }

  /**
   * Load the index from disk and purge anything past its undo window.
   *
   * Voices persist across gateway restarts; that is most of what separates a
   * library from a session.
   */
  async load(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const entries = await readdir(this.#dir).catch(() => [] as string[]);
    const records = new Map<string, VoiceRecord>();

    for (const entry of entries) {
      if (!entry.endsWith(SIDECAR_SUFFIX)) continue;
      const id = entry.slice(0, -SIDECAR_SUFFIX.length);
      try {
        const parsed = JSON.parse(await readFile(this.#sidecarPath(id), 'utf8'));
        const record = validateVoice(parsed);
        if (record) records.set(id, record);
        else this.#log.warn({ id }, 'voice sidecar invalid; skipping');
      } catch (error) {
        this.#log.warn({ id, err: error }, 'voice sidecar unreadable; skipping');
      }
    }

    this.#records = records;
    const { purge } = partitionByUndoWindow([...records.values()], Date.now());
    for (const record of purge) await this.#purge(record.id);
    this.#log.info({ voices: this.#records.size }, 'voice store loaded');
  }

  #wavPath(id: string): string {
    return join(this.#dir, `${id}${WAV_SUFFIX}`);
  }

  #sidecarPath(id: string): string {
    return join(this.#dir, `${id}${SIDECAR_SUFFIX}`);
  }

  /**
   * List every voice the operator can select.
   *
   * @returns Visible records, newest first. Soft-deleted voices are excluded.
   */
  list(): VoiceRecord[] {
    const { visible } = partitionByUndoWindow([...this.#records.values()], Date.now());
    return visible.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Look one voice up, including one inside its undo window.
   *
   * @param id - The voice id.
   * @returns The record, or undefined.
   */
  get(id: string): VoiceRecord | undefined {
    return this.#records.get(id);
  }

  /**
   * Read a voice's audio and transcript together.
   *
   * Never one alone: a request built from the library must be structurally
   * incapable of being the half-formed pair the vendor rejects.
   *
   * @param id - The voice id.
   * @returns The record and its WAV.
   * @throws {GatewayError} When the voice is absent, soft-deleted, or its
   *   audio file has gone — reported as unavailable rather than producing a
   *   request that upstream will refuse.
   */
  async read(id: string): Promise<VoiceWithAudio> {
    const record = this.#records.get(id);
    if (!record || record.deletedAt !== undefined) {
      throw new GatewayError('not-found', `no voice with id ${id}`);
    }
    try {
      const wav = await readFile(this.#wavPath(id));
      return { record, wav };
    } catch (error) {
      this.#log.warn({ id, err: error }, 'voice audio missing; marking unavailable');
      throw new GatewayError(
        'not-found',
        `the audio for voice “${record.name}” is missing`,
        { remedy: 'Save the voice again from a clip, or upload the reference file.' },
      );
    }
  }

  /**
   * Whether a voice's audio is actually present.
   *
   * @param id - The voice id.
   * @returns True when the voice can be used in a request.
   */
  async isAvailable(id: string): Promise<boolean> {
    try {
      await this.read(id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Store a voice from an already-conforming WAV.
   *
   * @param input - The audio, transcript, name and provenance.
   * @returns The stored record.
   * @throws {GatewayError} When the transcript is absent — a voice without one
   *   could only ever produce a request the vendor rejects.
   */
  async create(input: {
    wav: Buffer;
    transcript: string;
    name: string;
    origin: VoiceOrigin;
    defaultDirection?: string | null;
  }): Promise<VoiceRecord> {
    const transcript = input.transcript.trim();
    if (!transcript) {
      throw new GatewayError(
        'validation',
        'a voice needs the exact transcript of its reference audio',
        { remedy: 'The model requires the transcript to match the recording exactly.' },
      );
    }

    const header = readWavHeader(input.wav);
    const id = randomUUID();
    const now = Date.now();
    const record: VoiceRecord = {
      id,
      name: disambiguateName(input.name, this.list().map((voice) => voice.name)),
      createdAt: now,
      updatedAt: now,
      transcript,
      defaultDirection: input.defaultDirection ?? null,
      origin: input.origin,
      bytes: input.wav.length,
      sampleRate: header.sampleRate,
      channels: header.channels,
      durationSeconds: durationSeconds(header.dataBytes, header),
    };

    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#wavPath(id), input.wav);
    await writeFile(this.#sidecarPath(id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    this.#records.set(id, record);
    this.#log.info({ id, name: record.name, origin: record.origin.kind }, 'voice saved');
    return record;
  }

  /**
   * Save a voice from a clip already in the cache.
   *
   * The clip's PCM is copied and framed as WAV from its own sidecar values — a
   * container write, not a re-encode, and never a second GPU request. The
   * voice then owns those bytes, so evicting the source clip leaves it usable.
   *
   * @param options - The clip to copy, the name, and the cache to read from.
   * @returns The stored record.
   * @throws {GatewayError} When the clip has already been evicted — there is
   *   no audio left to copy, and saying so beats a silent failure.
   */
  async createFromClip(options: {
    cache: ClipCache;
    clipId: string;
    name: string;
    transcript?: string;
    defaultDirection?: string | null;
  }): Promise<VoiceRecord> {
    const clip = options.cache.get(options.clipId);
    const pcm = clip ? await options.cache.readPcm(options.clipId) : null;
    if (!clip || !pcm) {
      throw new GatewayError(
        'not-found',
        'that clip is no longer cached, so there is no audio to save',
        { remedy: 'Generate it again, then save the new clip as a voice.' },
      );
    }

    const wav = frameWav(pcm, {
      sampleRate: clip.sampleRate,
      format: clip.format,
      channels: clip.channels,
      bytesPerSample: 2,
    });

    // The transcript of a generated clip is the text that produced it — the
    // system already holds it, and the vendor requires it to be exact, so
    // asking the operator to retype it would be asking for work already done.
    const transcript = options.transcript?.trim() || clip.request.text;

    const origin: VoiceOrigin =
      clip.request.mode === 'design'
        ? {
            kind: 'designed',
            instruction: clip.request.instruction,
            seed: clip.request.seed,
            sourceClipId: clip.id,
          }
        : { kind: 'cloned', sourceClipId: clip.id, instruction: clip.request.instruction };

    return this.create({
      wav,
      transcript,
      name: options.name,
      origin,
      defaultDirection:
        options.defaultDirection ??
        (clip.request.mode === 'direction' ? clip.request.instruction : null),
    });
  }

  /**
   * Rename a voice or change its default direction.
   *
   * @param id - The voice id.
   * @param changes - Fields to update.
   * @returns The updated record.
   * @throws {GatewayError} When the voice does not exist.
   */
  async update(
    id: string,
    changes: { name?: string; defaultDirection?: string | null; transcript?: string },
  ): Promise<VoiceRecord> {
    const existing = this.#records.get(id);
    if (!existing || existing.deletedAt !== undefined) {
      throw new GatewayError('not-found', `no voice with id ${id}`);
    }

    const others = this.list()
      .filter((voice) => voice.id !== id)
      .map((voice) => voice.name);

    const updated: VoiceRecord = {
      ...existing,
      name: changes.name === undefined ? existing.name : disambiguateName(changes.name, others),
      defaultDirection:
        changes.defaultDirection === undefined
          ? existing.defaultDirection
          : changes.defaultDirection,
      transcript:
        changes.transcript === undefined ? existing.transcript : changes.transcript.trim(),
      updatedAt: Date.now(),
    };
    await writeFile(this.#sidecarPath(id), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    this.#records.set(id, updated);
    return updated;
  }

  /**
   * Delete a voice, restorably.
   *
   * Soft for the undo window, then final. Deleting a voice never touches the
   * clips it was made from — the two have separate lifetimes on purpose.
   *
   * @param id - The voice id.
   * @returns The soft-deleted record.
   * @throws {GatewayError} When the voice does not exist.
   */
  async remove(id: string): Promise<VoiceRecord> {
    const existing = this.#records.get(id);
    if (!existing) throw new GatewayError('not-found', `no voice with id ${id}`);
    const deleted: VoiceRecord = { ...existing, deletedAt: Date.now() };
    await writeFile(this.#sidecarPath(id), `${JSON.stringify(deleted, null, 2)}\n`, 'utf8');
    this.#records.set(id, deleted);
    return deleted;
  }

  /**
   * Undo a delete inside its window.
   *
   * @param id - The voice id.
   * @returns The restored record.
   * @throws {GatewayError} When the window has passed and the voice is gone.
   */
  async restore(id: string): Promise<VoiceRecord> {
    const existing = this.#records.get(id);
    if (!existing) {
      throw new GatewayError('not-found', 'that voice has already been removed for good');
    }
    const { deletedAt: _deletedAt, ...rest } = existing;
    const restored: VoiceRecord = { ...rest, updatedAt: Date.now() };
    await writeFile(this.#sidecarPath(id), `${JSON.stringify(restored, null, 2)}\n`, 'utf8');
    this.#records.set(id, restored);
    return restored;
  }

  /**
   * Remove anything whose undo window has elapsed.
   *
   * @returns The ids removed for good.
   */
  async purgeExpired(): Promise<string[]> {
    const { purge } = partitionByUndoWindow([...this.#records.values()], Date.now());
    for (const record of purge) await this.#purge(record.id);
    return purge.map((record) => record.id);
  }

  async #purge(id: string): Promise<void> {
    this.#records.delete(id);
    await Promise.all([
      rm(this.#wavPath(id), { force: true }).catch(() => {}),
      rm(this.#sidecarPath(id), { force: true }).catch(() => {}),
    ]);
  }
}
