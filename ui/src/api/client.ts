/**
 * The gateway client.
 *
 * Every request is same-origin and relative. There is no base URL anywhere in
 * this file, and that is the point: the browser is never told the `.modal.run`
 * endpoint, so there is no path by which page source could reveal it or call
 * around the gateway.
 *
 * @module
 */

import type { Clip } from '../state/history.js';
import type { Health } from '../state/readiness.js';
import type { StagedReferenceResource } from '../state/reference.js';
import type {
  CuePatch,
  Script,
  ScriptDefaults,
  ScriptSummary,
} from '../state/script.js';
import type { Voice } from '../state/voices.js';

/** A typed failure from the gateway. */
export interface GatewayFailure {
  readonly type:
    | 'busy'
    | 'auth'
    | 'timeout'
    | 'upstream'
    | 'unavailable'
    | 'validation'
    | 'format'
    | 'reference'
    | 'not-found';
  readonly message: string;
  readonly remedy?: string;
}

/** Raised for any non-2xx gateway response. */
export class ApiError extends Error {
  readonly failure: GatewayFailure;

  constructor(failure: GatewayFailure) {
    super(failure.message);
    this.name = 'ApiError';
    this.failure = failure;
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  let failure: GatewayFailure = {
    type: 'upstream',
    message: `the gateway returned ${response.status}`,
  };
  try {
    const body = (await response.json()) as { error?: GatewayFailure };
    if (body.error) failure = body.error;
  } catch {
    // Keep the generic failure.
  }
  throw new ApiError(failure);
}

/** What the console sends for one generation. */
export interface SpeechRequest {
  readonly text: string;
  readonly instruction: string;
  readonly cfgScale: number;
  readonly seed: number;
  /** Optional only for legacy callers; the gateway derives shape from reference presence. */
  readonly mode?: 'design' | 'clone' | 'direction';
  /** A recorded or uploaded reference. */
  readonly refAudio?: File | Blob;
  /** A reference staged once through the gateway, with a selected window. */
  readonly referenceId?: string;
  readonly refStart?: number;
  readonly refEnd?: number;
  readonly refText?: string;
  /** A library voice, which supplies both halves server-side. */
  readonly voiceId?: string;
  /** A cached clip promoted to a reference. */
  readonly refClipId?: string;
}

/**
 * Build the multipart body for a synthesis request.
 *
 * Exported so the field set can be asserted directly — in particular that no
 * language field is ever sent, since the vendor API has none and the model
 * infers language from the text.
 *
 * @param request - What the console holds.
 * @returns The form to post.
 */
export function speechForm(request: SpeechRequest): FormData {
  const form = new FormData();
  form.set('text', request.text);
  form.set('instruction', request.instruction);
  form.set('cfg_scale', String(request.cfgScale));
  form.set('seed', String(request.seed));
  if (request.mode) form.set('mode', request.mode);
  if (request.voiceId) form.set('voice_id', request.voiceId);
  if (request.referenceId) form.set('reference_id', request.referenceId);
  if (request.refStart !== undefined) form.set('ref_start', String(request.refStart));
  if (request.refEnd !== undefined) form.set('ref_end', String(request.refEnd));
  if (request.refText) form.set('ref_text', request.refText);
  if (request.refAudio) form.set('ref_audio', request.refAudio, 'reference.wav');
  return form;
}

/** The gateway's HTTP surface, as the UI uses it. */
export class GatewayClient {
  readonly #fetch: typeof fetch;

  /**
   * @param fetchImpl - Injected fetch, so components can be tested without a
   *   server.
   */
  constructor(fetchImpl: typeof fetch = fetch.bind(globalThis)) {
    this.#fetch = fetchImpl;
  }

  /** Read readiness, limits and recorded measurements. Never touches upstream. */
  async health(): Promise<Health> {
    return unwrap<Health>(await this.#fetch('/api/health'));
  }

  /** Deliberately wake the container. An action, never a poll. */
  async wake(): Promise<{ readiness: Health['readiness'] }> {
    return unwrap(await this.#fetch('/api/wake', { method: 'POST' }));
  }

  /** Read the recorded CFG fall-off finding, or its unmeasured default. */
  async findings(): Promise<unknown> {
    return unwrap(await this.#fetch('/api/findings'));
  }

  /**
   * Normalise, transcribe, and stage a reference recording once.
   *
   * @param audio - An uploaded file or microphone recording.
   * @returns The staged resource and its precomputed waveform/transcript data.
   */
  async stageReference(audio: File | Blob): Promise<StagedReferenceResource> {
    const form = new FormData();
    const filename = audio instanceof File ? audio.name : 'reference.wav';
    form.set('file', audio, filename);
    return unwrap<StagedReferenceResource>(
      await this.#fetch('/api/reference', {
        method: 'POST',
        body: form,
      }),
    );
  }

  /** The exact selected window of a staged reference as playable WAV audio. */
  referenceAudioUrl(id: string, start: number, end: number): string {
    const query = new URLSearchParams({
      start: String(start),
      end: String(end),
    });
    return `/api/reference/${encodeURIComponent(id)}/audio?${query.toString()}`;
  }

  /** Remove transient staged reference audio and its sidecar. */
  async deleteReference(id: string): Promise<{ removed: boolean }> {
    return unwrap<{ removed: boolean }>(
      await this.#fetch(`/api/reference/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    );
  }

  /**
   * Send one synthesis request.
   *
   * @param request - The console's state.
   * @returns The raw response, so the player can stream it rather than buffer
   *   it here — buffering at this layer would discard the whole point.
   */
  async speech(request: SpeechRequest): Promise<Response> {
    const response = await this.#fetch('/api/speech', {
      method: 'POST',
      body: speechForm(request),
    });
    if (!response.ok) return unwrap(response);
    return response;
  }

