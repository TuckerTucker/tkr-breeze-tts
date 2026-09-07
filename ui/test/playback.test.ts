/**
 * Playback: conversion, chunk boundaries, streaming before completion, the
 * declaration the client refuses to guess at, and fallback.
 */

import { describe, expect, it, vi } from 'vitest';

import { StreamingPlayer, type AudioBackend } from '../src/audio/player.js';
import {
  INT16_SCALE,
  S16LE_CONVERTER,
  TransportDeclarationError,
  alignSamples,
  converterFor,
  loadPcmWorklet,
  parseDeclaredTransport,
  s16leToFloat32,
  wavFromPcm,
} from '../src/audio/worklet.js';

function pcmBytes(samples: number[]): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((value, index) => view.setInt16(index * 2, value, true));
  return new Uint8Array(buffer);
}

/** A fake worklet node that records everything the player hands it. */
class FakeWorkletNode {
  static instances: FakeWorkletNode[] = [];
  readonly messages: Array<Record<string, unknown>> = [];
  readonly port = {
    postMessage: (message: Record<string, unknown>): void => {
      this.messages.push(message);
    },
    onmessage: null as ((event: MessageEvent) => void) | null,
  };

  constructor() {
    FakeWorkletNode.instances.push(this);
  }

  connect(): void {}
  disconnect(): void {}
}

/** Records what the player did with the context it asked for. */
interface ContextLog {
  readonly rates: number[];
  closed: number;
}

function fakeBackend(options: { workletLoads: boolean; log?: ContextLog }): AudioBackend {
  return {
    workletUrl: 'about:blank',
    createContext: (sampleRate: number) => {
      options.log?.rates.push(sampleRate);
      return {
        destination: {},
        audioWorklet: {
          addModule: options.workletLoads
            ? async () => {}
            : async () => {
                throw new Error('AudioWorklet unavailable');
              },
        },
        close: async () => {
          if (options.log) options.log.closed += 1;
        },
      } as unknown as AudioContext;
    },
  };
}

function contextLog(): ContextLog {
  return { rates: [], closed: 0 };
}

