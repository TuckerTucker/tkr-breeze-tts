/**
 * The application shell.
 *
 * It owns the state the panels share and nothing else; every panel below is a
 * function of props, which is what lets each one be tested on its own.
 *
 * @module
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { Console } from './components/Console.js';
import { History } from './components/History.js';
import { ScriptEditor } from './components/ScriptEditor.js';
import { VoiceLibrary } from './components/VoiceLibrary.js';
import { VoiceModes } from './components/VoiceModes.js';
import { FirstAudioReadout, ReadinessBadge, WakeState } from './components/WakeState.js';
import { ApiError, GatewayClient } from './api/client.js';
import { StreamingPlayer, playCachedClip, type AudioBackend, type PlaybackResult } from './audio/player.js';
import {
  generateBlockedReason,
  loadDraft,
  rollSeed,
  saveDraft,
  type Draft,
} from './state/draft.js';
import {
  INITIAL_MODE,
  cfgControlFrom,
  instructionFor,
  modeBlocker,
  switchMode,
  type CfgControl,
  type ModeState,
  type VoiceMode,
} from './state/mode.js';
import { promoteToReference, restoreFromClip, type Clip } from './state/history.js';
import { readinessSummary, shouldShowWake, type Health } from './state/readiness.js';
import { applyDelete, applyUndo, type PendingUndo, type Voice } from './state/voices.js';
import { suggestName } from './state/name.js';
import type { Script } from './state/script.js';

/** What the app needs injected, so it can be mounted in a test. */
export interface AppProps {
  readonly client: GatewayClient;
  readonly audio: AudioBackend;
  readonly storage: Storage;
}

/**
 * Render the application.
 *
 * @param props - Injected client, audio backend and storage.
 * @returns The application element.
 */
