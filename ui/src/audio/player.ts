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
 * Rate and encoding are read from the response, never assumed. That is the one
 * rule this module cannot bend: a wrong rate does not fail, it plays at the
 * wrong speed, and the operator hears a broken model instead of a broken
 * header.
 *
 * @module
 */

import {
  alignSamples,
  loadPcmWorklet,
  parseDeclaredTransport,
  wavFromPcm,
  type DeclaredTransport,
  type WorkletMessage,
} from './worklet.js';

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

/** Everything the buffered path needs, named rather than positional. */
interface BufferedPlayback {
  readonly response: Response;
  readonly startedAt: number;
  readonly clipId: string | null;
  /** True when the streaming path handed this over rather than being chosen. */
  readonly fellBack: boolean;
  /**
   * Set when the body is raw PCM and must be framed before an element can
   * decode it; null when the gateway already sent a container.
   */
  readonly frameAs: DeclaredTransport | null;
  readonly callbacks: PlayerCallbacks;
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
   * @throws {TransportDeclarationError} When the response declares audio this
   *   browser cannot play. Raised before any context exists, so nothing is left
   *   open and the operator is told what was wrong with the declaration rather
   *   than being shown an unexplained generation failure.
   */
  async play(
    response: Response,
    startedAt: number,
    callbacks: PlayerCallbacks = {},
  ): Promise<PlaybackResult> {
    const contentType = response.headers.get('content-type') ?? '';
    const clipId = response.headers.get('x-clip-id');

    if (contentType.includes('audio/wav')) {
      // A WAV states its own rate and encoding in its header, and the element
      // reads them from there; asking for headers as well would be a second
      // declaration that could disagree with the file.
      return this.#playBuffered({
        response,
        startedAt,
        clipId,
        fellBack: false,
        frameAs: null,
        callbacks,
      });
    }

    const transport = parseDeclaredTransport(response.headers);

    try {
      return await this.#playStreaming(response, startedAt, clipId, transport, callbacks);
    } catch (error) {
      // Everything that can still degrade to working audio does so inside
      // #playStreaming, while the body is untouched. Once the first read has
      // happened the body is spent, so buffered playback is no longer an option
      // and the honest move is to release the graph and name the failure.
      await this.#releaseGraph();
      throw error;
    }
  }

  async #playStreaming(
    response: Response,
    startedAt: number,
    clipId: string | null,
    transport: DeclaredTransport,
    callbacks: PlayerCallbacks,
  ): Promise<PlaybackResult> {
    const context = this.#backend.createContext(transport.sampleRate);
    this.#context = context;

    const loaded = await loadPcmWorklet(context, this.#backend.workletUrl);
    if (!loaded) {
      return this.#fallBackToBuffered(
        'AudioWorklet is unavailable in this browser',
        { response, startedAt, clipId, fellBack: true, frameAs: transport, callbacks },
      );
    }

    let node: AudioWorkletNode;
    try {
      node = new AudioWorkletNode(context, 'pcm-processor', {
        numberOfInputs: 0,
        outputChannelCount: [1],
      });
    } catch (error) {
      // The module loaded but the node would not start. The body has not been
      // read yet, so this is still recoverable into audio rather than silence.
      const reason = error instanceof Error ? error.message : String(error);
      return this.#fallBackToBuffered(reason, {
        response,
        startedAt,
        clipId,
        fellBack: true,
        frameAs: transport,
        callbacks,
      });
    }
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
        const aligned = alignSamples(carry, value, transport.converter);
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

  /**
   * Hand an untouched body to the buffered path, releasing the graph first.
   *
   * Separated so every worklet failure leaves through the same door: the
   * context is closed before the element takes over, rather than lingering
   * until the next generation calls stop().
   */
  async #fallBackToBuffered(reason: string, playback: BufferedPlayback): Promise<PlaybackResult> {
    playback.callbacks.onFallback?.(reason);
    await this.#releaseGraph();
    return this.#playBuffered(playback);
  }

  async #playBuffered(playback: BufferedPlayback): Promise<PlaybackResult> {
    const { response, startedAt, clipId, fellBack, frameAs, callbacks } = playback;
    const received = new Uint8Array(await response.arrayBuffer());
    const playable = frameAs ? wavFromPcm(received, frameAs) : received;
    const blob = new Blob([playable], { type: 'audio/wav' });
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
      // The samples received, not the container built around them.
      bytes: received.byteLength,
      mode: 'buffered',
      fellBack,
      incomplete: false,
      clipId,
    };
  }

  /** Stop playback and release the audio graph. */
  async stop(): Promise<void> {
    this.#node?.port.postMessage({ type: 'reset' });
    if (this.#element) {
      this.#element.pause();
      this.#element = null;
    }
    this.#revokeObjectUrl();
    await this.#releaseGraph();
  }

  /**
   * Disconnect the node and close the context, once.
   *
   * An AudioContext is a hardware resource: leaving one open per failed
   * generation is a leak the operator eventually hears as the browser refusing
   * to make another.
   */
  async #releaseGraph(): Promise<void> {
    this.#node?.disconnect();
    this.#node = null;
    const context = this.#context;
    this.#context = null;
    if (context) await context.close().catch(() => {});
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
 * @returns The audio element and a promise that settles when playback starts.
 */
function playCachedClip(url: string): {
  readonly element: HTMLAudioElement;
  readonly started: Promise<void>;
} {
  const element = new Audio(url);
  return { element, started: element.play() };
}

/** Anything currently making sound, reduced to the one thing we ask of it. */
interface Audible {
  stop(): Promise<void>;
}

/**
 * The single owner of audible output.
 *
 * Generation and cached replay used to hold separate handles, each of which
 * stopped only itself, so pressing Generate during a replay left both sounding
 * and turned a comparison into an overlap. Cross-stopping at every call site
 * would have worked until the third playback entry point forgot to — one owner
 * makes "silence whatever is playing" the default instead of a rule each new
 * caller has to remember.
 */
export class PlaybackOwner {
  readonly #backend: AudioBackend;
  #current: Audible | null = null;

  /**
   * @param backend - How the streaming path reaches the audio hardware.
   */
  constructor(backend: AudioBackend) {
    this.#backend = backend;
  }

  /**
   * Play a gateway speech response, silencing whatever preceded it.
   *
   * @param response - The `/api/speech` response.
   * @param startedAt - `performance.now()` at the moment the request was sent.
   * @param callbacks - Progress hooks.
   * @returns What the streaming player observed, unchanged.
   */
  async play(
    response: Response,
    startedAt: number,
    callbacks: PlayerCallbacks = {},
  ): Promise<PlaybackResult> {
    await this.#silence();
    const player = new StreamingPlayer(this.#backend);
    this.#current = player;
    return player.play(response, startedAt, callbacks);
  }

  /**
   * Play a cached clip, silencing whatever preceded it.
   *
   * @param url - The gateway's clip route.
   * @returns A promise settling when the element actually starts, so the caller
   *   can keep its in-place activity visible until there is audio to hear.
   */
  async playCached(url: string): Promise<void> {
    await this.#silence();
    const cached = playCachedClip(url);
    this.#current = {
      stop: async () => cached.element.pause(),
    };
    await cached.started;
  }

  /** Silence the current source and own nothing. */
  async stop(): Promise<void> {
    await this.#silence();
  }

  async #silence(): Promise<void> {
    const current = this.#current;
    this.#current = null;
    if (!current) return;
    try {
      await current.stop();
    } catch {
      // The operator pressed a play control and is owed audio. A handle that
      // refuses to stop is dropped here rather than allowed to cancel the sound
      // that was actually asked for.
    }
  }
}
