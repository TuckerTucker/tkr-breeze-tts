/**
 * The credential-holding proxy over the Modal endpoint.
 *
 * The browser talks only to localhost. The `Modal-Key`/`Modal-Secret` pair
 * lives in this process and is attached server-side, so no credential is ever
 * readable in page source; because the UI is served from the same origin, CORS
 * never becomes a problem to configure around. The browser is never told the
 * `.modal.run` URL either — an endpoint that is not in the page is one that
 * cannot be called around the gateway.
 *
 * Upstream failures are *typed* rather than passed through as status codes.
 * The vendor's 409 in particular is not an error: it means an inference is
 * already running, and the UI's correct response is a disabled control with a
 * reason, not a red message.
 *
 * @module
 */

import type { Logger } from 'pino';

import { redact, type GatewayConfig } from './config.js';

/** Every failure the UI needs to distinguish. */
export type GatewayErrorType =
  | 'busy'
  | 'auth'
  | 'timeout'
  | 'upstream'
  | 'unavailable'
  | 'validation'
  | 'format'
  | 'reference'
  | 'not-found';

/** A failure carrying enough shape for the UI to render the right state. */
export class GatewayError extends Error {
  readonly type: GatewayErrorType;
  readonly statusCode: number;
  readonly remedy: string | undefined;

  /**
   * @param type - What kind of failure this is.
   * @param message - Operator-facing description. Never contains credentials.
   * @param options - HTTP status to return, and a remedy when one exists.
   */
  constructor(
    type: GatewayErrorType,
    message: string,
    options: { statusCode?: number; remedy?: string } = {},
  ) {
    super(message);
    this.name = 'GatewayError';
    this.type = type;
    this.statusCode = options.statusCode ?? DEFAULT_STATUS[type];
    this.remedy = options.remedy;
  }

  /**
   * Render as the response body the UI parses.
   *
   * @returns A typed error envelope.
   */
  toJSON(): { error: { type: GatewayErrorType; message: string; remedy?: string } } {
    return {
      error: {
        type: this.type,
        message: this.message,
        ...(this.remedy ? { remedy: this.remedy } : {}),
      },
    };
  }
}

const DEFAULT_STATUS: Record<GatewayErrorType, number> = {
  busy: 409,
  auth: 500,
  timeout: 504,
  upstream: 502,
  unavailable: 503,
  validation: 400,
  format: 502,
  reference: 400,
  'not-found': 404,
};

/** How confident the gateway is about the container's state. */
export type Readiness = 'warm' | 'cold' | 'unknown';

/** The fields the vendor's `/v1/audio/speech` route accepts. */
export interface SpeechParams {
  readonly text: string;
  readonly instruction: string;
  readonly cfgScale: number;
  readonly seed: number;
  /** A normalised WAV, when this is a clone or direction request. */
  readonly refAudio?: Buffer;
  /** The exact transcript of `refAudio`. */
  readonly refText?: string;
}

/** A live upstream response, before anything has been read from it. */
export interface UpstreamStream {
  /** Upstream response headers, carrying `X-Sample-Rate`/`X-Sample-Format`. */
  readonly headers: Headers;
  /** The PCM body. */
  readonly body: ReadableStream<Uint8Array>;
}

/**
 * Forwards synthesis to Modal and keeps the credential off the client.
 */
export class ModalProxy {
  readonly #config: GatewayConfig;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;
  #lastSuccessAt: number | null = null;

