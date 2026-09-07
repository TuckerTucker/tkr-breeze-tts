/**
 * The Scripts surface: generation preview, and the two run/export defects the
 * gate would otherwise release.
 *
 * Scripts is dormant in the shipped build. The App-level tests here pass
 * `workspaceAvailability` so the gate can be opened later as a configuration
 * change rather than as the first time this code has ever been run end to end.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { App } from '../src/App.js';
import { GatewayClient } from '../src/api/client.js';
import type { AudioBackend } from '../src/audio/player.js';
import { ScriptsWorkspace, type ScriptsWorkspaceProps } from '../src/components/ScriptsWorkspace.js';
import {
  INITIAL_SCRIPT_DEFAULTS,
  type Cue,
  type Script,
  type ScriptSummary,
} from '../src/state/script.js';

function cue(index: number, state: Cue['state'] = 'done'): Cue {
  return {
    id: `cue-${index + 1}`,
    index,
    text: `Generated line ${index + 1}.`,
    voiceId: null,
    voiceName: null,
    instruction: INITIAL_SCRIPT_DEFAULTS.instruction,
    cfgScale: 1,
    seed: 42,
    targetStart: null,
    targetEnd: null,
    state,
    clipId: `clip-${index + 1}`,
    actualSeconds: state === 'done' ? 1.5 : null,
    driftSeconds: null,
    problem: null,
  };
}

function script(cues: Cue[]): Script {
  return {
    id: 'script-1',
    name: 'Preview scene',
    source: 'text',
    defaults: INITIAL_SCRIPT_DEFAULTS,
    cues,
    problems: [],
  };
}

function summary(current: Script): ScriptSummary {
  return {
    id: current.id,
    name: current.name,
    source: current.source,
    createdAt: 1,
    updatedAt: 1,
    cueCount: current.cues.length,
    doneCount: current.cues.filter((item) => item.state === 'done').length,
    failedCount: current.cues.filter((item) => item.state === 'failed').length,
    defaults: INITIAL_SCRIPT_DEFAULTS,
  };
}

function props(current: Script): ScriptsWorkspaceProps {
  return {
    summaries: [summary(current)],
    script: current,
    voices: [],
    running: false,
    loading: false,
    problem: null,
    onOpen: vi.fn(),
    onImport: vi.fn(),
    onCreate: vi.fn(),
    onUpdateDefaults: vi.fn(),
    onEditCue: vi.fn(),
    onRun: vi.fn(),
    onExport: vi.fn(),
    clipUrl: (id) => `/api/clips/${id}`,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('script generation preview', () => {
  it('explains automatic chunking beside the imported document', () => {
    const current: Script = {
      ...script([cue(0, 'queued'), cue(1, 'queued'), cue(2, 'queued')]),
      chunking: {
        version: 2,
        sourceCueCount: 1,
        splitSourceCueCount: 1,
        outputCueCount: 3,
        addedCueCount: 2,
        tokenCeiling: 256,
      },
    };
    render(<ScriptsWorkspace {...props(current)} />);

    expect(screen.getByRole('status', { name: 'Script import details' })).toHaveTextContent(
      '1 long line was split. Prepared 3 generation cues from 1 source line',
    );
    expect(screen.getByRole('status', { name: 'Script import details' })).toHaveTextContent(
      '256-token request ceiling',
    );
  });

  it('loads the first ready cue into one shared cache-backed player', () => {
    const current = script([cue(0), cue(1), cue(2, 'stale')]);
    render(<ScriptsWorkspace {...props(current)} />);

    const player = screen.getByLabelText('Preview generated audio for cue 1');
    expect(player).toHaveAttribute('src', '/api/clips/clip-1');
    expect(screen.getAllByLabelText(/Preview generated audio for cue/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Preview cue 3' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview cue 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('switches and starts playback from a ready cue without running synthesis', async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined);
    const load = vi
      .spyOn(HTMLMediaElement.prototype, 'load')
      .mockImplementation(() => {});
    const current = script([cue(0), cue(1)]);
    const handlers = props(current);
    render(<ScriptsWorkspace {...handlers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview cue 2' }));

    const player = await screen.findByLabelText('Preview generated audio for cue 2');
    expect(player).toHaveAttribute('src', '/api/clips/clip-2');
    expect(load).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
    expect(handlers.onRun).not.toHaveBeenCalled();

    fireEvent.playing(player);
    expect(screen.getByRole('button', { name: 'Pause cue 2' })).toHaveTextContent(
      'Pause preview',
    );
    expect(
      within(screen.getByRole('region', { name: 'Generated cue preview' })).getByRole(
        'status',
      ),
    ).toHaveTextContent('Playing cue 2');
  });

  it('keeps playback failures beside the player with a recovery path', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      new Error('Audio output is unavailable.'),
    );
    const current = script([cue(0)]);
    render(<ScriptsWorkspace {...props(current)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview cue 1' }));

    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Generated cue preview' })).getByRole(
          'status',
        ),
      ).toHaveTextContent(/Audio output is unavailable.*remains available in the player/),
    );
  });

  it('explains when no cue has generated audio yet', () => {
    const current = script([cue(0, 'stale'), cue(1, 'queued')]);
    render(<ScriptsWorkspace {...props(current)} />);

    expect(screen.getByText('No generated audio yet.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Generated cue preview' })).getByRole(
        'status',
      ),
    ).toHaveTextContent('Run a cue to make its preview available.');
    expect(screen.queryByLabelText(/Preview generated audio/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview cue 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview cue 2' })).toBeDisabled();
  });
});

// ── The dormant Scripts surface, driven through the shell ─────────────────────

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

const SAVED_VOICE = {
  id: 'voice-kept',
  name: 'Visible narrator',
  createdAt: 2,
  transcript: 'This voice remains ready.',
  defaultDirection: 'Warm and clear.',
  origin: { kind: 'designed', instruction: 'Warm and clear.' },
  durationSeconds: 4,
  sampleRate: 24_000,
  available: true,
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
        audioWorklet: {
          addModule: async () => {
            throw new Error('no worklet in jsdom');
          },
        },
        close: async () => {},
      }) as unknown as AudioContext,
  };
}

/** Everything the shell needs to reach Scripts, plus the run stream's controls. */
interface ScriptHarness {
  /** How many times the whole document was fetched. The N+1 counter. */
  readonly documentFetches: () => number;
  /** Push one SSE `progress` frame into the open run. */
  readonly emit: (progress: Record<string, unknown>) => void;
  /** End the run stream with its `done` summary. */
  readonly finish: () => void;
  /** Replace what the next whole-document fetch returns. */
  readonly setDocument: (next: Script) => void;
}

