/**
 * Playback: conversion, chunk boundaries, streaming before completion, fallback.
 */

import { describe, expect, it, vi } from 'vitest';

import { StreamingPlayer, type AudioBackend } from '../src/audio/player.js';
import { INT16_SCALE, alignSamples, loadPcmWorklet, s16leToFloat32 } from '../src/audio/worklet.js';

function pcmBytes(samples: number[]): Uint8Array {
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

function fakeBackend(options: { workletLoads: boolean }): AudioBackend {
  return {
    workletUrl: 'about:blank',
    createContext: () =>
      ({
        destination: {},
        audioWorklet: {
          addModule: options.workletLoads
            ? async () => {}
            : async () => {
                throw new Error('AudioWorklet unavailable');
              },
        },
        close: async () => {},
      }) as unknown as AudioContext,
  };
}

function streamingResponse(chunks: Uint8Array[], delayMs = 0): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'audio/pcm',
      'x-sample-rate': '24000',
      'x-sample-format': 's16le',
      'x-clip-id': 'clip-1',
    },
  });
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

describe('chunk boundaries produce no discontinuity', () => {
  it('carries an odd byte into the next chunk instead of dropping it', () => {
    // A chunk ending mid-sample would otherwise produce a click at every
    // boundary.
    const whole = pcmBytes([100, 200, 300, 400]);
    const first = whole.subarray(0, 3);
    const second = whole.subarray(3);

    const a = alignSamples(new Uint8Array(0), first);
    expect(a.samples.length).toBe(1);
    expect(a.carry.length).toBe(1);

    const b = alignSamples(a.carry, second);
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
        const aligned = alignSamples(carry, whole.subarray(offset, offset + splitAt));
        carry = aligned.carry;
        collected.push(...aligned.samples);
      }
      expect(collected).toEqual(reference);
    }
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
    const rates: number[] = [];
    const backend: AudioBackend = {
      ...fakeBackend({ workletLoads: true }),
      createContext: (sampleRate: number) => {
        rates.push(sampleRate);
        return fakeBackend({ workletLoads: true }).createContext(sampleRate);
      },
    };

    await new StreamingPlayer(backend).play(
      streamingResponse([pcmBytes([1, 2])]),
      performance.now(),
    );
    expect(rates).toEqual([24000]);

    vi.unstubAllGlobals();
  });
});

describe('a worklet failure degrades to audio, never to silence', () => {
  it('falls back to buffered playback and still reports first audio', async () => {
    const response = new Response(new Uint8Array(64), {
      headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-clip-id': 'clip-2' },
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

  it('reports an unloadable module rather than throwing', async () => {
    const context = fakeBackend({ workletLoads: false }).createContext(24000);
    expect(await loadPcmWorklet(context, 'about:blank')).toBe(false);
  });

  it('treats a context with no audioWorklet as unusable', async () => {
    expect(await loadPcmWorklet({} as AudioContext, 'about:blank')).toBe(false);
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
    const response = new Response(body, {
      headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' },
    });

    const result = await new StreamingPlayer(fakeBackend({ workletLoads: true })).play(
      response,
      performance.now(),
    );
    expect(result.incomplete).toBe(true);
    expect(result.ttfaMs).not.toBeNull();

    vi.unstubAllGlobals();
  });
});
