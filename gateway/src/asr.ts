/**
 * Credential-holding proxy for the optional transcription service.
 *
 * Recognition is an intake convenience, not a prerequisite for keeping a
 * recording. An absent, unreachable, or malformed ASR response therefore
 * degrades to an empty transcript and is reported through status and logs; it
 * never discards the operator's uploaded audio.
 *
 * @module
 */

import type { Logger } from 'pino';

import { redact, type GatewayConfig } from './config.js';
import type { TimedWord } from './reference-slice.js';

/** What the staged-reference sidecar keeps from recognition. */
export interface Transcription {
  readonly text: string;
  readonly language: string | null;
  readonly durationSeconds: number | null;
  readonly words: readonly TimedWord[];
}

/** The non-polling ASR state exposed by gateway health. */
export interface AsrStatus {
  readonly available: boolean;
  readonly configured: boolean;
  readonly remedy: string | null;
  readonly lastError: string | null;
}

/** The one setup action that makes optional transcription available. */
export const ASR_SETUP_REMEDY =
  'Deploy with `modal deploy infra/asr.py`, then set MODAL_ASR_URL in .env and restart the gateway.';

const ASR_FAILURE_REMEDY =
  'The recording is safe. Check `modal app logs breeze-tts-asr`, then transcribe again or enter the words by hand.';

/** Empty recognition, used when intake must continue without ASR. */
export const EMPTY_TRANSCRIPTION: Transcription = {
  text: '',
  language: null,
  durationSeconds: null,
  words: [],
};

function parseTranscription(value: unknown): Transcription | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.text !== 'string' || !Array.isArray(candidate.words)) {
    return null;
  }
  const words: TimedWord[] = [];
  for (const raw of candidate.words) {
    if (typeof raw !== 'object' || raw === null) return null;
    const word = raw as Record<string, unknown>;
    if (
      typeof word.word !== 'string' ||
      typeof word.start !== 'number' ||
      !Number.isFinite(word.start) ||
      typeof word.end !== 'number' ||
      !Number.isFinite(word.end) ||
      word.start < 0 ||
      word.end < word.start
    ) {
      return null;
    }
    words.push({ word: word.word, start: word.start, end: word.end });
  }
  const duration = candidate.duration;
  return {
    text: candidate.text.trim(),
    language: typeof candidate.language === 'string' ? candidate.language : null,
    durationSeconds:
      typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
        ? duration
        : null,
    words,
  };
}

/** Proxies one normalised WAV to the sibling ASR app. */
export class AsrProxy {
  readonly #config: GatewayConfig;
  readonly #fetch: typeof fetch;
  readonly #log: Logger;
  #lastError: string | null = null;

  /**
   * @param options - Configuration, logger, and injectable HTTP transport.
   */
  constructor(options: {
    config: GatewayConfig;
    logger: Logger;
    fetchImpl?: typeof fetch;
  }) {
    this.#config = options.config;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#log = options.logger.child({ component: 'asr-proxy' });
  }

  /**
   * Report configuration and the last observed failure without waking a GPU.
   *
   * @returns ASR availability suitable for `/api/health`.
   */
  status(): AsrStatus {
    const configured = this.#config.asrEndpoint !== null;
    return {
      available: configured && this.#lastError === null,
      configured,
      remedy: !configured
        ? ASR_SETUP_REMEDY
        : this.#lastError
          ? ASR_FAILURE_REMEDY
          : null,
      lastError: this.#lastError,
    };
  }

  /**
   * Transcribe one normalised reference.
   *
   * Every failure returns the same empty shape. The recording is still staged,
   * and a transcript can be corrected or supplied by hand later.
   *
   * @param wav - Normalised reference WAV.
   * @returns Timed recognition, or an empty transcript on graceful degradation.
   */
  async transcribe(wav: Buffer): Promise<Transcription> {
    const endpoint = this.#config.asrEndpoint;
    if (!endpoint) return EMPTY_TRANSCRIPTION;

    this.#log.info({ bytes: wav.length }, 'reference transcription started');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.#config.upstreamTimeoutMs,
    );
    try {
      const form = new FormData();
      form.set(
        'file',
        new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
        'reference.wav',
      );
      const response = await this.#fetch(`${endpoint}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: {
          'Modal-Key': this.#config.key,
          'Modal-Secret': this.#config.secret,
        },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = redact(await response.text().catch(() => ''), this.#config);
        throw new Error(
          `transcription service returned ${response.status}${
            detail ? `: ${detail.slice(0, 300)}` : ''
          }`,
        );
      }
      const parsed = parseTranscription(await response.json());
      if (!parsed) throw new Error('transcription service returned an invalid response');
      this.#lastError = null;
      this.#log.info(
        { words: parsed.words.length, language: parsed.language },
        'reference transcription finished',
      );
      return parsed;
    } catch (error) {
      const raw = controller.signal.aborted
        ? 'the transcription service timed out'
        : error instanceof Error
          ? error.message
          : String(error);
      this.#lastError = redact(raw, this.#config);
      this.#log.warn(
        { err: this.#lastError },
        'reference transcription unavailable; staging audio without a transcript',
      );
      return EMPTY_TRANSCRIPTION;
    } finally {
      clearTimeout(timer);
    }
  }
}