/** Read a Blob's bytes; jsdom's Blob has FileReader but no arrayBuffer(). */
function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function audioHeaders(overrides: Record<string, string | null> = {}): Record<string, string> {
  const base: Record<string, string | null> = {
    'content-type': 'audio/pcm',
    'x-sample-rate': '24000',
    'x-sample-format': 's16le',
    'x-clip-id': 'clip-1',
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

function streamingResponse(
  chunks: Uint8Array[],
  delayMs = 0,
  headers: Record<string, string> = audioHeaders(),
): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(body, { headers });
}

describe('s16le to float32', () => {
  it('maps full scale exactly, so no sample clips on the way in', () => {
    const converted = s16leToFloat32(pcmBytes([0, 32767, -32768]));
    expect(converted[0]).toBe(0);
    expect(converted[1]).toBeCloseTo(32767 / INT16_SCALE, 9);
    expect(converted[2]).toBe(-1);
  });

  it('reads little-endian, not big', () => {
    // 0x0100 little-endian is 1; big-endian would be 256.
    expect(s16leToFloat32(new Uint8Array([0x01, 0x00]))[0]).toBeCloseTo(1 / INT16_SCALE, 9);
  });

  it('ignores a trailing odd byte rather than reading half a sample', () => {
    expect(s16leToFloat32(new Uint8Array([0x01, 0x00, 0x7f])).length).toBe(1);
  });
});

describe('the declared transport', () => {
  it('takes the rate from the service and nothing else', () => {
    const declared = parseDeclaredTransport(
      new Headers({ 'x-sample-rate': '16000', 'x-sample-format': 's16le' }),
    );
    expect(declared.sampleRate).toBe(16000);
    expect(declared.converter).toBe(S16LE_CONVERTER);
  });

  it('refuses a missing rate rather than standing a default behind it', () => {
    expect(() => parseDeclaredTransport(new Headers({ 'x-sample-format': 's16le' })))
      .toThrow(TransportDeclarationError);
    expect(() => parseDeclaredTransport(new Headers({ 'x-sample-format': 's16le' })))
      .toThrow(/declared no sample rate/);
  });

  it('refuses a missing format rather than assuming the one it knows', () => {
    expect(() => parseDeclaredTransport(new Headers({ 'x-sample-rate': '24000' })))
      .toThrow(/declared no sample format/);
  });

  it('refuses a rate that is not a plausible number, quoting what arrived', () => {
    for (const rate of ['fast', '', '24000.5', '1', '384000']) {
      expect(() =>
        parseDeclaredTransport(new Headers({ 'x-sample-rate': rate, 'x-sample-format': 's16le' })),
      ).toThrow(TransportDeclarationError);
    }
  });

  it('accepts the encoding however the service capitalised it', () => {
    expect(converterFor('S16LE')).toBe(S16LE_CONVERTER);
  });

  it('refuses an encoding it cannot convert, naming it', () => {
    // Reading f32le bytes as s16le produces sound, and wrong sound is harder to
    // diagnose than an error.
    expect(() => converterFor('f32le')).toThrow(/"f32le".*cannot convert/s);
    expect(() => converterFor('s24le')).toThrow(TransportDeclarationError);
  });
});

describe('chunk boundaries produce no discontinuity', () => {
  it('carries an odd byte into the next chunk instead of dropping it', () => {
    // A chunk ending mid-sample would otherwise produce a click at every
    // boundary.
    const whole = pcmBytes([100, 200, 300, 400]);
    const first = whole.subarray(0, 3);
    const second = whole.subarray(3);

    const a = alignSamples(new Uint8Array(0), first, S16LE_CONVERTER);
    expect(a.samples.length).toBe(1);
    expect(a.carry.length).toBe(1);

    const b = alignSamples(a.carry, second, S16LE_CONVERTER);
    const rejoined = [...a.samples, ...b.samples];
    const reference = [...s16leToFloat32(whole)];
    expect(rejoined).toEqual(reference);
  });

  it('produces the identical sample sequence however the bytes are split', () => {
    const values = Array.from({ length: 64 }, (_, index) => Math.round(1000 * Math.sin(index)));
    const whole = pcmBytes(values);
    const reference = [...s16leToFloat32(whole)];

    for (const splitAt of [1, 3, 7, 31, 63]) {
      let carry = new Uint8Array(0);
      const collected: number[] = [];
      for (let offset = 0; offset < whole.length; offset += splitAt) {
        const aligned = alignSamples(carry, whole.subarray(offset, offset + splitAt), S16LE_CONVERTER);
        carry = aligned.carry;
        collected.push(...aligned.samples);
      }
      expect(collected).toEqual(reference);
    }
  });

  it('measures a sample boundary in the declared width, not a remembered one', () => {
    const wide = { ...S16LE_CONVERTER, bytesPerSample: 4 };
    const aligned = alignSamples(new Uint8Array(0), new Uint8Array(6), wide);
    expect(aligned.carry.length).toBe(2);
  });
});

describe('the streaming path', () => {
  it('begins playback before the response completes', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    FakeWorkletNode.instances = [];

    const chunks = Array.from({ length: 5 }, () => pcmBytes(Array(240).fill(1000)));
    const response = streamingResponse(chunks, 10);

    const startedAt = performance.now();
    let firstAudioAt: number | null = null;
    const player = new StreamingPlayer(fakeBackend({ workletLoads: true }));
    const result = await player.play(response, startedAt, {
      onFirstAudio: () => {
        firstAudioAt = performance.now();
      },
    });

    expect(result.mode).toBe('streaming');
    expect(result.fellBack).toBe(false);
    expect(result.clipId).toBe('clip-1');
    expect(firstAudioAt).not.toBeNull();
    // First audio landed before the last chunk did.
    expect(firstAudioAt! - startedAt).toBeLessThan(performance.now() - startedAt);
    expect(result.ttfaMs).toBeLessThan(chunks.length * 10 + 50);

    vi.unstubAllGlobals();
  });

  it('feeds every chunk to the worklet and ends the stream', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    FakeWorkletNode.instances = [];

    const player = new StreamingPlayer(fakeBackend({ workletLoads: true }));
    await player.play(
      streamingResponse([pcmBytes([1, 2, 3, 4]), pcmBytes([5, 6])]),
      performance.now(),
    );

    const node = FakeWorkletNode.instances[0]!;
    const sampleMessages = node.messages.filter((message) => message.type === 'samples');
    expect(sampleMessages).toHaveLength(2);
    expect(node.messages.at(-1)).toEqual({ type: 'end' });

    vi.unstubAllGlobals();
  });

  it('creates the context at the model’s own rate, not the browser default', async () => {
    // A context at 48kHz fed 24kHz samples plays at double speed — a failure
    // that sounds like a broken model rather than a broken graph.
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    const log = contextLog();

    await new StreamingPlayer(fakeBackend({ workletLoads: true, log })).play(
      streamingResponse([pcmBytes([1, 2])]),
      performance.now(),
    );
    expect(log.rates).toEqual([24000]);

    vi.unstubAllGlobals();
  });

  it('follows the service to a rate that is not the usual one', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    const log = contextLog();

    await new StreamingPlayer(fakeBackend({ workletLoads: true, log })).play(
      streamingResponse([pcmBytes([1, 2])], 0, audioHeaders({ 'x-sample-rate': '16000' })),
      performance.now(),
    );
    expect(log.rates).toEqual([16000]);

    vi.unstubAllGlobals();
  });
});