  /** List cached clips. */
  async clips(): Promise<Clip[]> {
    return (await unwrap<{ clips: Clip[] }>(await this.#fetch('/api/clips'))).clips;
  }

  /** The URL a clip replays and downloads from. */
  clipUrl(id: string): string {
    return `/api/clips/${id}`;
  }

  /** Read one cached clip for promotion through staged reference intake. */
  async clipAudio(id: string): Promise<Blob> {
    const response = await this.#fetch(this.clipUrl(id));
    if (!response.ok) return unwrap<Blob>(response);
    return response.blob();
  }

  /** List saved voices. */
  async voices(): Promise<Voice[]> {
    return (await unwrap<{ voices: Voice[] }>(await this.#fetch('/api/voices'))).voices;
  }

  /** Save a cached clip as a named voice. */
  async saveVoice(input: {
    clipId: string;
    name: string;
    transcript?: string;
    defaultDirection?: string | null;
  }): Promise<Voice> {
    return unwrap<Voice>(
      await this.#fetch('/api/voices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );
  }

  /** Rename a voice or change its default direction. */
  async updateVoice(id: string, changes: Record<string, unknown>): Promise<Voice> {
    return unwrap<Voice>(
      await this.#fetch(`/api/voices/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      }),
    );
  }

  /** Delete a voice. Reversible for the undo window. */
  async deleteVoice(id: string): Promise<{ undoWindowMs: number }> {
    return unwrap(await this.#fetch(`/api/voices/${id}`, { method: 'DELETE' }));
  }

  /** Undo a delete inside its window. */
  async restoreVoice(id: string): Promise<Voice> {
    return this.updateVoice(id, { restore: true });
  }

  /** Import a dropped VTT or text file as a cue list. */
  async importScript(
    source: string,
    filename: string,
    defaults?: Partial<ScriptDefaults>,
  ): Promise<Script> {
    return unwrap<Script>(
      await this.#fetch('/api/scripts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, filename, ...(defaults ? { defaults } : {}) }),
      }),
    );
  }

  /** List local script documents without loading every cue body. */
  async scripts(): Promise<ScriptSummary[]> {
    return (
      await unwrap<{ scripts: ScriptSummary[] }>(await this.#fetch('/api/scripts'))
    ).scripts;
  }

  /** Read a script, with every cue's state refreshed against the cache. */
  async script(id: string): Promise<Script> {
    return unwrap<Script>(await this.#fetch(`/api/scripts/${id}`));
  }

  /** Update common delivery values and receive selectively invalidated cues. */
  async updateScript(
    id: string,
    defaults: Partial<ScriptDefaults>,
  ): Promise<Script> {
    return unwrap<Script>(
      await this.#fetch(`/api/scripts/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaults }),
      }),
    );
  }

  /** Edit one cue. */
  async patchCue(
    scriptId: string,
    cueId: string,
    patch: CuePatch | Record<string, unknown>,
  ): Promise<Script> {
    return unwrap<Script>(
      await this.#fetch(`/api/scripts/${scriptId}/cues/${cueId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    );
  }

  /**
   * Run a script, reporting progress as each cue changes state.
   *
   * @param scriptId - The script to run.
   * @param onProgress - Called per cue transition.
   * @returns The run summary.
   */
  async runScript(
    scriptId: string,
    onProgress: (event: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`/api/scripts/${scriptId}/run`, { method: 'POST' });
    if (!response.ok) return unwrap(response);

    const reader = response.body?.getReader();
    if (!reader) return {};
    const decoder = new TextDecoder();
    let buffer = '';
    let summary: Record<string, unknown> = {};

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const event = /^event:\s*(\w+)/m.exec(frame)?.[1];
        const data = /^data:\s*(.*)$/m.exec(frame)?.[1];
        if (!data) continue;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (event === 'done') summary = parsed;
        else onProgress(parsed);
      }
    }
    return summary;
  }

  /** Export URLs, which the browser fetches directly. */
  scriptExportUrls(id: string): { vtt: string; wav: string } {
    return { vtt: `/api/scripts/${id}/export.vtt`, wav: `/api/scripts/${id}/export.wav` };
  }

  /** Fetch one script export so application activity covers the whole operation. */
  async exportScript(id: string, format: 'vtt' | 'wav'): Promise<Blob> {
    const response = await this.#fetch(`/api/scripts/${id}/export.${format}`);
    if (!response.ok) return unwrap<Blob>(response);
    return response.blob();
  }
}
