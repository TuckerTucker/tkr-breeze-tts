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
import type { Health, Readiness } from '../state/readiness.js';
import type { StagedReferenceResource } from '../state/reference.js';
import type {
  CuePatch,
  CueState,
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

/**
 * Read the typed envelope out of a refusal, or synthesise one.
 *
 * Split out of `unwrap` because the login exchange needs the same envelope
 * without the central auth handling: a rejected password is the gate working,
 * not a session that went away underneath the console.
 *
 * @param response - A non-2xx response.
 * @returns The gateway's typed failure, or a generic one when the body is not.
 */
async function readFailure(response: Response): Promise<GatewayFailure> {
  const generic: GatewayFailure = {
    type: 'upstream',
    message: `the gateway returned ${response.status}`,
  };
  try {
    const body = (await response.json()) as { error?: GatewayFailure };
    return body.error ?? generic;
  } catch {
    return generic;
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  throw new ApiError(await readFailure(response));
}

/** Notified when a call was refused because no session backs it any more. */
export type AuthRequiredListener = (failure: GatewayFailure) => void;

/** Why a login attempt did not produce a session. */
export type SessionRefusal = 'rejected' | 'rate-limited' | 'unavailable';

/**
 * The result of one login attempt.
 *
 * A discriminated outcome rather than a thrown error, because the three
 * refusals have three different remedies and the status line is the only thing
 * that separates them — "wrong password" said to someone who is being rate
 * limited, or to someone whose network is down, is a lie with a wrong fix
 * attached.
 */
export type SessionOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: SessionRefusal;
      readonly message: string;
      readonly remedy?: string;
    };

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

/**
 * One cue transition, exactly as the run stream already reports it.
 *
 * The gateway has always sent this body; the browser used to throw it away and
 * refetch the whole document to learn what it had just been told.
 */
export interface ScriptRunProgress {
  readonly scriptId: string;
  readonly cueId: string;
  readonly index: number;
  readonly total: number;
  readonly state: CueState;
  readonly fromCache: boolean;
  readonly problem: string | null;
}

const CUE_STATES: readonly CueState[] = [
  'queued',
  'generating',
  'done',
  'stale',
  'failed',
  'unrunnable',
];

/**
 * A run frame is only applied when it carries the cue and the state it names.
 *
 * A malformed frame is dropped rather than patched in: a cue rendered into an
 * unknown state would be worse than one still showing its previous one, and the
 * run's closing refresh corrects anything a dropped frame left behind.
 */
function isScriptRunProgress(value: Record<string, unknown>): value is ScriptRunProgress & Record<string, unknown> {
  return (
    typeof value.cueId === 'string' &&
    CUE_STATES.includes(value.state as CueState)
  );
}

/** The gateway's HTTP surface, as the UI uses it. */
export class GatewayClient {
  readonly #fetch: typeof fetch;
  readonly #authListeners = new Set<AuthRequiredListener>();

  /**
   * @param fetchImpl - Injected fetch, so components can be tested without a
   *   server.
   */
  constructor(fetchImpl: typeof fetch = fetch.bind(globalThis)) {
    this.#fetch = fetchImpl;
  }

  /**
   * Learn, once, that the session behind every call has gone.
   *
   * Central here rather than at each call site: an expiry can land on any of
   * two dozen requests, and a shell that only noticed it on the ones somebody
   * remembered to check would leave the console rendering against a gateway
   * that refuses everything.
   *
   * @param listener - Called with the typed failure that raised the gate.
   * @returns An unsubscribe, so a remount does not accumulate handlers.
   */
  onAuthRequired(listener: AuthRequiredListener): () => void {
    this.#authListeners.add(listener);
    return () => {
      this.#authListeners.delete(listener);
    };
  }

  #raiseGate(failure: GatewayFailure): void {
    for (const listener of this.#authListeners) listener(failure);
  }

  /** Unwrap a response, reporting a lost session before the caller sees it. */
  async #read<T>(response: Response): Promise<T> {
    try {
      return await unwrap<T>(response);
    } catch (error) {
      if (error instanceof ApiError && error.failure.type === 'auth') {
        this.#raiseGate(error.failure);
      }
      throw error;
    }
  }

  /**
   * Exchange the shared password for a session cookie.
   *
   * Deliberately outside `#read`: a 401 here is the gate refusing a password
   * somebody just typed, and routing it through the central handler would raise
   * the gate at a viewer who is already standing in front of it.
   *
   * @param password - Exactly what the viewer typed, unmodified.
   * @returns Whether a session now exists, and why not when it does not.
   */
  async createSession(password: string): Promise<SessionOutcome> {
    let response: Response;
    try {
      response = await this.#fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch {
      // The password was never checked, so saying it was wrong would send the
      // viewer to retype something that is very likely correct.
      return {
        ok: false,
        reason: 'unavailable',
        message: 'The demo could not be reached.',
        remedy: 'Check the connection and try again — the password was not checked.',
      };
    }
    if (response.ok) return { ok: true };

    const failure = await readFailure(response);
    const remedy = failure.remedy ? { remedy: failure.remedy } : {};
    // The status line is the authority, not the message text: the gateway
    // sends one typed shape for both refusals, and the two need to read
    // differently.
    if (response.status === 429) {
      return { ok: false, reason: 'rate-limited', message: failure.message, ...remedy };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'rejected', message: failure.message, ...remedy };
    }
    return { ok: false, reason: 'unavailable', message: failure.message, ...remedy };
  }

  /**
   * Give the session back.
   *
   * Failures are swallowed: the viewer asked to be signed out, and the browser
   * stops trusting the session either way.
   */
  async endSession(): Promise<void> {
    try {
      await this.#fetch('/api/session', { method: 'DELETE' });
    } catch {
      // Nothing here can be retried usefully.
    }
  }

  /** Read readiness, limits and recorded measurements. Never touches upstream. */
  async health(): Promise<Health> {
    return this.#read<Health>(await this.#fetch('/api/health'));
  }

  /**
   * Ask the gateway to reach upstream, which starts a scaled-to-zero container.
   *
   * The standing rule is that readiness is INFERRED from idle time and never
   * polled — a poll after scale-down would itself trigger the cold start it was
   * checking for. This does not break that rule, it is its deliberate opposite:
   * a person pressing a button, having been told what it costs, choosing to pay
   * the cold start now instead of at their first generation.
   *
   * Returns the readiness observed after the wake, so the badge reflects what
   * actually happened rather than what was hoped for.
   *
   * @returns Readiness once upstream has answered.
   */
  async wake(): Promise<{ readiness: Readiness }> {
    return this.#read<{ readiness: Readiness }>(
      await this.#fetch('/api/wake', { method: 'POST' }),
    );
  }

  /** Read the recorded CFG fall-off finding, or its unmeasured default. */
  async findings(): Promise<unknown> {
    return this.#read(await this.#fetch('/api/findings'));
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
    return this.#read<StagedReferenceResource>(
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

  /**
   * Whether a staged reference is still on the gateway.
   *
   * Staged references expire by age while a restored draft can outlive them by
   * any amount of time, and nothing pushes that expiry to the browser. This is
   * the only way to learn it before a request that needs the audio, so a draft
   * can say the reference is gone instead of failing at Generate.
   *
   * @param id - The staged reference id held by a restored draft.
   * @returns True while the gateway can still serve the audio.
   * @throws ApiError - When the answer is a refusal rather than an absence, so
   *   a caller can never read "no session" as "the recording is gone" and
   *   discard a reference the gateway is still holding.
   */
  async referenceExists(id: string): Promise<boolean> {
    // HEAD, because the answer is the status line: the body is the whole WAV
    // and nothing here wants it. Fastify serves it from the same GET route.
    const response = await this.#fetch(
      `/api/reference/${encodeURIComponent(id)}/audio`,
      { method: 'HEAD' },
    );
    if (response.status === 401) {
      // A HEAD carries no envelope to read, so the one the gate always sends is
      // reconstructed rather than guessed at from an empty body.
      const failure: GatewayFailure = {
        type: 'auth',
        message: 'this demo is password protected',
      };
      this.#raiseGate(failure);
      throw new ApiError(failure);
    }
    return response.ok;
  }

  /** Remove transient staged reference audio and its sidecar. */
  async deleteReference(id: string): Promise<{ removed: boolean }> {
    return this.#read<{ removed: boolean }>(
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
    if (!response.ok) return this.#read<Response>(response);
    return response;
  }

  /** List cached clips. */
  async clips(): Promise<Clip[]> {
    return (await this.#read<{ clips: Clip[] }>(await this.#fetch('/api/clips'))).clips;
  }

  /** The URL a clip replays and downloads from. */
  clipUrl(id: string): string {
    return `/api/clips/${id}`;
  }

  /** Read one cached clip for promotion through staged reference intake. */
  async clipAudio(id: string): Promise<Blob> {
    const response = await this.#fetch(this.clipUrl(id));
    if (!response.ok) return this.#read<Blob>(response);
    return response.blob();
  }

  /** List saved voices. */
  async voices(): Promise<Voice[]> {
    return (await this.#read<{ voices: Voice[] }>(await this.#fetch('/api/voices'))).voices;
  }

  /** Save a cached clip as a named voice. */
  async saveVoice(input: {
    clipId: string;
    name: string;
    transcript?: string;
    defaultDirection?: string | null;
  }): Promise<Voice> {
    return this.#read<Voice>(
      await this.#fetch('/api/voices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );
  }

  /** Rename a voice or change its default direction. */
  async updateVoice(id: string, changes: Record<string, unknown>): Promise<Voice> {
    return this.#read<Voice>(
      await this.#fetch(`/api/voices/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      }),
    );
  }

  /** Delete a voice. Reversible for the undo window. */
  async deleteVoice(id: string): Promise<{ undoWindowMs: number }> {
    return this.#read<{ undoWindowMs: number }>(
      await this.#fetch(`/api/voices/${id}`, { method: 'DELETE' }),
    );
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
    return this.#read<Script>(
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
      await this.#read<{ scripts: ScriptSummary[] }>(await this.#fetch('/api/scripts'))
    ).scripts;
  }

  /** Read a script, with every cue's state refreshed against the cache. */
  async script(id: string): Promise<Script> {
    return this.#read<Script>(await this.#fetch(`/api/scripts/${id}`));
  }

  /** Update common delivery values and receive selectively invalidated cues. */
  async updateScript(
    id: string,
    defaults: Partial<ScriptDefaults>,
  ): Promise<Script> {
    return this.#read<Script>(
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
    return this.#read<Script>(
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
   * @param onProgress - Called per cue transition, with the transition itself.
   * @returns The run summary.
   */
  async runScript(
    scriptId: string,
    onProgress: (event: ScriptRunProgress) => void,
  ): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`/api/scripts/${scriptId}/run`, { method: 'POST' });
    if (!response.ok) return this.#read<Record<string, unknown>>(response);

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
        else if (isScriptRunProgress(parsed)) onProgress(parsed);
      }
    }
    return summary;
  }

  /** Fetch one script export so application activity covers the whole operation. */
  async exportScript(id: string, format: 'vtt' | 'wav'): Promise<Blob> {
    const response = await this.#fetch(`/api/scripts/${id}/export.${format}`);
    if (!response.ok) return this.#read<Blob>(response);
    return response.blob();
  }
}