describe('a declaration the browser cannot play', () => {
  it('names the missing rate instead of defaulting to the usual one', async () => {
    const log = contextLog();
    const player = new StreamingPlayer(fakeBackend({ workletLoads: true, log }));

    await expect(
      player.play(
        streamingResponse([pcmBytes([1, 2])], 0, audioHeaders({ 'x-sample-rate': null })),
        performance.now(),
      ),
    ).rejects.toThrow(TransportDeclarationError);
    expect(log.rates).toEqual([]);
  });

  it('never lets a non-numeric rate reach the AudioContext constructor', async () => {
    // `new AudioContext({ sampleRate: NaN })` throws, and the operator would
    // read that as an unexplained generation failure.
    const log = contextLog();
    const player = new StreamingPlayer(fakeBackend({ workletLoads: true, log }));

    await expect(
      player.play(
        streamingResponse([pcmBytes([1, 2])], 0, audioHeaders({ 'x-sample-rate': 'fast' })),
        performance.now(),
      ),
    ).rejects.toThrow(/"fast"/);
    expect(log.rates).toEqual([]);
  });

  it('refuses an encoding it cannot convert rather than misreading the bytes', async () => {
    const log = contextLog();
    const player = new StreamingPlayer(fakeBackend({ workletLoads: true, log }));

    await expect(
      player.play(
        streamingResponse([pcmBytes([1, 2])], 0, audioHeaders({ 'x-sample-format': 'f32le' })),
        performance.now(),
      ),
    ).rejects.toThrow(/f32le/);
    expect(log.rates).toEqual([]);
  });
});

describe('a worklet failure degrades to audio, never to silence', () => {
  it('falls back to buffered playback and still reports first audio', async () => {
    const response = new Response(new Uint8Array(64), {
      headers: audioHeaders({ 'x-clip-id': 'clip-2' }),
    });

    const reasons: string[] = [];
    const player = new StreamingPlayer(fakeBackend({ workletLoads: false }));
    const result = await player.play(response, performance.now(), {
      onFallback: (reason) => reasons.push(reason),
    });

    expect(result.mode).toBe('buffered');
    expect(result.fellBack).toBe(true);
    expect(result.ttfaMs).not.toBeNull();
    expect(result.clipId).toBe('clip-2');
    expect(reasons[0]).toMatch(/AudioWorklet is unavailable/);
  });

  it('frames the raw PCM it hands to the element, at the declared rate', async () => {
    // An <audio> element decodes containers, not bare samples: handing it
    // unframed PCM labelled audio/wav is silence with a content type on it.
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:fallback';
    });
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });

    const response = new Response(pcmBytes([1, 2, 3, 4]), {
      headers: audioHeaders({ 'x-sample-rate': '16000' }),
    });
    const result = await new StreamingPlayer(fakeBackend({ workletLoads: false })).play(
      response,
      performance.now(),
    );

    const framed = new DataView(await bytesOf(blobs[0]!));
    const ascii = (offset: number): string =>
      String.fromCharCode(...[0, 1, 2, 3].map((i) => framed.getUint8(offset + i)));
    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
    expect(framed.getUint32(24, true)).toBe(16000);
    expect(framed.getUint16(34, true)).toBe(16);
    expect(framed.getUint32(40, true)).toBe(8);
    // The reported byte count is the audio received, not the container built
    // around it.
    expect(result.bytes).toBe(8);

    vi.unstubAllGlobals();
  });

  it('degrades to buffered audio when the node itself will not start', async () => {
    // The module loaded but the node throws. The body is untouched, so this is
    // still recoverable into audio rather than into a rethrow.
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        constructor() {
          throw new Error('pcm-processor is not registered');
        }
      },
    );
    const log = contextLog();
    const reasons: string[] = [];

    const result = await new StreamingPlayer(fakeBackend({ workletLoads: true, log })).play(
      new Response(new Uint8Array(64), { headers: audioHeaders() }),
      performance.now(),
      { onFallback: (reason) => reasons.push(reason) },
    );

    expect(result.mode).toBe('buffered');
    expect(result.fellBack).toBe(true);
    expect(reasons[0]).toMatch(/not registered/);
    expect(log.closed).toBe(1);

    vi.unstubAllGlobals();
  });

  it('reports an unloadable module rather than throwing', async () => {
    const context = fakeBackend({ workletLoads: false }).createContext(24000);
    expect(await loadPcmWorklet(context, 'about:blank')).toBe(false);
  });

  it('treats a context with no audioWorklet as unusable', async () => {
    expect(await loadPcmWorklet({} as AudioContext, 'about:blank')).toBe(false);
  });
});