function scriptHarness(initial: Script): {
  fetchImpl: typeof fetch;
  harness: ScriptHarness;
} {
  let document = initial;
  let documentFetches = 0;
  let runController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/health') return json(HEALTH);
    if (url === '/api/findings') return json({ measured: false });
    if (url === '/api/clips') return json({ clips: [] });
    if (url === '/api/voices') return json({ voices: [SAVED_VOICE] });
    if (url === '/api/scripts') return json({ scripts: [summary(document)] });
    if (url.endsWith('/run')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            runController = controller;
          },
        }),
      );
    }
    if (url.endsWith('/export.vtt')) {
      return new Response('WEBVTT\n', { headers: { 'content-type': 'text/vtt' } });
    }
    if (url.includes('/cues/')) {
      const cueId = url.split('/cues/')[1] ?? '';
      const patch = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
      document = {
        ...document,
        cues: document.cues.map((item) =>
          item.id === cueId
            ? { ...item, text: patch.text ?? item.text, state: 'stale', actualSeconds: null }
            : item,
        ),
      };
      return json(document);
    }
    if (url === `/api/scripts/${document.id}`) {
      documentFetches += 1;
      return json(document);
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  return {
    fetchImpl,
    harness: {
      documentFetches: () => documentFetches,
      emit: (progress) =>
        runController?.enqueue(
          encoder.encode(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`),
        ),
      finish: () => {
        runController?.enqueue(
          encoder.encode(`event: done\ndata: ${JSON.stringify({ total: 2 })}\n\n`),
        );
        runController?.close();
      },
      setDocument: (next) => {
        document = next;
      },
    },
  };
}

/** Open the dormant Scripts tool the way an operator with the gate open would. */
async function openScripts(fetchImpl: typeof fetch): Promise<void> {
  render(
    <App
      client={new GatewayClient(fetchImpl)}
      audio={stubAudio()}
      storage={stubStorage()}
      workspaceAvailability={{ scripts: true }}
    />,
  );
  fireEvent.click(await screen.findByRole('tab', { name: /Voices/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use in Script' }));
  fireEvent.click(await screen.findByRole('button', { name: /Preview scene/ }));
  await screen.findByRole('button', { name: 'Run stale cues' });
}

function cueStates(): string[] {
  return within(screen.getByRole('list', { name: 'Script cues' }))
    .getAllByRole('listitem')
    .map((row) => within(row).getByText(/QUEUED|GENERATING|DONE|STALE|FAILED|NEEDS/).textContent ?? '');
}

describe('the dormant Scripts surface, before its gate opens', () => {
  it('exports through an anchor in the document whose object URL is still live', async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const deferred: (() => void)[] = [];
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => {
      created.push('blob:export');
      return 'blob:export';
    };
    URL.revokeObjectURL = (url: string) => void revoked.push(url);

    const realSetTimeout = window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      // Long-lived timers are held rather than run, so "not revoked yet" and
      // "revoked eventually" are two separate, deterministic assertions.
      if (typeof handler === 'function' && (timeout ?? 0) >= 1_000) {
        deferred.push(handler as () => void);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, timeout);
    }) as typeof window.setTimeout);

    let connectedAtClick: boolean | null = null;
    let revokedAtClick = -1;
    let downloadName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      connectedAtClick = this.isConnected;
      revokedAtClick = revoked.length;
      downloadName = this.download;
    });

    try {
      const { fetchImpl } = scriptHarness(script([cue(0), cue(1, 'queued')]));
      await openScripts(fetchImpl);

      fireEvent.click(screen.getByRole('button', { name: 'Export VTT' }));

      await waitFor(() => expect(created).toHaveLength(1));
      // Firefox dispatches a click only on a connected anchor, and reads the
      // object URL after the handler returns. Both were false before.
      expect(connectedAtClick).toBe(true);
      expect(revokedAtClick).toBe(0);
      expect(downloadName).toBe('Preview scene.vtt');
      // And the anchor does not stay behind in the document.
      expect(document.querySelectorAll('a[download]')).toHaveLength(0);

      expect(revoked).toEqual([]);
      deferred.forEach((run) => run());
      expect(revoked).toEqual(['blob:export']);
    } finally {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
  });

  it('renders run progress from the stream instead of refetching per cue', async () => {
    const { fetchImpl, harness } = scriptHarness(script([cue(0, 'queued'), cue(1, 'queued')]));
    await openScripts(fetchImpl);
    expect(harness.documentFetches()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Run stale cues' }));
    await screen.findByRole('button', { name: 'Running stale cues…' });

    harness.emit({ scriptId: 'script-1', cueId: 'cue-1', index: 0, total: 2, state: 'generating', fromCache: false, problem: null });
    await waitFor(() => expect(cueStates()[0]).toBe('GENERATING'));

    harness.emit({ scriptId: 'script-1', cueId: 'cue-1', index: 0, total: 2, state: 'done', fromCache: false, problem: null });
    harness.emit({ scriptId: 'script-1', cueId: 'cue-2', index: 1, total: 2, state: 'failed', fromCache: false, problem: 'the voice went away' });
    await waitFor(() => expect(cueStates()).toEqual(['DONE', 'FAILED']));
    expect(screen.getByLabelText('Cue 2 problem')).toHaveTextContent('the voice went away');

    // Four transitions rendered, and not one extra document fetch: the previous
    // implementation issued one per transition, unordered.
    expect(harness.documentFetches()).toBe(1);

    harness.setDocument(script([cue(0), cue(1, 'failed')]));
    harness.finish();
    await waitFor(() => expect(harness.documentFetches()).toBe(2));
    await screen.findByRole('button', { name: 'Run stale cues' });
  });

  it('lets a cue edited during a run outrank the state the run reports for it', async () => {
    const { fetchImpl, harness } = scriptHarness(script([cue(0, 'queued'), cue(1, 'queued')]));
    await openScripts(fetchImpl);

    fireEvent.click(screen.getByRole('button', { name: 'Run stale cues' }));
    await screen.findByRole('button', { name: 'Running stale cues…' });

    fireEvent.change(screen.getByLabelText('Cue 2 text'), {
      target: { value: 'A corrected second line.' },
    });
    await waitFor(() => expect(cueStates()[1]).toBe('STALE / EDITED'));

    // The queue was generating the text the operator has since replaced. Its
    // frame is about a line that no longer exists.
    harness.emit({ scriptId: 'script-1', cueId: 'cue-2', index: 1, total: 2, state: 'done', fromCache: false, problem: null });
    harness.emit({ scriptId: 'script-1', cueId: 'cue-1', index: 0, total: 2, state: 'done', fromCache: false, problem: null });

    await waitFor(() => expect(cueStates()[0]).toBe('DONE'));
    expect(cueStates()[1]).toBe('STALE / EDITED');

    harness.finish();
    await screen.findByRole('button', { name: 'Run stale cues' });
  });

  it('ignores a run frame naming a document that is no longer open', async () => {
    const { fetchImpl, harness } = scriptHarness(script([cue(0, 'queued'), cue(1, 'queued')]));
    await openScripts(fetchImpl);

    fireEvent.click(screen.getByRole('button', { name: 'Run stale cues' }));
    await screen.findByRole('button', { name: 'Running stale cues…' });

    harness.emit({ scriptId: 'script-elsewhere', cueId: 'cue-1', index: 0, total: 2, state: 'done', fromCache: false, problem: null });
    harness.emit({ scriptId: 'script-1', cueId: 'cue-2', index: 1, total: 2, state: 'generating', fromCache: false, problem: null });

    await waitFor(() => expect(cueStates()[1]).toBe('GENERATING'));
    expect(cueStates()[0]).toBe('QUEUED');

    harness.finish();
    await screen.findByRole('button', { name: 'Run stale cues' });
  });
});