export function App(props: AppProps): JSX.Element {
  const { client } = props;

  const [draft, setDraft] = useState<Draft>(() => loadDraft(props.storage));
  const [mode, setMode] = useState<ModeState>(INITIAL_MODE);
  const [health, setHealth] = useState<Health | null>(null);
  const [cfgControl, setCfgControl] = useState<CfgControl>(cfgControlFrom(null));
  const [cfgUnmeasured, setCfgUnmeasured] = useState(true);
  const [clips, setClips] = useState<Clip[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);
  const [script, setScript] = useState<Script | null>(null);
  const [running, setRunning] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wakeElapsedMs, setWakeElapsedMs] = useState(0);
  const [playback, setPlayback] = useState<PlaybackResult | null>(null);
  const [failure, setFailure] = useState<{ message: string; remedy?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const player = useRef<StreamingPlayer | null>(null);
  const replay = useRef<HTMLAudioElement | null>(null);

  useEffect(() => saveDraft(props.storage, draft), [draft, props.storage]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextHealth, nextClips, nextVoices] = await Promise.all([
        client.health(),
        client.clips(),
        client.voices(),
      ]);
      setHealth(nextHealth);
      setClips(nextClips);
      setVoices(nextVoices);
    } catch {
      setHealth(null);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    void (async () => {
      try {
        const finding = await client.findings();
        setCfgControl(cfgControlFrom(finding));
        setCfgUnmeasured(!(finding as { measured?: boolean }).measured);
      } catch {
        // The conservative default is already in place.
      }
    })();
  }, [client, refresh]);

  // The wake clock. Nothing here polls the gateway, and nothing polls upstream:
  // `/health` on a scaled-to-zero container would start the cold start it was
  // checking for.
  useEffect(() => {
    if (!waking) return undefined;
    const startedAt = Date.now();
    const timer = setInterval(() => setWakeElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(timer);
  }, [waking]);

  const blocker = modeBlocker(mode);
  const blockedReason = generateBlockedReason({
    draft,
    gatewayReachable: health !== null,
    busy,
    generating,
    modeBlocker: blocker,
    cfgScale: mode.cfgScale,
  });

  const statusLine = failure
    ? `${failure.message}${failure.remedy ? ` — ${failure.remedy}` : ''}`
    : readinessSummary(health?.readiness ?? 'unknown', health?.measured ?? null);

  const generate = async (): Promise<void> => {
    setFailure(null);
    setPlayback(null);
    setGenerating(true);

    const cold = shouldShowWake(health?.readiness ?? 'unknown');
    setWaking(cold);
    setWakeElapsedMs(0);

    const seed = draft.seedLocked ? draft.seed : rollSeed();
    if (!draft.seedLocked) setDraft({ ...draft, seed });

    const startedAt = performance.now();
    try {
      const response = await client.speech({
        text: draft.text,
        instruction: instructionFor(mode, draft.instruction),
        cfgScale: mode.cfgScale,
        seed,
        mode: mode.mode,
        ...(mode.reference?.file ? { refAudio: mode.reference.file } : {}),
        ...(mode.reference?.voiceId ? { voiceId: mode.reference.voiceId } : {}),
        ...(mode.refText ? { refText: mode.refText } : {}),
      });

      await player.current?.stop();
      const active = new StreamingPlayer(props.audio);
      player.current = active;

      const result = await active.play(response, startedAt, {
        onFirstAudio: () => setWaking(false),
      });
      setPlayback(result);
      setSelectedClipId(result.clipId);
    } catch (error) {
      const failureBody = error instanceof ApiError ? error.failure : null;
      if (failureBody?.type === 'busy') setBusy(true);
      setFailure({
        message: failureBody?.message ?? (error as Error).message,
        ...(failureBody?.remedy ? { remedy: failureBody.remedy } : {}),
      });
    } finally {
      setGenerating(false);
      setWaking(false);
      setBusy(false);
      void refresh();
    }
  };

  const onModeChange = (next: VoiceMode): void => setMode(switchMode(mode, next));

  const loadIntoConsole = (clip: Clip): void => {
    const restore = restoreFromClip(clip);
    setDraft({ ...draft, text: restore.text, instruction: restore.instruction, seed: restore.seed });
    setMode({
      ...mode,
      mode: restore.mode,
      cfgScale: restore.cfgScale,
      refText: restore.refText ?? '',
    });
  };

  const promote = async (clip: Clip): Promise<void> => {
    // Switch to Clone rather than silently attaching a reference the current
    // mode cannot send, and fill ref_text from the text that produced it.
    const promotion = promoteToReference(clip);
    const response = await fetch(client.clipUrl(clip.id));
    const blob = await response.blob();
    setMode({
      ...mode,
      mode: promotion.mode,
      reference: {
        source: 'upload',
        file: new File([blob], `${clip.id}.wav`, { type: 'audio/wav' }),
        name: promotion.referenceName,
        durationSeconds: clip.durationSeconds,
      },
      refText: promotion.refText,
    });
  };

  const saveAsVoice = async (clip: Clip): Promise<void> => {
    await client.saveVoice({ clipId: clip.id, name: suggestName(clip.request.instruction) });
    void refresh();
  };

  const deleteVoice = async (voice: Voice): Promise<void> => {
    const applied = applyDelete(voices, voice.id, Date.now());
    setVoices(applied.voices);
    setPendingUndo(applied.undo);
    await client.deleteVoice(voice.id);
  };

  const undoDelete = async (undo: PendingUndo): Promise<void> => {
    setVoices(applyUndo(voices, undo.voice));
    setPendingUndo(null);
    await client.restoreVoice(undo.voice.id);
  };

  const exportUrls = useMemo(
    () => (script ? client.scriptExportUrls(script.id) : null),
    [client, script],
  );

  return (
    <div className="app">
      <header className="masthead">
        <h1>Breeze TTS 2</h1>
        <ReadinessBadge
          readiness={health?.readiness ?? 'unknown'}
          measured={health?.measured ?? null}
        />
      </header>

      <main>
        {waking && <WakeState elapsedMs={wakeElapsedMs} measured={health?.measured ?? null} />}

        <VoiceModes
          state={mode}
          onChange={setMode}
          onModeChange={onModeChange}
          cfgControl={cfgControl}
          cfgUnmeasured={cfgUnmeasured}
          voices={voices}
          canRecord={health?.ffmpeg.available ?? false}
          recordDisabledReason={
            health?.ffmpeg.available === false
              ? `Reference intake unavailable: ffmpeg is not installed. ${health.ffmpeg.remedy ?? ''}`
              : null
          }
        />

        <Console
          draft={draft}
          onDraftChange={setDraft}
          blockedReason={blockedReason}
          statusLine={statusLine}
          cfgScale={mode.cfgScale}
          onGenerate={() => void generate()}
          onRerollSeed={() => setDraft({ ...draft, seed: rollSeed() })}
        />

        {playback && (
          <FirstAudioReadout
            ttfaMs={playback.ttfaMs}
            rtf={health?.measured?.rtf ?? null}
            transport={playback.mode}
            fellBack={playback.fellBack}
          />
        )}

        <ScriptEditor
          script={script}
          voices={voices}
          running={running}
          exportUrls={exportUrls}
          onImport={(source, filename) => {
            void client.importScript(source, filename).then(setScript);
          }}
          onEditCue={(cueId, patch) => {
            if (!script) return;
            void client.patchCue(script.id, cueId, patch).then(setScript);
          }}
          onRun={() => {
            if (!script) return;
            setRunning(true);
            void client
              .runScript(script.id, () => {
                void client.script(script.id).then(setScript);
              })
              .finally(() => {
                setRunning(false);
                void client.script(script.id).then(setScript);
                void refresh();
              });
          }}
        />
      </main>

      <aside className="sidebar">
        <History
          clips={clips}
          selectedId={selectedClipId}
          clipUrl={(id) => client.clipUrl(id)}
          readOnlyReason={health === null ? 'The gateway is unreachable — history is read-only.' : null}
          onSelect={(clip) => setSelectedClipId(clip.id)}
          onReplay={(clip) => {
            // Replay does not clear or reset the console, so an A/B comparison
            // never destroys the work in progress that prompted it.
            replay.current?.pause();
            replay.current = playCachedClip(client.clipUrl(clip.id));
          }}
          onLoadIntoConsole={loadIntoConsole}
          onPromoteToReference={(clip) => void promote(clip)}
          onSaveAsVoice={(clip) => void saveAsVoice(clip)}
        />

        <div style={{ marginTop: 32 }}>
          <VoiceLibrary
            voices={voices}
            selectedId={mode.reference?.voiceId ?? null}
            pendingUndo={pendingUndo}
            onSelect={(voice) =>
              setMode({
                ...mode,
                mode: mode.mode === 'design' ? 'clone' : mode.mode,
                reference: {
                  source: 'library',
                  voiceId: voice.id,
                  name: voice.name,
                  durationSeconds: voice.durationSeconds,
                },
                refText: voice.transcript,
              })
            }
            onRename={(voice, name) => {
              void client.updateVoice(voice.id, { name }).then(() => refresh());
            }}
            onDelete={(voice) => void deleteVoice(voice)}
            onUndo={(undo) => void undoDelete(undo)}
          />
        </div>
      </aside>
    </div>
  );
}