describe('the context is released on every exit path', () => {
  it('closes it when the worklet is unavailable and the element takes over', async () => {
    const log = contextLog();
    await new StreamingPlayer(fakeBackend({ workletLoads: false, log })).play(
      new Response(new Uint8Array(64), { headers: audioHeaders() }),
      performance.now(),
    );
    expect(log.closed).toBe(1);
  });

  it('closes it when the streaming path throws, instead of leaving it to the next generation', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    FakeWorkletNode.instances = [];
    const log = contextLog();

    // A 200 with audio headers and no body at all: nothing to stream, and
    // nothing left to buffer either.
    const player = new StreamingPlayer(fakeBackend({ workletLoads: true, log }));
    await expect(
      player.play(new Response(null, { headers: audioHeaders() }), performance.now()),
    ).rejects.toThrow(/no body to stream/);
    expect(log.closed).toBe(1);

    vi.unstubAllGlobals();
  });

  it('closes it once when stop() follows a completed stream', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    FakeWorkletNode.instances = [];
    const log = contextLog();

    const player = new StreamingPlayer(fakeBackend({ workletLoads: true, log }));
    await player.play(streamingResponse([pcmBytes([1, 2])]), performance.now());
    expect(log.closed).toBe(0);
    await player.stop();
    await player.stop();
    expect(log.closed).toBe(1);

    vi.unstubAllGlobals();
  });
});

describe('the buffered path', () => {
  it('is selected by the response content type, not by client configuration', async () => {
    // The transport is read from the response, so the gateway's setting is
    // honoured without the client being configured twice.
    const wav = new Response(new Uint8Array(44 + 100), {
      headers: { 'content-type': 'audio/wav', 'x-clip-id': 'clip-3' },
    });
    const result = await new StreamingPlayer(fakeBackend({ workletLoads: true })).play(
      wav,
      performance.now(),
    );
    expect(result.mode).toBe('buffered');
    expect(result.fellBack).toBe(false);
    expect(result.bytes).toBe(144);
  });

  it('plays a gateway WAV as it arrived, since the file already states its own rate', async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return 'blob:buffered';
      },
      revokeObjectURL: vi.fn(),
    });

    const body = wavFromPcm(pcmBytes([1, 2]), {
      sampleRate: 24000,
      converter: S16LE_CONVERTER,
    });
    await new StreamingPlayer(fakeBackend({ workletLoads: true })).play(
      new Response(body, { headers: { 'content-type': 'audio/wav' } }),
      performance.now(),
    );
    expect(blobs[0]!.size).toBe(body.byteLength);

    vi.unstubAllGlobals();
  });
});

describe('an aborted stream', () => {
  it('stops cleanly and reports the clip as incomplete rather than fast', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    FakeWorkletNode.instances = [];

    // The chunk must actually be delivered before the error, or the stream
    // errors with the queue discarded and nothing was ever played.
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(pcmBytes([1, 2, 3, 4]));
          return;
        }
        controller.error(new Error('upstream went away'));
      },
    });
    const response = new Response(body, { headers: audioHeaders() });

    const result = await new StreamingPlayer(fakeBackend({ workletLoads: true })).play(
      response,
      performance.now(),
    );
    expect(result.incomplete).toBe(true);
    expect(result.ttfaMs).not.toBeNull();

    vi.unstubAllGlobals();
  });
});
