/**
 * Two facts of a shared workspace, made legible without inventing a live channel.
 *
 * The vendor holds a process-wide lock and answers every contended request with
 * the same 409, so the error itself cannot say whose generation is in the way.
 * The only place that knows is the browser that either did or did not send the
 * other request, and these tests are about the shell drawing that line — and
 * about not throwing away the press that discovered it.
 *
 * Everything time-dependent runs on an injected clock. A retry asserted by
 * sleeping would be a test that passes slowly and fails flakily.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { App, type Scheduler } from '../src/App.js';
import { GatewayClient } from '../src/api/client.js';
import {
  SpeakWorkspace,
  type SpeakWorkspaceProps,
} from '../src/components/SpeakWorkspace.js';
import type { AudioBackend } from '../src/audio/player.js';
import { SPEAK_VOICE_SOURCE_AVAILABILITY, type SpeakDraft } from '../src/state/workspace.js';
import type { Voice } from '../src/state/voices.js';

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

const SECOND_VOICE: Voice = {
  ...SAVED_VOICE,
  id: 'voice-host',
  name: 'Late-night host',
  createdAt: 1,
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

/** The gateway's own 409 envelope, verbatim from proxy.ts. */
const BUSY_BODY = {
  error: {
    type: 'busy',
    message: 'an inference is already running',
    remedy: 'Generate re-enables when it finishes.',
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function audioResponse(clipId: string): Response {
  return new Response(new Uint8Array(48_000), {
    headers: {
      'content-type': 'audio/pcm',
      'x-sample-rate': '24000',
      'x-sample-format': 's16le',
      'x-clip-id': clipId,
    },
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

/**
 * A clock the test advances by hand.
 *
 * Firing captures and clears first, so a timer that schedules the next retry
 * from inside its own callback cannot be run twice in one flush.
 */
interface FakeScheduler extends Scheduler {
  readonly delays: number[];
  readonly pending: number;
  fire(): void;
}

function fakeScheduler(): FakeScheduler {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 1;
  return {
    delays,
    get pending() {
      return timers.size;
    },
    setTimeout(handler, ms) {
      const id = next;
      next += 1;
      delays.push(ms);
      timers.set(id, handler);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fire() {
      const due = [...timers.values()];
      timers.clear();
      for (const handler of due) handler();
    },
  };
}

/**
 * A gateway that refuses `count` synthesis requests with the vendor's 409 and
 * then serves audio, so a retry can be observed succeeding.
 */
function contendedFetch(count: number, voices: readonly Voice[] = [SAVED_VOICE]): typeof fetch {
  let refusals = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/speech') {
      if (refusals < count) {
        refusals += 1;
        return json(BUSY_BODY, 409);
      }
      return audioResponse('clip-after-wait');
    }
    if (url.startsWith('/api/health')) return json(HEALTH);
    if (url.startsWith('/api/findings')) {
      return json({ measured: false, cfgControl: { kind: 'presets', values: [1, 4], default: 1 } });
    }
    if (url.startsWith('/api/clips')) return json({ clips: [] });
    if (url.startsWith('/api/voices')) return json({ voices });
    if (init?.method === 'DELETE') return json({ removed: true });
    return json({}, 404);
  }) as typeof fetch;
}

async function settled(): Promise<void> {
  await waitFor(() => expect(screen.getByText(/Warm —/)).toBeInTheDocument());
  await waitFor(() =>
    expect(screen.queryByRole('status', { name: 'Application activity' })).not.toBeInTheDocument(),
  );
}

function generateStatus(): HTMLElement {
  return screen.getByRole('status', { name: 'Generate status' });
}

describe('a 409 that may be someone else', () => {
  it('keeps the single-operator wording when this client has a request in flight', async () => {
    let releaseAudition: ((response: Response) => void) | null = null;
    const pendingAudition = new Promise<Response>((resolve) => {
      releaseAudition = resolve;
    });
    const base = contendedFetch(0);
    let speechCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/speech') {
        speechCalls += 1;
        // The first is the audition, held open. The second is Generate, and it
        // meets the lock the audition is holding — this client's own.
        if (speechCalls === 1) return pendingAudition;
        return json(BUSY_BODY, 409);
      }
      return base(input, init);
    }) as typeof fetch;

    const scheduler = fakeScheduler();
    render(
      <App
        client={new GatewayClient(fetchImpl)}
        audio={stubAudio()}
        storage={stubStorage()}
        scheduler={scheduler}
      />,
    );
    await settled();

    fireEvent.click(screen.getByRole('tab', { name: /Voices/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Audition voice' }));
    await screen.findByRole('status', { name: 'Application activity' });

    fireEvent.click(screen.getByRole('tab', { name: /Speak/ }));
    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'A line that meets my own audition.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() =>
      expect(generateStatus()).toHaveTextContent('an inference is already running'),
    );
    expect(generateStatus()).toHaveTextContent('Generate re-enables when it finishes.');
    expect(screen.queryByText(/Someone else is generating/)).not.toBeInTheDocument();
    // Nothing was held, so nothing is waiting to be sent again.
    expect(scheduler.pending).toBe(0);

    releaseAudition!(audioResponse('clip-audition'));
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Application activity' })).not.toBeInTheDocument(),
    );
  });

  it('names the other viewer and disables Generate when nothing of ours is in flight', async () => {
    const scheduler = fakeScheduler();
    render(
      <App
        client={new GatewayClient(contendedFetch(1))}
        audio={stubAudio()}
        storage={stubStorage()}
        scheduler={scheduler}
      />,
    );
    await settled();

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'A line somebody else is in front of.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() =>
      expect(generateStatus()).toHaveTextContent(/Someone else is generating/),
    );
    expect(generateStatus()).toHaveTextContent('try 1 of 3');
    expect(screen.getByRole('button', { name: /generate/i })).toBeDisabled();
    // Not an error and not a spinner.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The first delay of the bounded backoff, not an immediate re-send.
    expect(scheduler.delays).toEqual([2_000]);
  });

  it('sends the held request again on the clock, with no second press', async () => {
    const scheduler = fakeScheduler();
    render(
      <App
        client={new GatewayClient(contendedFetch(1))}
        audio={stubAudio()}
        storage={stubStorage()}
        scheduler={scheduler}
      />,
    );
    await settled();

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'This line is held, not lost.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() => expect(generateStatus()).toHaveTextContent(/Someone else is generating/));

    await act(async () => {
      scheduler.fire();
    });

    // A retry that succeeds is a generation like any other: the waiting state
    // is simply gone, and the composed line is still what it was.
    await waitFor(() =>
      expect(screen.queryByText(/Someone else is generating/)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/Nothing is lost while this waits/)).not.toBeInTheDocument();
    expect((screen.getByLabelText('Text to speak') as HTMLTextAreaElement).value).toBe(
      'This line is held, not lost.',
    );
  });

  it('says the demo stayed busy once the attempts run out, and keeps the request', async () => {
    const scheduler = fakeScheduler();
    render(
      <App
        client={new GatewayClient(contendedFetch(99))}
        audio={stubAudio()}
        storage={stubStorage()}
        scheduler={scheduler}
      />,
    );
    await settled();

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'A line the demo never got round to.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() => expect(generateStatus()).toHaveTextContent(/Someone else is generating/));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        scheduler.fire();
      });
    }

    await waitFor(() =>
      expect(screen.getByText(/The demo stayed busy through 3 attempts/)).toBeInTheDocument(),
    );
    // Finite, and exactly the declared backoff.
    expect(scheduler.delays).toEqual([2_000, 5_000, 10_000]);
    expect(scheduler.pending).toBe(0);
    // The composed request is intact and pressable again: a second press costs
    // nothing but the press.
    expect((screen.getByLabelText('Text to speak') as HTMLTextAreaElement).value).toBe(
      'A line the demo never got round to.',
    );
    expect(screen.getByRole('button', { name: /generate/i })).toBeEnabled();
  });

  it('drops the held request when the viewer stops waiting', async () => {
    const scheduler = fakeScheduler();
    render(
      <App
        client={new GatewayClient(contendedFetch(99))}
        audio={stubAudio()}
        storage={stubStorage()}
        scheduler={scheduler}
      />,
    );
    await settled();

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'A line the viewer stopped waiting for.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() => expect(generateStatus()).toHaveTextContent(/Someone else is generating/));

    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));

    expect(scheduler.pending).toBe(0);
    await waitFor(() =>
      expect(screen.queryByText(/Someone else is generating/)).not.toBeInTheDocument(),
    );
    await act(async () => {
      scheduler.fire();
    });
    expect(screen.queryByText(/Someone else is generating/)).not.toBeInTheDocument();
    // Cancelling is not discarding: the line is still composed.
    expect((screen.getByLabelText('Text to speak') as HTMLTextAreaElement).value).toBe(
      'A line the viewer stopped waiting for.',
    );
  });

  it('does not let an attempt already on the wire reinstate a dismissed wait', async () => {
    let release: ((response: Response) => void) | null = null;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let speechCalls = 0;
    const base = contendedFetch(0);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/speech') {
        speechCalls += 1;
        if (speechCalls === 1) return json(BUSY_BODY, 409);
        return held;
      }
      return base(input, init);
    }) as typeof fetch;

    const scheduler = fakeScheduler();
    render(
      <App
        client={new GatewayClient(fetchImpl)}
        audio={stubAudio()}
        storage={stubStorage()}
        scheduler={scheduler}
      />,
    );
    await settled();

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'A line dismissed mid-retry.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() => expect(generateStatus()).toHaveTextContent(/Someone else is generating/));

    // The retry is now open at the gateway.
    await act(async () => {
      scheduler.fire();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));

    await act(async () => {
      release!(json(BUSY_BODY, 409));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.queryByText(/Someone else is generating/)).not.toBeInTheDocument(),
    );
    expect(scheduler.pending).toBe(0);
  });

  it('introduces no polling and no push', async () => {
    const eventSource = vi.fn();
    vi.stubGlobal('EventSource', eventSource);
    const scheduler = fakeScheduler();
    render(
      <App
        client={new GatewayClient(contendedFetch(99))}
        audio={stubAudio()}
        storage={stubStorage()}
        scheduler={scheduler}
      />,
    );
    await settled();

    fireEvent.change(screen.getByLabelText('Text to speak'), {
      target: { value: 'Nothing here subscribes to anything.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() => expect(generateStatus()).toHaveTextContent(/Someone else is generating/));

    expect(eventSource).not.toHaveBeenCalled();
    // One timer for one held request, never a repeating one.
    expect(scheduler.pending).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('the waiting strip', () => {
  const DRAFT: SpeakDraft = {
    text: 'Read this in the kept voice.',
    instruction: 'Warm and clear.',
    language: 'en',
    seed: 42,
    seedLocked: true,
    cfgScale: 1,
    voice: { kind: 'saved', voiceId: SAVED_VOICE.id, voiceName: SAVED_VOICE.name },
  };

  function props(overrides: Partial<SpeakWorkspaceProps> = {}): SpeakWorkspaceProps {
    return {
      draft: DRAFT,
      onDraftChange: vi.fn(),
      voices: [SAVED_VOICE],
      blockedReason: null,
      statusLine: 'Warm — 38 ms first audio.',
      onGenerate: vi.fn(),
      generating: false,
      clips: [],
      selectedClipId: null,
      onSelectClip: vi.fn(),
      onReplay: vi.fn(),
      onLoadVariation: vi.fn(),
      onCreateVoiceFromClip: vi.fn(),
      onSaveVoice: vi.fn(),
      clipUrl: (id) => `/api/clips/${id}`,
      historyReadOnlyReason: null,
      playbackReadout: null,
      sourceAvailability: SPEAK_VOICE_SOURCE_AVAILABILITY,
      onStage: vi.fn(),
      canRecord: true,
      recordDisabledReason: null,
      referenceMaxSeconds: 14,
      referenceMaxMeasured: true,
      referenceBranchLimits: null,
      referenceTokenCeiling: 256,
      referenceAudioUrl: () => '/api/reference/x/audio',
      asrRemedy: null,
      ...overrides,
    };
  }

  it('is absent when nothing is being waited on', () => {
    render(<SpeakWorkspace {...props()} />);
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).not.toBeInTheDocument();
  });

  it('offers only a way out while the wait is live', () => {
    const onCancelSharedWait = vi.fn();
    render(
      <SpeakWorkspace
        {...props({
          sharedWait: { attempt: 2, attempts: 3, exhausted: false },
          onCancelSharedWait,
          blockedReason: 'Someone else is generating. Your request is held — try 2 of 3.',
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(onCancelSharedWait).toHaveBeenCalledTimes(1);
    // The sentence lives on the Console's own status line, beside the control
    // it disables, and is not repeated here.
    expect(screen.getAllByText(/Someone else is generating/)).toHaveLength(1);
  });

  it('drops the way out once there is nothing left to wait for', () => {
    render(
      <SpeakWorkspace
        {...props({ sharedWait: { attempt: 3, attempts: 3, exhausted: true } })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).not.toBeInTheDocument();
    expect(screen.getByText(/The demo stayed busy through 3 attempts/)).toBeInTheDocument();
  });
});

describe('a library other people can change', () => {
  it('states that voices are shared before anything can be created', async () => {
    render(
      <App
        client={new GatewayClient(contendedFetch(0))}
        audio={stubAudio()}
        storage={stubStorage()}
        scheduler={fakeScheduler()}
      />,
    );
    await settled();
    fireEvent.click(screen.getByRole('tab', { name: /Voices/ }));

    const statement = screen.getByText(/This library is shared/);
    expect(statement).toHaveTextContent(/audible to all of them/);
    // Above the surface that creates, not below the one that loses.
    const creation = screen.getByRole('region', { name: 'Create voice' });
    expect(statement.compareDocumentPosition(creation)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('offers undo for this client’s own delete, and takes it back when the window closes', async () => {
    const scheduler = fakeScheduler();
    render(
      <App
        client={new GatewayClient(contendedFetch(0, [SAVED_VOICE, SECOND_VOICE]))}
        audio={stubAudio()}
        storage={stubStorage()}
        scheduler={scheduler}
      />,
    );
    await settled();
    fireEvent.click(screen.getByRole('tab', { name: /Voices/ }));

    const card = screen.getByText(SECOND_VOICE.name).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Delete' }));

    const strip = await screen.findByText(/Deleted “Late-night host”/);
    expect(within(strip.parentElement!).getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    await act(async () => {
      scheduler.fire();
    });
    // The 30-second window in voices-index.ts has closed; a button that can no
    // longer work is not left on screen.
    await waitFor(() =>
      expect(screen.queryByText(/Deleted “Late-night host”/)).not.toBeInTheDocument(),
    );
  });

  it('offers no undo for a voice that simply is not there any more', async () => {
    let listed: readonly Voice[] = [SAVED_VOICE, SECOND_VOICE];
    const storage = stubStorage();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/voices')) return json({ voices: listed });
      return contendedFetch(0)(input, init);
    }) as typeof fetch;
    const mount = (): void => {
      render(
        <App
          client={new GatewayClient(fetchImpl)}
          audio={stubAudio()}
          storage={storage}
          scheduler={fakeScheduler()}
        />,
      );
    };

    mount();
    await settled();
    fireEvent.click(screen.getByRole('tab', { name: /Voices/ }));
    expect(screen.getByText(SECOND_VOICE.name)).toBeInTheDocument();
    cleanup();

    // Somebody else deleted it. All this client ever learns is a shorter list —
    // the PendingUndo that could spend the gateway's 30 seconds lives in the
    // deleter's browser, not this one.
    listed = [SAVED_VOICE];
    mount();
    await settled();
    fireEvent.click(screen.getByRole('tab', { name: /Voices/ }));

    await waitFor(() =>
      expect(screen.queryByText(SECOND_VOICE.name)).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Deleted “/)).not.toBeInTheDocument();
  });

  it('presents a delete another viewer already made as already gone', async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/voices/') && init?.method === 'DELETE') {
        return json(
          { error: { type: 'not-found', message: 'no such voice' } },
          404,
        );
      }
      return contendedFetch(0, [SAVED_VOICE, SECOND_VOICE])(input, init);
    }) as typeof fetch;

    render(
      <App
        client={new GatewayClient(fetchImpl)}
        audio={stubAudio()}
        storage={stubStorage()}
        scheduler={fakeScheduler()}
      />,
    );
    await settled();
    fireEvent.click(screen.getByRole('tab', { name: /Voices/ }));

    const card = screen.getByText(SECOND_VOICE.name).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(screen.getByText(/was already removed by someone else/)).toBeInTheDocument(),
    );
    // The viewer's intent was satisfied, so this is not a failure and there is
    // nothing to undo.
    expect(screen.queryByText(/could not be deleted/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByText(SECOND_VOICE.name)).not.toBeInTheDocument();
  });
});
