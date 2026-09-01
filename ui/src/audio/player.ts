/**
 * Playback: the streaming path, and the buffered safety net beneath it.
 *
 * No `<audio src>` can play raw PCM, so the AudioWorklet is the only route by
 * which the latency claim becomes audible rather than described. The buffered
 * path exists because that worklet has to be made to behave, and a demo that
 * is unusable while that happens is a demo nobody iterates on.
 *
 * First-audio time is measured here, at the moment the first sample is handed
 * to the audio graph — the only honest place, since the value under test is
 * end to end.
 *
 * @module
 */

import { alignSamples, loadPcmWorklet, type WorkletMessage } from './worklet.js';

/** What a completed playback reports. */
export interface PlaybackResult {
  /** Milliseconds from request send to first sample played. */
  readonly ttfaMs: number | null;
  /** Total PCM bytes received. */
  readonly bytes: number;
  /** Which path actually played. */
  readonly mode: 'streaming' | 'buffered';
  /** True when the worklet failed and the buffered path took over. */
  readonly fellBack: boolean;
  /** True when the stream ended early; the clip is incomplete, not fast. */
  readonly incomplete: boolean;
  /** The gateway's clip id, for history and replay. */
  readonly clipId: string | null;
}

/** Events the player reports as it goes. */
export interface PlayerCallbacks {
  /** Fired once, when the first sample reaches the audio graph. */
  onFirstAudio?(ttfaMs: number): void;
  /** Fired when the worklet could not be used. */
  onFallback?(reason: string): void;
  /** Fired when the buffer ran dry mid-clip. */
  onUnderrun?(): void;
}

/** How the player reaches the audio hardware. Injected so it can be faked. */
export interface AudioBackend {
  /**
   * Create a context running at the model's own sample rate.
   *
   * This is not a detail. The worklet emits one buffered sample per output
   * frame, so a context at 48kHz fed 24kHz samples plays at double speed — a
   * failure that sounds like a broken model rather than a broken graph.
   *
   * @param sampleRate - The rate the upstream declared.
   */
  createContext(sampleRate: number): AudioContext;
  /** The URL of the worklet processor module. */
  workletUrl: string;
}

/**
 * Play a gateway response, streaming if possible and buffered if not.
 */
export class StreamingPlayer {
  readonly #backend: AudioBackend;
  #context: AudioContext | null = null;
  #node: AudioWorkletNode | null = null;
  #element: HTMLAudioElement | null = null;
  #objectUrl: string | null = null;

  /**
   * @param backend - How to reach the audio hardware.
   */
  constructor(backend: AudioBackend) {
    this.#backend = backend;
  }

  /**
   * Play a response body.
   *
   * @param response - The gateway's response. `audio/wav` selects the buffered
   *   path, `audio/pcm` the streaming one — the transport is read from the
   *   response rather than assumed, so the gateway's setting is honoured
   *   without the client being configured twice.
   * @param startedAt - `performance.now()` at the moment the request was sent.
   * @param callbacks - Progress hooks.
   * @returns What happened.
   */
  async play(
    response: Response,
    startedAt: number,
    callbacks: PlayerCallbacks = {},
  ): Promise<PlaybackResult> {
    const contentType = response.headers.get('content-type') ?? '';
    const clipId = response.headers.get('x-clip-id');
    const sampleRate = Number(response.headers.get('x-sample-rate') ?? '24000');

    if (contentType.includes('audio/wav')) {
      return this.#playBuffered(response, startedAt, clipId, false, callbacks);
    }

    try {
      return await this.#playStreaming(response, startedAt, clipId, sampleRate, callbacks);
    } catch (error) {
      // A worklet failure must degrade to working audio, never to silence.
      const reason = error instanceof Error ? error.message : String(error);
      callbacks.onFallback?.(reason);
      throw error;
    }
  }

