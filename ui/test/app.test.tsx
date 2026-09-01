/**
 * The app shell, wired end to end against a stubbed gateway.
 *
 * This is the one test that exercises the whole loop — health, findings,
 * console, generation, playback and history — so the seams between panels are
 * covered rather than only the panels themselves.
 */

import { describe, expect, it } from 'vitest';
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
  cache: { enabled: true, clips: 0, bytes: 0 },
  voices: 0,
  limits: { maxTokens: 512 },
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
