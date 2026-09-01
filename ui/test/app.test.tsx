/**
 * The app shell, wired end to end against a stubbed gateway.
 *
 * This is the one test that exercises the whole loop — health, findings,
 * console, generation, playback and history — so the seams between panels are
 * covered rather than only the panels themselves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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
    referenceSeconds: null,
  },
  measured: { warmupMs: 41_234, coldTtfaMs: 45_000, warmTtfaMs: 38, rtf: 0.32 },
};

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
function streamingAudio(): AudioBackend {
  return {
    workletUrl: 'about:blank',
    createContext: () =>
      ({
        destination: {},
        audioWorklet: { addModule: async () => {} },
        close: async () => {},
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
    '/api/voices': { voices: [] },
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
    expect(document.querySelector('.app')).toHaveAttribute('aria-busy', 'true');

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
    expect(document.querySelector('.app')).toHaveAttribute('aria-busy', 'false');
  });

  it('shows reference preparation as activity while intake and ASR are pending', async () => {
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
      />,
    );
    await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    fireEvent.change(screen.getByLabelText('Upload a reference file'), {
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

  it('defaults the CFG control to presets when nothing has been measured', async () => {
    render(
      <App
        client={new GatewayClient(stubFetch())}
        audio={stubAudio()}
        storage={stubStorage()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    await waitFor(() =>
      expect(screen.getByText(/has not run against this deployment/i)).toBeInTheDocument(),
    );
  });

  it('stages, trims, and sends a reference window without re-uploading audio', async () => {
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
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'A newly cloned line.' },
    });
    fireEvent.change(screen.getByLabelText('Upload a reference file'), {
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

  it('disables microphone capture with the reason when ffmpeg is absent', async () => {
    const client = new GatewayClient(
      stubFetch({
        '/api/health': {
          ...HEALTH,
          ffmpeg: { available: false, remedy: 'brew install ffmpeg — then restart the gateway' },
        },
      }),
    );
    render(<App client={client} audio={stubAudio()} storage={stubStorage()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Record' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Upload a file' })).toBeEnabled();
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
    await waitFor(() => expect(storage.getItem('breeze.draft.v1')).toContain('nothing typed'));
    unmount();

    render(
      <App client={new GatewayClient(stubFetch())} audio={stubAudio()} storage={storage} />,
    );
    expect((screen.getByLabelText('Text to speak') as HTMLTextAreaElement).value).toBe(
      'nothing typed is lost',
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
