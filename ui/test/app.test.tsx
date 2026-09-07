/**
 * The app shell, wired end to end against a stubbed gateway.
 *
 * This is the one test that exercises the whole loop — health, findings,
 * console, generation, playback and history — so the seams between panels are
 * covered rather than only the panels themselves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

import { App } from '../src/App.js';
import { GatewayClient } from '../src/api/client.js';
import type { AudioBackend } from '../src/audio/player.js';

const HEALTH = {
  readiness: 'warm',
  lastUpstreamAt: Date.now(),
  scaledownWindowMs: 300_000,
  transport: 'streaming',
  ffmpeg: { available: true, remedy: null },
  asr: { available: true, configured: true, remedy: null, lastError: null },
  cache: { enabled: true, clips: 0, bytes: 0 },
  voices: 0,
  references: { staged: 0, maxAgeMs: 86_400_000 },
  limits: {
    maxTokens: 512,
    tokenCeilingByBatch: { 1: 256, 2: 512, 4: 512 },
    backboneCeilingByBatch: { 1: 256, 2: 512 },
    referenceSeconds: null,
  },
  measured: { warmupMs: 41_234, coldTtfaMs: 45_000, warmTtfaMs: 38, rtf: 0.32 },
};

/**
 * The library the shipped configuration speaks from.
 *
 * Described and staged sources are dormant, so `stubFetch` serves a kept voice
 * by default and the app resolves onto it exactly as the operator's build does.
 * Tests that used to enable the described source to reach an enabled Generate
 * button now reach it the way the shipped surface does.
 */
const SAVED_VOICE = {
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

const SECOND_VOICE = {
  ...SAVED_VOICE,
  id: 'voice-host',
  name: 'Late-night host',
  createdAt: 1,
  transcript: 'You are listening to the small hours.',
  defaultDirection: 'Close, unhurried, a little amused.',
};

/**
 * A gate the operator's build keeps shut.
 *
 * Every use of this is a dormant-capability test and says so in its name; a
 * test that needs an override to pass is not a claim about what ships.
 */
const DORMANT_STAGED_SOURCE = { staged: true } as const;

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

/** A storage stub that records every write, so persistence cadence is visible. */
function countingStorage(): Storage & { readonly writes: string[] } {
  const inner = stubStorage();
  const writes: string[] = [];
  return {
    writes,
    get length() {
      return inner.length;
    },
    clear: () => inner.clear(),
    getItem: (key: string) => inner.getItem(key),
    key: (index: number) => inner.key(index),
    removeItem: (key: string) => inner.removeItem(key),
    setItem: (key: string, value: string) => {
      writes.push(value);
      inner.setItem(key, value);
    },
  };
}

/**
 * An `Audio` that records what was constructed and what was silenced.
 *
 * Both the cached-replay path and the buffered generation path build one, so
 * this is where "only one source is audible" becomes an assertion.
 */
class TrackedAudio {
  static instances: TrackedAudio[] = [];
  /** Raise from pause(), to prove a failed stop cannot block the next play. */
  static pauseThrows = false;
  paused = false;

  constructor(readonly src: string = '') {
    TrackedAudio.instances.push(this);
  }

  play(): Promise<void> {
    return Promise.resolve();
  }

  pause(): void {
    if (TrackedAudio.pauseThrows) throw new Error('this element refuses to stop');
    this.paused = true;
  }
}

/** One cached clip, so History offers a Replay control. */
const CACHED_CLIP = {
  id: 'clip-cached',
  createdAt: Date.now(),
  bytes: 48_000,
  sampleRate: 24_000,
  durationSeconds: 1,
  ttfaMs: 38,
  transport: 'streaming',
  request: {
    text: 'Replay this cached line.',
    instruction: 'Naturally.',
    mode: 'design',
    cfgScale: 1,
    seed: 42,
  },
};

function stubAudio(): AudioBackend {
  return {
    workletUrl: 'about:blank',
    createContext: () =>
      ({
        destination: {},
        audioWorklet: { addModule: async () => { throw new Error('no worklet in jsdom'); } },
        close: async () => {},
      }) as unknown as AudioContext,
  };
}

/** A worklet node that swallows everything, so the streaming path can run. */
class FakeWorkletNode {
  readonly port = { postMessage: (): void => {}, onmessage: null };
  connect(): void {}
  disconnect(): void {}
}

/** A backend whose worklet loads, so playback takes the streaming path. */
function streamingAudio(closed: { count: number } = { count: 0 }): AudioBackend {
  return {
    workletUrl: 'about:blank',
    createContext: () =>
      ({
        destination: {},
        audioWorklet: { addModule: async () => {} },
        close: async () => {
          closed.count += 1;
        },
      }) as unknown as AudioContext,
  };
}

/**
 * A `/api/speech` response that delivers `chunks` chunks and then breaks.
 *
 * This is what a mid-generation upstream fault looks like from the browser: a
 * 200 with audio headers, and a body that stops early. Nothing in the request
 * path reads as a failure, which is why the player has to say so.
 */
function truncatedSpeech(chunks: number): typeof fetch {
  const base = stubFetch();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== '/api/speech') return base(input, init);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < chunks) {
          sent += 1;
          controller.enqueue(new Uint8Array(4800));
          return;
        }
        controller.error(new Error('terminated: other side closed'));
      },
    });
    return new Response(body, {
      headers: {
        'content-type': 'audio/pcm',
        'x-sample-rate': '24000',
        'x-sample-format': 's16le',
        'x-clip-id': 'clip-truncated',
      },
    });
  }) as typeof fetch;
}

function stubFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  const routes: Record<string, unknown> = {
    '/api/health': HEALTH,
    '/api/findings': { measured: false, cfgControl: { kind: 'presets', values: [1, 4], default: 1 } },
    '/api/clips': { clips: [] },
    '/api/voices': { voices: [SAVED_VOICE] },
    ...overrides,
  };
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
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
    const key = Object.keys(routes).find((route) => url.startsWith(route));
    if (!key) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('the app shell', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows contextual activity until synthesis and its refresh are complete', async () => {
    let resolveSpeech: ((response: Response) => void) | null = null;
    const pendingSpeech = new Promise<Response>((resolve) => {
      resolveSpeech = resolve;
    });
    const base = stubFetch();
    const delayedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/speech') return pendingSpeech;
      return base(input, init);
    }) as typeof fetch;

    render(
      <App
        client={new GatewayClient(delayedFetch)}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Application activity' }))
        .not.toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'Show activity while this is generated.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    expect(await screen.findByRole('status', { name: 'Application activity' }))
      .toHaveTextContent('Generating speech…');
    expect(document.querySelector('.app-shell')).toHaveAttribute('aria-busy', 'true');

    resolveSpeech!(new Response(new Uint8Array(48_000), {
      headers: {
        'content-type': 'audio/pcm',
        'x-sample-rate': '24000',
        'x-sample-format': 's16le',
        'x-clip-id': 'clip-activity',
      },
    }));

    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Application activity' }))
        .not.toBeInTheDocument(),
    );
    expect(document.querySelector('.app-shell')).toHaveAttribute('aria-busy', 'false');
  });

  it('keeps cached replay activity visible until audio actually starts', async () => {
    let resolvePlayback: (() => void) | null = null;
    const playbackStarted = new Promise<void>((resolve) => {
      resolvePlayback = resolve;
    });
    vi.stubGlobal('Audio', class CachedAudio {
      play(): Promise<void> { return playbackStarted; }
      pause(): void {}
    });
    const clip = {
      id: 'clip-replay',
      createdAt: Date.now(),
      bytes: 48_000,
      sampleRate: 24_000,
      durationSeconds: 1,
      ttfaMs: 38,
      transport: 'streaming',
      request: {
        text: 'Replay this cached line.',
        instruction: 'Naturally.',
        mode: 'design',
        cfgScale: 1,
        seed: 42,
      },
    };

    render(
      <App
        client={new GatewayClient(stubFetch({ '/api/clips': { clips: [clip] } }))}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Application activity' }))
        .not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Replay this cached line/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));

    expect(await screen.findByRole('status', { name: 'Application activity' }))
      .toHaveTextContent('Loading replay…');
    resolvePlayback!();
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Application activity' }))
        .not.toBeInTheDocument(),
    );
  });

  it('dormant capability — temporary reference: intake and ASR show as activity', async () => {
    let resolveReference: ((response: Response) => void) | null = null;
    const pendingReference = new Promise<Response>((resolve) => {
      resolveReference = resolve;
    });
    const base = stubFetch();
    const delayedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/reference') return pendingReference;
      return base(input, init);
    }) as typeof fetch;

    render(
      <App
        client={new GatewayClient(delayedFetch)}
        audio={stubAudio()}
        storage={stubStorage()}
        speakVoiceSourceAvailability={DORMANT_STAGED_SOURCE}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Temporary reference' }));
    fireEvent.change(screen.getByLabelText('Upload reference audio'), {
      target: {
        files: [new File(['RIFF'], 'narrator.wav', { type: 'audio/wav' })],
      },
    });

    expect(await screen.findByRole('status', { name: 'Application activity' }))
      .toHaveTextContent('Preparing reference…');

    resolveReference!(new Response(JSON.stringify({
      id: 'reference-activity',
      createdAt: Date.now(),
      bytes: 96_044,
      durationSeconds: 2,
      sampleRate: 24_000,
      format: 's16le',
      channels: 1,
      peaks: [0.2, 0.8, 0.4],
      words: [
        { word: 'Hello', start: 0, end: 0.8 },
        { word: 'there', start: 0.8, end: 1.6 },
      ],
      transcript: 'Hello there',
      language: 'en',
    }), { headers: { 'content-type': 'application/json' } }));

    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Reference trimmer' })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Application activity' }))
        .not.toBeInTheDocument(),
    );
  });

  it('shows readiness before anything is submitted', async () => {
    render(
      <App
        client={new GatewayClient(stubFetch())}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/Warm — expected 38ms to first audio/)).toBeInTheDocument(),
    );
  });

  it('keeps dormant Scripts UI and background requests out of the active app', async () => {
    const requestedUrls: string[] = [];
    const base = stubFetch();
    const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrls.push(String(input));
      return base(input, init);
    }) as typeof fetch;

    render(
      <App
        client={new GatewayClient(recordingFetch)}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Application activity' }))
        .not.toBeInTheDocument(),
    );

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.queryByRole('tab', { name: /scripts/i })).not.toBeInTheDocument();
    expect(requestedUrls.some((url) => url.startsWith('/api/scripts'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Describe' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Temporary reference' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Speak voice source' }))
      .not.toBeInTheDocument();
    expect(screen.getByLabelText('Saved voice')).toHaveValue(SAVED_VOICE.id);
    expect(screen.queryByLabelText('Seed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reroll' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'CFG scale' })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'CFG scale' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /voices/i }));
    expect(screen.getByRole('button', { name: 'Use in Speak' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use in Script' })).not.toBeInTheDocument();
  });

  it('defaults the CFG control to presets when nothing has been measured', async () => {
    render(
      <App
        client={new GatewayClient(stubFetch())}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /voices/i }));
    await waitFor(() =>
      expect(screen.getByText(/has not run against this deployment/i)).toBeInTheDocument(),
    );
  });

  it('keeps the voice creator visible without show or hide controls', async () => {
    render(
      <App
        client={new GatewayClient(stubFetch())}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /voices/i }));

    expect(screen.getByRole('region', { name: 'Create voice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create voice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close creator' })).not.toBeInTheDocument();
  });

  it('dormant capability — temporary reference: stages, trims, and sends one window', async () => {
    let speechBody: FormData | null = null;
    const base = stubFetch({
      '/api/findings': {
        measured: true,
        cfgControl: { kind: 'presets', values: [1, 4], default: 1 },
        referenceCeiling: {
          measured: true,
          maxReferenceSeconds: 2,
          ceilingByBranchMode: { noCfg: 2, singleCfg: 4 },
        },
      },
      '/api/reference': {
        id: 'reference-staged',
        createdAt: Date.now(),
        bytes: 192_044,
        durationSeconds: 4,
        sampleRate: 24_000,
        format: 's16le',
        channels: 1,
        peaks: [0.1, 0.8, 0.4, 0.6],
        words: [
          { word: 'One', start: 0, end: 1 },
          { word: 'two', start: 1, end: 2 },
          { word: 'three', start: 2, end: 3 },
        ],
        transcript: 'One two three',
        language: 'en',
      },
    });
    const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/speech') speechBody = init?.body as FormData;
      return base(input, init);
    }) as typeof fetch;

    render(
      <App
        client={new GatewayClient(recordingFetch)}
        audio={stubAudio()}
        storage={stubStorage()}
        speakVoiceSourceAvailability={DORMANT_STAGED_SOURCE}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Temporary reference' }));
    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'A newly cloned line.' },
    });
    fireEvent.change(screen.getByLabelText('Upload reference audio'), {
      target: {
        files: [new File(['RIFF'], 'narrator.wav', { type: 'audio/wav' })],
      },
    });

    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Reference trimmer' })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Reference transcript')).toHaveValue('One two'),
    );
    expect(screen.queryByText(/past the 2\.00s limit/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('slider', { name: 'Reference selection position' }), {
      target: { value: '1' },
    });
    const generate = screen.getByRole('button', { name: /generate/i });
    expect(generate).toBeEnabled();
    expect(screen.getByLabelText('Reference transcript')).toHaveValue('two three');
    fireEvent.click(generate);

    await waitFor(() => expect(speechBody).not.toBeNull());
    expect(speechBody!.get('reference_id')).toBe('reference-staged');
    expect(speechBody!.get('ref_start')).toBe('1');
    expect(speechBody!.get('ref_end')).toBe('3');
    expect(speechBody!.get('ref_text')).toBe('two three');
    expect(speechBody!.has('ref_audio')).toBe(false);
  });

  it('generates, plays through the fallback, and reports the measured first audio', async () => {
    render(
      <App
        client={new GatewayClient(stubFetch())}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'It is good to hear your voice again.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() =>
      expect(screen.getByLabelText('Measured latency')).toBeInTheDocument(),
    );
    // jsdom has no AudioWorklet, so this exercises the fallback path — which
    // is exactly what it exists for.
    expect(screen.getByText(/could not start, so this played through the buffered path/i))
      .toBeInTheDocument();
  });

  it('sends the one visible delivery instruction exactly and no legacy mode', async () => {
    let speechBody: FormData | null = null;
    const base = stubFetch();
    const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/speech') speechBody = init?.body as FormData;
      return base(input, init);
    }) as typeof fetch;

    render(
      <App
        client={new GatewayClient(recordingFetch)}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());
    expect(screen.getAllByLabelText('Instruction')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'Send this line.' },
    });
    fireEvent.change(screen.getByLabelText('Instruction'), {
      target: { value: '  Keep this delivery exactly.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() => expect(speechBody).not.toBeNull());
    expect(speechBody!.get('instruction')).toBe('  Keep this delivery exactly.  ');
    expect(speechBody!.has('mode')).toBe(false);
  });

  it('sends the shipped saved-voice request end to end, transcript included', async () => {
    // The highest-risk path in the application and, until now, the one asserted
    // nowhere through the App: a kept voice, one line, one delivery. It was
    // covered only as pure functions because the App tests reached Generate by
    // enabling the described source, which the operator's build never offers.
    let speechBody: FormData | null = null;
    const base = stubFetch({ '/api/voices': { voices: [SAVED_VOICE, SECOND_VOICE] } });
    const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/speech') speechBody = init?.body as FormData;
      return base(input, init);
    }) as typeof fetch;

    render(
      <App
        client={new GatewayClient(recordingFetch)}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());

    // Saved voices are the only source this build offers.
    expect(screen.queryByRole('group', { name: 'Speak voice source' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Saved voice')).toHaveValue(SAVED_VOICE.id),
    );

    fireEvent.change(screen.getByLabelText('Saved voice'), {
      target: { value: SECOND_VOICE.id },
    });
    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'Read this in the kept voice.' },
    });
    fireEvent.change(screen.getByLabelText('Instruction'), {
      target: { value: 'Slower, and a little warmer.' },
    });

    const generate = screen.getByRole('button', { name: /generate/i });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);

    await waitFor(() => expect(speechBody).not.toBeNull());
    expect(speechBody!.get('voice_id')).toBe(SECOND_VOICE.id);
    // The gateway needs both halves: the id names the audio, the transcript has
    // to be the exact text of it or the vendor refuses the reference.
    expect(speechBody!.get('ref_text')).toBe(SECOND_VOICE.transcript);
    expect(speechBody!.get('text')).toBe('Read this in the kept voice.');
    expect(speechBody!.get('instruction')).toBe('Slower, and a little warmer.');
    expect(speechBody!.get('cfg_scale')).toBe('1');
    expect(speechBody!.get('seed')).toBe('42');
    expect(speechBody!.has('mode')).toBe(false);
    expect(speechBody!.has('reference_id')).toBe(false);
    expect(speechBody!.has('ref_audio')).toBe(false);
    expect(speechBody!.has('language')).toBe(false);

    await waitFor(() =>
      expect(screen.getByLabelText('Measured latency')).toBeInTheDocument(),
    );
  });

  it('carries a kept voice from Voices into Speak with its default delivery', async () => {
    render(
      <App
        client={new GatewayClient(stubFetch({
          '/api/voices': { voices: [SAVED_VOICE, SECOND_VOICE] },
        }))}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: /voices/i }));
    const card = screen
      .getByRole('heading', { name: SECOND_VOICE.name, level: 4 })
      .closest('article') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Use in Speak' }));

    // Speak takes over, already holding the voice and the delivery it was kept
    // with — the operator does not retype what the library already knows.
    expect(screen.getByLabelText('Saved voice')).toHaveValue(SECOND_VOICE.id);
    expect(screen.getByLabelText('Instruction')).toHaveValue(SECOND_VOICE.defaultDirection);
    expect(screen.getByRole('tab', { name: /speak/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('says so when the stream ends early, rather than reporting a short clip as fast', async () => {
    // The failure the gateway cannot describe: upstream answered 200 and then
    // stopped. The response is a 200 carrying too few bytes, so nothing above
    // the player throws — and before this, nothing below it spoke either. The
    // clip simply played short and the readout quoted a proud first-audio
    // figure for it.
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    render(
      <App
        client={new GatewayClient(truncatedSpeech(1))}
        audio={streamingAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'It is good to hear your voice again.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Generate status' }).textContent).toMatch(
        /stream ended early/i,
      ),
    );
    expect(screen.getByRole('status', { name: 'Generate status' }).textContent).toMatch(
      /incomplete rather than fast/i,
    );
  });

  it('names the no-audio case separately, and quotes no latency for it', async () => {
    // Nothing arrived at all, so there is no first-audio figure to show and a
    // readout with an em dash in it would be noise. The status carries the
    // whole story instead.
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    render(
      <App
        client={new GatewayClient(truncatedSpeech(0))}
        audio={streamingAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'It is good to hear your voice again.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Generate status' }).textContent).toMatch(
        /closed the stream without sending audio/i,
      ),
    );
    expect(screen.queryByLabelText('Measured latency')).not.toBeInTheDocument();
  });

  it('keeps the console usable when the gateway is unreachable', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    render(
      <App client={new GatewayClient(failing)} audio={stubAudio()} storage={stubStorage()} />,
    );
    fireEvent.change(screen.getByLabelText('Text to speak'), { target: { value: 'hello' } });

    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Generate status' }).textContent).toMatch(
        /gateway is not running/i,
      ),
    );
    expect(screen.getByRole('button', { name: /generate/i })).toBeDisabled();
    // History renders read-only rather than disappearing.
    expect(screen.getByText(/history is read-only/i)).toBeInTheDocument();
  });

  it('dormant capability — temporary reference: capture is disabled with its reason without ffmpeg', async () => {
    const client = new GatewayClient(
      stubFetch({
        '/api/health': {
          ...HEALTH,
          ffmpeg: { available: false, remedy: 'brew install ffmpeg — then restart the gateway' },
        },
      }),
    );
    render(
      <App
        client={client}
        audio={stubAudio()}
        storage={stubStorage()}
        speakVoiceSourceAvailability={DORMANT_STAGED_SOURCE}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Temporary reference' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Record' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Upload audio' })).toBeEnabled();
    expect(screen.getByText(/brew install ffmpeg/)).toBeInTheDocument();
  });

  it('persists the draft across a remount', async () => {
    const storage = stubStorage();
    const { unmount } = render(
      <App client={new GatewayClient(stubFetch())} audio={stubAudio()} storage={storage} />,
    );
    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'nothing typed is lost' },
    });
    await waitFor(() => expect(storage.getItem('breeze.workspace.v2')).toContain('nothing typed'));
    unmount();

    render(
      <App client={new GatewayClient(stubFetch())} audio={stubAudio()} storage={storage} />,
    );
    expect((screen.getByLabelText('Text to speak') as HTMLTextAreaElement).value).toBe(
      'nothing typed is lost',
    );
  });

  it('silences a cached replay when the operator generates over it', async () => {
    // The overlap this closes: History renders Replay for the selected clip and
    // generating selects a clip, so Generate during a replay used to leave both
    // sources sounding and turn a comparison into a muddle.
    TrackedAudio.instances = [];
    vi.stubGlobal('Audio', TrackedAudio);

    render(
      <App
        client={new GatewayClient(stubFetch({ '/api/clips': { clips: [CACHED_CLIP] } }))}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Replay this cached line/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(TrackedAudio.instances).toHaveLength(1));
    const replayed = TrackedAudio.instances[0]!;
    expect(replayed.src).toContain('/api/clips/clip-cached');
    expect(replayed.paused).toBe(false);

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'Generate over the top of that replay.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() => expect(replayed.paused).toBe(true));
  });

  it('closes the streaming context when a cached replay takes over', async () => {
    // The other direction of the same defect: the replay element used to start
    // while the worklet graph was still connected and still making sound.
    TrackedAudio.instances = [];
    vi.stubGlobal('Audio', TrackedAudio);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    const closed = { count: 0 };

    render(
      <App
        client={new GatewayClient(stubFetch({ '/api/clips': { clips: [CACHED_CLIP] } }))}
        audio={streamingAudio(closed)}
        storage={stubStorage()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'Stream this, then replay over it.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() => expect(screen.getByLabelText('Measured latency')).toBeInTheDocument());
    expect(closed.count).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /Replay this cached line/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));

    await waitFor(() => expect(closed.count).toBe(1));
    expect(TrackedAudio.instances.at(-1)!.src).toContain('/api/clips/clip-cached');
  });

  it('starts the generated clip even when the previous source refuses to stop', async () => {
    // The operator pressed Generate and is owed audio. A stop that throws is a
    // problem with the thing being silenced, never a reason to withhold sound.
    TrackedAudio.instances = [];
    TrackedAudio.pauseThrows = true;
    vi.stubGlobal('Audio', TrackedAudio);

    try {
      render(
        <App
          client={new GatewayClient(stubFetch({ '/api/clips': { clips: [CACHED_CLIP] } }))}
          audio={stubAudio()}
          storage={stubStorage()}
        />,
      );
      await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Replay this cached line/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
      await waitFor(() => expect(TrackedAudio.instances).toHaveLength(1));

      fireEvent.change(screen.getByLabelText('Text to speak'), {
        target: { value: 'This must still be heard.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /generate/i }));

      await waitFor(() =>
        expect(screen.getByLabelText('Measured latency')).toBeInTheDocument(),
      );
      expect(TrackedAudio.instances).toHaveLength(2);
    } finally {
      TrackedAudio.pauseThrows = false;
    }
  });

  it('keeps an unfinished voice-creation draft across a remount', async () => {
    // The most expensive draft in the application: a name, a description and an
    // audition line the operator wrote before they had anything to keep.
    const storage = stubStorage();
    const { unmount } = render(
      <App client={new GatewayClient(stubFetch())} audio={stubAudio()} storage={storage} />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /voices/i }));
    fireEvent.change(screen.getByLabelText('New voice name'), {
      target: { value: 'Late-night host' },
    });
    fireEvent.change(screen.getByLabelText('Voice description'), {
      target: { value: 'Close, unhurried, a little amused.' },
    });
    fireEvent.change(screen.getByLabelText('Voice audition line'), {
      target: { value: 'You are listening to the small hours.' },
    });

    await waitFor(() =>
      expect(storage.getItem('breeze.workspace.v2')).toContain('Late-night host'),
    );
    unmount();

    render(
      <App client={new GatewayClient(stubFetch())} audio={stubAudio()} storage={storage} />,
    );
    expect((screen.getByLabelText('New voice name') as HTMLInputElement).value).toBe(
      'Late-night host',
    );
    expect((screen.getByLabelText('Voice description') as HTMLTextAreaElement).value).toBe(
      'Close, unhurried, a little amused.',
    );
    expect((screen.getByLabelText('Voice audition line') as HTMLInputElement).value).toBe(
      'You are listening to the small hours.',
    );
  });

  it('coalesces persistence rather than writing the whole workspace per keystroke', async () => {
    const storage = countingStorage();
    render(
      <App client={new GatewayClient(stubFetch())} audio={stubAudio()} storage={storage} />,
    );
    const field = screen.getByLabelText('Text to speak');
    const typed = 'A staged reference makes this payload expensive.';
    for (let length = 1; length <= typed.length; length += 1) {
      fireEvent.change(field, { target: { value: typed.slice(0, length) } });
    }

    await waitFor(() => expect(storage.getItem('breeze.workspace.v2')).toContain(typed));
    // Every keystroke changed the workspace; the write happened once.
    expect(storage.writes.length).toBeLessThan(typed.length);
    expect(storage.writes.at(-1)).toContain(typed);
  });

  it('flushes a coalesced write rather than letting the delay lose the edit', () => {
    // Coalescing is only acceptable because the pending write survives the page
    // going away. Nothing here waits for the delay before tearing the app down.
    const storage = stubStorage();
    const { unmount } = render(
      <App client={new GatewayClient(stubFetch())} audio={stubAudio()} storage={storage} />,
    );
    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'typed a moment before the tab closed' },
    });
    unmount();

    expect(storage.getItem('breeze.workspace.v2')).toContain(
      'typed a moment before the tab closed',
    );
  });

  it('reports a staged reference the gateway has forgotten without discarding the draft', async () => {
    const storage = stubStorage();
    storage.setItem('breeze.workspace.v2', JSON.stringify({
      version: 2,
      active: 'voices',
      selectedVoiceId: null,
      lastScriptId: null,
      creationDraft: {
        method: 'clone-audio',
        name: 'Late-night host',
        description: 'Close, unhurried, a little amused.',
        sampleText: 'You are listening to the small hours.',
        cfgScale: 1,
        seed: 42,
        reference: {
          referenceId: 'reference-expired',
          name: 'speaker.wav',
          durationSeconds: 2,
          sampleRate: 24_000,
          peaks: [0.2, 0.8],
          words: [
            { word: 'One', start: 0, end: 1 },
            { word: 'two', start: 1, end: 2 },
          ],
          language: 'en',
          start: 0,
          end: 2,
          transcript: 'One two',
          transcriptEdited: true,
        },
        sourceClipId: null,
        auditionClipId: null,
      },
    }));
    const base = stubFetch();
    const expiredReference = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== '/api/speech') return base(input, init);
      return new Response(JSON.stringify({
        error: {
          type: 'reference',
          message: 'That staged reference has expired.',
          remedy: 'Record or upload the audio again.',
        },
      }), { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    render(
      <App client={new GatewayClient(expiredReference)} audio={stubAudio()} storage={storage} />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Audition voice' }));

    await waitFor(() =>
      expect(screen.getByText(/That staged reference has expired/)).toBeInTheDocument(),
    );
    expect((screen.getByLabelText('New voice name') as HTMLInputElement).value).toBe(
      'Late-night host',
    );
    expect(
      (screen.getByLabelText('Cloned voice default delivery') as HTMLInputElement).value,
    ).toBe('Close, unhurried, a little amused.');
    expect((screen.getByLabelText('Voice audition line') as HTMLInputElement).value).toBe(
      'You are listening to the small hours.',
    );
    expect((screen.getByLabelText('Reference transcript') as HTMLTextAreaElement).value).toBe(
      'One two',
    );
  });

  it('never renders a toast or a confirmation dialog', async () => {
    render(
      <App client={new GatewayClient(stubFetch())} audio={stubAudio()} storage={stubStorage()} />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());
    // The project's UX rules: status in place, undo instead of "are you sure?".
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('the browser never learns the Modal endpoint', () => {
  it('issues only same-origin relative requests', async () => {
    const seen: string[] = [];
    const recording = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return stubFetch()(input as never);
    }) as typeof fetch;

    render(
      <App client={new GatewayClient(recording)} audio={stubAudio()} storage={stubStorage()} />,
    );
    await waitFor(() => expect(seen.length).toBeGreaterThan(2));

    for (const url of seen) {
      expect(url.startsWith('/api/')).toBe(true);
      expect(url).not.toMatch(/modal\.run/);
    }
  });
});

describe('the warm-up control in the masthead', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A stub whose health starts cold and reports warm once /api/wake is hit. */
  function coldThenWarmFetch(): typeof fetch & { wakes: number } {
    let readiness = 'cold';
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/wake') {
        impl.wakes += 1;
        readiness = 'warm';
        return new Response(JSON.stringify({ readiness }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('/api/health')) {
        return new Response(JSON.stringify({ ...HEALTH, readiness }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return stubFetch()(input, init);
    }) as typeof fetch & { wakes: number };
    impl.wakes = 0;
    return impl;
  }

  it('wakes the GPU on press and reflects the readiness that came back', async () => {
    const fetchImpl = coldThenWarmFetch();
    render(
      <App client={new GatewayClient(fetchImpl)} audio={stubAudio()} storage={stubStorage()} />,
    );

    const button = await screen.findByRole('button', { name: 'Warm up' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() => expect(fetchImpl.wakes).toBe(1));
    // The badge follows the wake's own answer, not a hope.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Warm up' })).toBeDisabled(),
    );
    expect(screen.getByText(/Already warm/)).toBeInTheDocument();
  });

  it('is disabled from the start when the demo is already warm', async () => {
    render(
      <App client={new GatewayClient(stubFetch())} audio={stubAudio()} storage={stubStorage()} />,
    );
    const button = await screen.findByRole('button', { name: 'Warm up' });
    await waitFor(() => expect(button).toBeDisabled());
  });

  it('a refused wake leaves the badge saying what it already said', async () => {
    // A wake is a convenience, not composed work, so a failure belongs nowhere
    // near the error surface a generation uses.
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/wake') {
        return new Response(JSON.stringify({ error: { type: 'upstream', message: 'nope' } }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('/api/health')) {
        return new Response(JSON.stringify({ ...HEALTH, readiness: 'cold' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return stubFetch()(input, init);
    }) as typeof fetch;

    render(
      <App client={new GatewayClient(fetchImpl)} audio={stubAudio()} storage={stubStorage()} />,
    );
    const button = await screen.findByRole('button', { name: 'Warm up' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Warm up' })).toBeEnabled(),
    );
    expect(screen.queryByText(/could not|failed/i)).not.toBeInTheDocument();
  });
});
