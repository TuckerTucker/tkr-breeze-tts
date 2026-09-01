/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  GatewayClient,
  speechForm,
} from '../src/api/client.js';
import type { StagedReferenceResource } from '../src/state/reference.js';

const STAGED_REFERENCE: StagedReferenceResource = {
  id: 'reference/with spaces',
  createdAt: 1_700_000_000_000,
  bytes: 48_044,
  durationSeconds: 1,
  sampleRate: 24_000,
  format: 's16le',
  channels: 1,
  peaks: [0.1, 0.8],
  words: [{ word: 'hello', start: 0, end: 0.8 }],
  transcript: 'hello',
  language: 'en',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('staged reference client', () => {
  it('reads promoted clip audio through the injected gateway transport', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { 'content-type': 'audio/wav' },
      }),
    );
    const client = new GatewayClient(fetchImpl as unknown as typeof fetch);

    const clip = await client.clipAudio('clip/one');
    expect(fetchImpl).toHaveBeenCalledWith('/api/clips/clip/one');
    expect(clip.type).toBe('audio/wav');
    expect(clip.size).toBe(4);
  });

  it('uploads one multipart file and returns the gateway resource', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(STAGED_REFERENCE));
    const client = new GatewayClient(fetchImpl as unknown as typeof fetch);
    const audio = new File(['audio'], 'speaker.webm', { type: 'audio/webm' });

    await expect(client.stageReference(audio)).resolves.toEqual(STAGED_REFERENCE);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/reference');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeUndefined();
    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const uploaded = body.get('file') as File;
    expect(uploaded.name).toBe('speaker.webm');
    expect(uploaded.type).toBe('audio/webm');
    expect(uploaded.size).toBe(audio.size);
  });

  it('builds an encoded URL for only the selected audio window', () => {
    const client = new GatewayClient(vi.fn() as unknown as typeof fetch);

    expect(client.referenceAudioUrl('reference/with spaces', 0.25, 0.875)).toBe(
      '/api/reference/reference%2Fwith%20spaces/audio?start=0.25&end=0.875',
    );
  });

  it('deletes the staged WAV and sidecar through the reference route', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ removed: true }));
    const client = new GatewayClient(fetchImpl as unknown as typeof fetch);

    await expect(client.deleteReference('reference/with spaces')).resolves.toEqual({
      removed: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/reference/reference%2Fwith%20spaces',
      { method: 'DELETE' },
    );
  });

  it('surfaces typed intake failures from the gateway', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            type: 'unavailable',
            message: 'transcription is offline',
            remedy: 'Deploy the configured ASR endpoint.',
          },
        },
        503,
      ),
    );
    const client = new GatewayClient(fetchImpl as unknown as typeof fetch);

    const rejection = client.stageReference(new Blob(['audio']));
    await expect(rejection).rejects.toBeInstanceOf(ApiError);
    await expect(rejection).rejects.toMatchObject({
      failure: {
        type: 'unavailable',
        remedy: 'Deploy the configured ASR endpoint.',
      },
    });
  });
});

describe('staged reference synthesis form', () => {
  it('sends the id, exact window, and transcript without re-uploading audio', () => {
    const form = speechForm({
      text: 'Generate this line',
      instruction: 'Match the speaker.',
      cfgScale: 1,
      seed: 42,
      mode: 'clone',
      referenceId: 'staged-123',
      refStart: 0,
      refEnd: 1.25,
      refText: 'hello world',
    });

    expect(Object.fromEntries(form.entries())).toEqual({
      text: 'Generate this line',
      instruction: 'Match the speaker.',
      cfg_scale: '1',
      seed: '42',
      mode: 'clone',
      reference_id: 'staged-123',
      ref_start: '0',
      ref_end: '1.25',
      ref_text: 'hello world',
    });
    expect(form.get('ref_audio')).toBeNull();
  });
});