  /**
   * @param options - Configuration, logger, and an injectable fetch so the
   *   forwarding and error-typing logic is testable without a network.
   */
  constructor(options: {
    config: GatewayConfig;
    logger: Logger;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {
    this.#config = options.config;
    this.#log = options.logger.child({ component: 'proxy' });
    this.#fetch = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /** Clock, injectable so readiness inference is testable. */
  readonly now: () => number;

  /** Epoch milliseconds of the last successful upstream response. */
  get lastSuccessAt(): number | null {
    return this.#lastSuccessAt;
  }

  /**
   * Infer whether the next request will be warm or cold.
   *
   * Inferred from idle time rather than read from upstream, and deliberately
   * so: `/health` on a scaled-to-zero container *starts* a container. Polling
   * it to find out whether a cold start is due would cause the cold start it
   * was checking for, and keep an H100 resident while the operator reads.
   *
   * @returns `unknown` before any successful request — never `warm`, because a
   *   wrong warm claim is the one that misleads.
   */
  readiness(): Readiness {
    if (this.#lastSuccessAt === null) return 'unknown';
    return this.now() - this.#lastSuccessAt < this.#config.scaledownWindowMs
      ? 'warm'
      : 'cold';
  }

  /** Record that upstream just answered, which resets the idle clock. */
  noteSuccess(): void {
    this.#lastSuccessAt = this.now();
  }

  #headers(): Record<string, string> {
    return {
      'Modal-Key': this.#config.key,
      'Modal-Secret': this.#config.secret,
    };
  }

  /**
   * Forward one synthesis request and return the live stream.
   *
   * @param params - The vendor's form fields.
   * @returns The upstream headers and an unread body.
   * @throws {GatewayError} Typed by failure kind. Nothing thrown from here
   *   carries the token, the header names, or the upstream URL.
   */
  async speech(params: SpeechParams): Promise<UpstreamStream> {
    const form = new FormData();
    form.set('text', params.text);
    form.set('instruction', params.instruction);
    form.set('cfg_scale', String(params.cfgScale));
    form.set('seed', String(params.seed));
    if (params.refAudio && params.refText) {
      form.set(
        'ref_audio',
        new Blob([new Uint8Array(params.refAudio)], { type: 'audio/wav' }),
        'reference.wav',
      );
      form.set('ref_text', params.refText);
    }

    const response = await this.#send('/v1/audio/speech', { method: 'POST', body: form });

    if (!response.body) {
      throw new GatewayError('upstream', 'upstream returned no audio body');
    }
    this.noteSuccess();
    return { headers: response.headers, body: response.body };
  }

  /**
   * Ask upstream whether it is loaded.
   *
   * This *wakes* a scaled-to-zero container, so it is an explicit action the
   * operator takes, never a background poll.
   *
   * @returns The vendor's health payload.
   * @throws {GatewayError} Typed by failure kind.
   */
  async health(): Promise<{ status: string; sample_rate?: number }> {
    const response = await this.#send('/health', { method: 'GET' });
    this.noteSuccess();
    return (await response.json()) as { status: string; sample_rate?: number };
  }

  async #send(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.upstreamTimeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#config.endpoint}${path}`, {
        ...init,
        headers: { ...this.#headers(), ...(init.headers ?? {}) },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new GatewayError(
          'timeout',
          'the inference service did not respond in time',
          {
            remedy:
              'A cold start can take a while, but not this long. Check the service with: modal app logs breeze-tts',
          },
        );
      }
      this.#log.warn({ err: this.#scrub(error) }, 'upstream unreachable');
      throw new GatewayError('unavailable', 'the inference service is unreachable', {
        remedy: 'Check that the service is deployed: modal app list',
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 409) {
      // Not an error. The vendor holds a process-wide lock and serves one
      // request at a time, which is the posture `configs/fast.json` declares.
      throw new GatewayError('busy', 'an inference is already running', {
        remedy: 'Generate re-enables when it finishes.',
      });
    }
    if (response.status === 401 || response.status === 403) {
      // A configuration problem, not a synthesis failure. Saying so is what
      // stops the operator retrying a request that can never succeed.
      throw new GatewayError(
        'auth',
        'the inference service rejected this gateway’s credentials',
        {
          remedy:
            'Rotate the proxy token pair and update .env:\n  modal workspace proxy-tokens create --json',
        },
      );
    }
    if (response.status === 503) {
      throw new GatewayError('unavailable', 'the inference service is still loading', {
        remedy: 'Try again in a moment.',
      });
    }
    if (!response.ok) {
      const detail = this.#scrub(await response.text().catch(() => ''));
      throw new GatewayError(
        'upstream',
        `the inference service returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      );
    }
    return response;
  }

  #scrub(value: unknown): string {
    const text = value instanceof Error ? value.message : String(value ?? '');
    return redact(text, this.#config);
  }
}
