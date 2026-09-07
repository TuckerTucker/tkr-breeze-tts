/**
 * The access gate, and an expiry that costs nothing.
 *
 * The gateway serves its static shell to an unauthenticated visitor on purpose,
 * because the password field is React and has to load before anyone can type.
 * That same decision is what lets an expiry be recoverable: the console stays
 * mounted behind the gate, so the draft, the workspace and the chosen voice are
 * still there when the viewer comes back — a 401 on index.html would force a
 * page load and lose exactly the work the gate exists not to lose.
 *
 * The standing UX rules apply here without exception: status in place beside
 * the field, no toast, no dialog, nothing discarded.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { App } from '../src/App.js';
import { AccessGate } from '../src/components/AccessGate.js';
import { GatewayClient, type GatewayFailure } from '../src/api/client.js';
import type { AudioBackend } from '../src/audio/player.js';
import type { Voice } from '../src/state/voices.js';

const PASSWORD = 'the-shared-one';

const SAVED_VOICE: Voice = {
  id: 'voice-kept',
  name: 'Visible narrator',
  createdAt: 2,
  transcript: 'This voice remains ready for Speak.',
  defaultDirection: 'Warm and clear.',
  origin: { kind: 'designed', instruction: 'Warm and clear.' },
  durationSeconds: 4,
  sampleRate: 24_000,
  available: true,
};

const HEALTH = {
  readiness: 'warm',
  lastUpstreamAt: Date.now(),
  scaledownWindowMs: 300_000,
  transport: 'streaming',
  ffmpeg: { available: true, remedy: null },
  asr: { available: true, configured: true, remedy: null, lastError: null },
  cache: { enabled: true, clips: 0, bytes: 0 },
  voices: 1,
  references: { staged: 0, maxAgeMs: 86_400_000 },
  limits: {
    maxTokens: 512,
    tokenCeilingByBatch: { 1: 256, 2: 512, 4: 512 },
    backboneCeilingByBatch: { 1: 256, 2: 512 },
    referenceSeconds: null,
  },
  measured: { warmupMs: 41_234, coldTtfaMs: 45_000, warmTtfaMs: 38, rtf: 0.32 },
};

/** The gate's own envelopes, exactly as gateway/src/auth/plugin.ts sends them. */
const REFUSED = { error: { type: 'auth', message: 'this demo is password protected' } };
const REJECTED = { error: { type: 'auth', message: 'that password was not accepted' } };
const LIMITED = {
  error: {
    type: 'auth',
    message: 'too many attempts',
    remedy: 'Wait a few minutes and try again. Repeated attempts from one source are limited.',
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function stubAudio(): AudioBackend {
  return {
    workletUrl: 'about:blank',
    createContext: () =>
      ({
        destination: {},
        audioWorklet: {
          addModule: async () => {
            throw new Error('no worklet in jsdom');
          },
        },
        close: async () => {},
      }) as unknown as AudioContext,
  };
}

/** A hosted gateway: every `/api/*` route refused without a session cookie. */
function hostedGateway(options: { session?: boolean; limited?: boolean } = {}) {
  const state = { session: options.session ?? false, limited: options.limited ?? false };
  const seen: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url === '/api/session') {
      if (init?.method === 'DELETE') {
        state.session = false;
        return new Response(null, { status: 204 });
      }
      if (state.limited) return json(LIMITED, 429);
      const body = JSON.parse(String(init?.body)) as { password?: string };
      if (body.password !== PASSWORD) return json(REJECTED, 401);
      state.session = true;
      return new Response(null, { status: 204 });
    }
    // The one thing the gate never exempts.
    if (!state.session) return json(REFUSED, 401);
    if (url === '/api/speech') {
      return new Response(new Uint8Array(48_000), {
        headers: {
          'content-type': 'audio/pcm',
          'x-sample-rate': '24000',
          'x-sample-format': 's16le',
          'x-clip-id': 'clip-new',
        },
      });
    }
    if (url.startsWith('/api/health')) return json(HEALTH);
    if (url.startsWith('/api/findings')) {
      return json({ measured: false, cfgControl: { kind: 'presets', values: [1, 4], default: 1 } });
    }
    if (url.startsWith('/api/clips')) return json({ clips: [] });
    if (url.startsWith('/api/voices')) return json({ voices: [SAVED_VOICE] });
    return json({}, 404);
  }) as typeof fetch;
  return { impl, seen, state };
}

function passwordField(): HTMLInputElement {
  return screen.getByLabelText('Demo password') as HTMLInputElement;
}