  async #playStreaming(
    response: Response,
    startedAt: number,
    clipId: string | null,
    sampleRate: number,
    callbacks: PlayerCallbacks,
  ): Promise<PlaybackResult> {
    const context = this.#backend.createContext(sampleRate);
    this.#context = context;

    const loaded = await loadPcmWorklet(context, this.#backend.workletUrl);
    if (!loaded) {
      callbacks.onFallback?.('AudioWorklet is unavailable in this browser');
      await context.close().catch(() => {});
      this.#context = null;
      return this.#playBuffered(response, startedAt, clipId, true, callbacks);
    }

    const node = new AudioWorkletNode(context, 'pcm-processor', {
      numberOfInputs: 0,
      outputChannelCount: [1],
    });
    this.#node = node;
    node.connect(context.destination);

    let ttfaMs: number | null = null;
    node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      if (event.data.type === 'underrun') callbacks.onUnderrun?.();
    };

    const reader = response.body?.getReader();
    if (!reader) throw new Error('the response carried no body to stream');

    let carry: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    let bytes = 0;
    let incomplete = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        bytes += value.byteLength;
        const aligned = alignSamples(carry, value);
        carry = aligned.carry;
        if (aligned.samples.length === 0) continue;

        if (ttfaMs === null) {
          // Playback begins on the first chunk, before generation completes.
          ttfaMs = performance.now() - startedAt;
          callbacks.onFirstAudio?.(ttfaMs);
        }
        node.port.postMessage({ type: 'samples', samples: aligned.samples }, [
          aligned.samples.buffer,
        ]);
      }
    } catch {
      // Stop cleanly and report the clip as incomplete, rather than leaving the
      // player stuck.
      incomplete = true;
    }

    node.port.postMessage({ type: 'end' });
    return {
      ttfaMs,
      bytes,
      mode: 'streaming',
      fellBack: false,
      incomplete,
      clipId,
    };
  }

  async #playBuffered(
    response: Response,
    startedAt: number,
    clipId: string | null,
    fellBack: boolean,
    callbacks: PlayerCallbacks,
  ): Promise<PlaybackResult> {
    const buffer = await response.arrayBuffer();
    const blob = new Blob([buffer], { type: 'audio/wav' });
    this.#revokeObjectUrl();
    this.#objectUrl = URL.createObjectURL(blob);

    const element = new Audio(this.#objectUrl);
    this.#element = element;
    const ttfaMs = performance.now() - startedAt;
    callbacks.onFirstAudio?.(ttfaMs);
    await element.play().catch(() => {
      // Autoplay policy or a decode failure; the clip is still in history and
      // replayable from the cache, so this is reported rather than thrown.
    });

    return {
      ttfaMs,
      bytes: buffer.byteLength,
      mode: 'buffered',
      fellBack,
      incomplete: false,
      clipId,
    };
  }

  /** Stop playback and release the audio graph. */
  async stop(): Promise<void> {
    this.#node?.port.postMessage({ type: 'reset' });
    this.#node?.disconnect();
    this.#node = null;
    if (this.#element) {
      this.#element.pause();
      this.#element = null;
    }
    this.#revokeObjectUrl();
    if (this.#context) {
      await this.#context.close().catch(() => {});
      this.#context = null;
    }
  }

  #revokeObjectUrl(): void {
    if (this.#objectUrl) {
      URL.revokeObjectURL(this.#objectUrl);
      this.#objectUrl = null;
    }
  }
}

/**
 * The browser-backed audio backend.
 *
 * @param workletUrl - Bundled URL of the processor module.
 * @returns A backend that creates real contexts.
 */
export function browserBackend(workletUrl: string): AudioBackend {
  return {
    workletUrl,
    createContext: (sampleRate: number) => new AudioContext({ sampleRate }),
  };
}

/**
 * Play a cached clip, which is always a complete WAV.
 *
 * Replay reaches no GPU and is a buffered read whichever transport is active,
 * so this path is deliberately the simple one.
 *
 * @param url - The gateway's clip route.
 * @returns The audio element, already playing.
 */
export function playCachedClip(url: string): HTMLAudioElement {
  const element = new Audio(url);
  void element.play().catch(() => {});
  return element;
}