async function enter(password: string): Promise<void> {
  fireEvent.change(passwordField(), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
}

describe('the gate in front of the console', () => {
  it('renders nothing of the console, and calls nothing, until it is submitted', async () => {
    const gateway = hostedGateway();
    render(
      <App
        client={new GatewayClient(gateway.impl)}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );

    await screen.findByLabelText('Demo password');
    expect(screen.queryByLabelText('Text to speak')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Speak/ })).not.toBeInTheDocument();

    // From here the gate is the whole surface, and it issues nothing on its own.
    gateway.seen.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.seen).toEqual([]);

    await enter(PASSWORD);
    // The first request an unauthenticated visitor makes is the one they chose.
    expect(gateway.seen[0]).toBe('/api/session');
    await waitFor(() => expect(screen.getByLabelText('Text to speak')).toBeInTheDocument());
  });

  it('says a rejection and a rate limit differently', async () => {
    const gateway = hostedGateway();
    render(
      <App
        client={new GatewayClient(gateway.impl)}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await screen.findByLabelText('Demo password');

    await enter('not-it');
    const rejection = await screen.findByText(/that password was not accepted/);
    expect(rejection).toBeInTheDocument();
    // In place beside the field, never as a toast or a dialog.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(passwordField()).toHaveFocus();

    gateway.state.limited = true;
    await enter('not-it-either');
    const limited = await screen.findByText(/too many attempts/);
    // Repeating "wrong password" at someone who may be typing it correctly is
    // a lie with the wrong remedy attached.
    expect(limited).not.toHaveTextContent(/not accepted/);
    expect(limited).toHaveTextContent(/Wait a few minutes/);
  });

  it('tells an unreachable demo apart from a refused password', async () => {
    const unreachable = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const client = new GatewayClient(unreachable);
    render(<AccessGate onSubmit={(pw) => client.createSession(pw)} returning={false} />);

    await enter('anything');
    const problem = await screen.findByText(/could not be reached/);
    expect(problem).toHaveTextContent(/password was not checked/);
    expect(problem).not.toHaveTextContent(/not accepted/);
  });

  it('refuses a second submit while the first is open', async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = vi.fn(async () => {
      await held;
      return { ok: true } as const;
    });
    render(<AccessGate onSubmit={calls} returning={false} />);

    // Constrained, not validated after the fact: nothing to press until there
    // is something to send.
    expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();

    fireEvent.change(passwordField(), { target: { value: 'once' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Checking…' }));

    release!();
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
  });

  it('issues only same-origin relative requests', async () => {
    const gateway = hostedGateway();
    render(
      <App
        client={new GatewayClient(gateway.impl)}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await screen.findByLabelText('Demo password');
    await enter(PASSWORD);
    await waitFor(() => expect(screen.getByLabelText('Text to speak')).toBeInTheDocument());

    expect(gateway.seen.length).toBeGreaterThan(0);
    for (const url of gateway.seen) expect(url.startsWith('/api/')).toBe(true);
  });
});

describe('an expiry that loses nothing', () => {
  it('raises the gate centrally, from any call the client makes', async () => {
    const refusing = (async () => json(REFUSED, 401)) as typeof fetch;
    const client = new GatewayClient(refusing);
    const raised: GatewayFailure[] = [];
    client.onAuthRequired((failure) => raised.push(failure));

    await expect(client.voices()).rejects.toThrow();
    await expect(client.clips()).rejects.toThrow();
    await expect(client.health()).rejects.toThrow();

    // Three different methods, one handler, no per-call-site special case.
    expect(raised).toHaveLength(3);
    expect(raised.every((failure) => failure.type === 'auth')).toBe(true);
  });

  it('does not raise the gate at someone already standing in front of it', async () => {
    const gateway = hostedGateway();
    const client = new GatewayClient(gateway.impl);
    const raised: GatewayFailure[] = [];
    client.onAuthRequired((failure) => raised.push(failure));

    const outcome = await client.createSession('wrong');
    expect(outcome).toMatchObject({ ok: false, reason: 'rejected' });
    expect(raised).toEqual([]);
  });

  it('gives back the draft and the workspace the viewer was in', async () => {
    const gateway = hostedGateway({ session: true });
    render(
      <App
        client={new GatewayClient(gateway.impl)}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());

    // Somewhere other than the default, holding something worth keeping.
    fireEvent.click(screen.getByRole('tab', { name: /Voices/ }));
    fireEvent.change(screen.getByLabelText('New voice name'), {
      target: { value: 'Half-named voice' },
    });
    fireEvent.change(screen.getByLabelText('Voice description'), {
      target: { value: 'A description written an hour before the session went away.' },
    });

    // The session goes away underneath them, and the next call finds out.
    gateway.state.session = false;
    fireEvent.click(screen.getByRole('button', { name: 'Audition voice' }));

    await screen.findByLabelText('Demo password');
    expect(screen.getByText(/Sign in again to continue/)).toBeInTheDocument();
    expect(screen.getByText(/still here/)).toBeInTheDocument();

    await enter(PASSWORD);

    // Back in Voices, not at the default screen, with the work intact.
    await waitFor(() =>
      expect(screen.getByLabelText('New voice name')).toHaveValue('Half-named voice'),
    );
    expect(screen.getByLabelText('Voice description')).toHaveValue(
      'A description written an hour before the session went away.',
    );
    expect(screen.getByRole('tab', { name: /Voices/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('offers a way out only where a gate exists to sign out of', async () => {
    const gateway = hostedGateway({ session: true });
    render(
      <App
        client={new GatewayClient(gateway.impl)}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());
    // A demo with no password configured refuses nothing, so it never learns it
    // has a gate and reads exactly as the local demo always did.
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();

    gateway.state.session = false;
    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'A line that meets an expired session.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await screen.findByLabelText('Demo password');
    await enter(PASSWORD);
    await waitFor(() => expect(screen.getByLabelText('Text to speak')).toBeInTheDocument());

    const signOut = screen.getByRole('button', { name: 'Sign out' });
    fireEvent.click(signOut);
    await screen.findByLabelText('Demo password');
    expect(gateway.state.session).toBe(false);
  });
});
