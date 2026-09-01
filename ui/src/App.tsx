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
import { ActivityIndicator } from './components/ActivityIndicator.js';
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
  tokenCeilingFor,
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
  type ReferenceSource,
  type VoiceMode,
} from './state/mode.js';
import { promoteToReference, restoreFromClip, type Clip } from './state/history.js';
import {
  createInitialReferenceSelection,
  moveReferenceWindow,
  referenceCeilingFor,
  referenceSelectionBlocker,
} from './state/reference.js';
import {
  incompleteStreamFailure,
  readinessSummary,
  shouldShowWake,
  type Health,
} from './state/readiness.js';
import { applyDelete, applyUndo, type PendingUndo, type Voice } from './state/voices.js';
import { suggestName } from './state/name.js';
import type { Cue, Script } from './state/script.js';
import {
  activitySummary,
  addActivity,
  removeActivity,
  type Activity,
} from './state/activity.js';

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
  const [referenceFinding, setReferenceFinding] = useState<unknown>(null);
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
  const [activities, setActivities] = useState<readonly Activity[]>([]);

  const player = useRef<StreamingPlayer | null>(null);
  const replay = useRef<HTMLAudioElement | null>(null);
  const nextActivityId = useRef(0);

  useEffect(() => saveDraft(props.storage, draft), [draft, props.storage]);

  const trackActivity = useCallback(async <T,>(
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    nextActivityId.current += 1;
    const id = nextActivityId.current;
    setActivities((current) => addActivity(current, { id, label }));
    try {
      return await operation();
    } finally {
      setActivities((current) => removeActivity(current, id));
    }
  }, []);

  const loadWorkspace = useCallback(async (): Promise<void> => {
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

  const refresh = useCallback(
    async (): Promise<void> => trackActivity('Syncing workspace…', loadWorkspace),
    [loadWorkspace, trackActivity],
  );

  useEffect(() => {
    void refresh();
    void trackActivity('Loading measured limits…', async () => {
      try {
        const finding = await client.findings();
        setCfgControl(cfgControlFrom(finding));
        setCfgUnmeasured(!(finding as { measured?: boolean }).measured);
        setReferenceFinding(finding);
      } catch {
        // The conservative default is already in place.
      }
    });
  }, [client, refresh, trackActivity]);

  // The wake clock. Nothing here polls the gateway, and nothing polls upstream:
  // `/health` on a scaled-to-zero container would start the cold start it was
  // checking for.
  useEffect(() => {
    if (!waking) return undefined;
    const startedAt = Date.now();
    const timer = setInterval(() => setWakeElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(timer);
  }, [waking]);

  const findingReferenceCeiling = referenceCeilingFor(referenceFinding, mode.cfgScale);
  const healthReferenceCeiling = referenceCeilingFor(
    health?.limits.referenceSeconds
      ? {
          referenceCeiling: {
            measured: true,
            ...health.limits.referenceSeconds,
          },
        }
      : null,
    mode.cfgScale,
  );
  const referenceCeiling = findingReferenceCeiling.measured
    ? findingReferenceCeiling
    : healthReferenceCeiling;
  const referenceTokenCeiling = tokenCeilingFor(mode.mode, mode.cfgScale);
  const stagedReference =
    mode.reference?.source === 'upload' || mode.reference?.source === 'record'
      ? mode.reference
      : null;
  const boundedStagedReference = stagedReference
    ? moveReferenceWindow(
        stagedReference,
        stagedReference.start,
        referenceCeiling.maxSeconds,
      )
    : null;
  const effectiveMode = boundedStagedReference
    ? { ...mode, reference: { ...boundedStagedReference, source: stagedReference!.source } }
    : mode;
  const referenceBlocker = boundedStagedReference
    ? referenceSelectionBlocker(
        boundedStagedReference,
        referenceCeiling.maxSeconds,
        referenceTokenCeiling,
      )
    : null;
  const blocker = modeBlocker(effectiveMode) ?? referenceBlocker;
  const blockedReason = generateBlockedReason({
    draft,
    gatewayReachable: health !== null,
    busy,
    generating,
    modeBlocker: blocker,
    cfgScale: mode.cfgScale,
    mode: mode.mode,
    ...(effectiveMode.reference?.transcript
      ? { refText: effectiveMode.reference.transcript }
      : {}),
  });

  const statusLine = failure
    ? `${failure.message}${failure.remedy ? ` — ${failure.remedy}` : ''}`
    : readinessSummary(health?.readiness ?? 'unknown', health?.measured ?? null);

  const generate = async (): Promise<void> => {
    await trackActivity('Generating speech…', async () => {
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
          ...(effectiveMode.reference?.source === 'library'
            ? { voiceId: effectiveMode.reference.voiceId }
            : effectiveMode.reference
              ? {
                  referenceId: effectiveMode.reference.referenceId,
                  refStart: effectiveMode.reference.start,
                  refEnd: effectiveMode.reference.end,
                }
              : {}),
          ...(effectiveMode.reference?.transcript
            ? { refText: effectiveMode.reference.transcript }
            : {}),
        });

        await player.current?.stop();
        const active = new StreamingPlayer(props.audio);
        player.current = active;

        const result = await active.play(response, startedAt, {
          onFirstAudio: () => setWaking(false),
        });
        setPlayback(result);
        setSelectedClipId(result.clipId);
        // A truncated stream arrives as a `200` with too few bytes, so nothing
        // above throws and nothing below would say so. The player is the only
        // layer that can see it, and this is where it becomes visible.
        if (result.incomplete) setFailure(incompleteStreamFailure(result));
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
        await loadWorkspace();
      }
    });
  };

  const onModeChange = (next: VoiceMode): void => {
    if (next === 'design' && stagedReference) {
      void client.deleteReference(stagedReference.referenceId).catch(() => {
        // The store is age-bounded. A failed eager cleanup does not lose work
        // or make the next request invalid, so it needs no operator action.
      });
    }
    setMode(switchMode(mode, next));
  };

  const prepareReference = async (
    file: File,
    source: Exclude<ReferenceSource, 'library'>,
    transcriptOverride?: string,
  ): Promise<void> => {
    try {
      const resource = await client.stageReference(file);
      const initial = createInitialReferenceSelection(
        resource,
        file.name,
        referenceCeiling.maxSeconds,
      );
      const reference = transcriptOverride
        ? {
            ...initial,
            transcript: transcriptOverride,
            transcriptEdited: transcriptOverride.trim() !== initial.transcript.trim(),
          }
        : initial;
      const previousId = stagedReference?.referenceId ?? null;
      setMode((current) => ({
        ...current,
        reference: { ...reference, source },
      }));
      await loadWorkspace();
      if (previousId && previousId !== resource.id) {
        void client.deleteReference(previousId).catch(() => {
          // Age-bounded cleanup is the fallback if eager replacement cleanup fails.
        });
      }
    } catch (error) {
      const body = error instanceof ApiError ? error.failure : null;
      const message =
        body?.message ??
        (error instanceof Error
          ? error.message
          : 'The reference could not be prepared. The current reference is unchanged.');
      throw new Error(body?.remedy ? `${message} ${body.remedy}` : message);
    }
  };

  const stageReference = async (
    file: File,
    source: Exclude<ReferenceSource, 'library'>,
  ): Promise<void> => trackActivity(
    'Preparing reference…',
    async () => prepareReference(file, source),
  );

  const loadIntoConsole = (clip: Clip): void => {
    const restore = restoreFromClip(clip);
    const voice = restore.voiceId
      ? voices.find((candidate) => candidate.id === restore.voiceId) ?? null
      : null;
    if (stagedReference) {
      void client.deleteReference(stagedReference.referenceId).catch(() => {
        // The age limit still bounds a failed eager cleanup.
      });
    }
    setDraft({ ...draft, text: restore.text, instruction: restore.instruction, seed: restore.seed });
    setMode({
      ...mode,
      mode: restore.mode,
      cfgScale: restore.cfgScale,
      reference:
        restore.mode !== 'design' && voice
          ? {
              source: 'library',
              voiceId: voice.id,
              name: voice.name,
              durationSeconds: voice.durationSeconds,
              transcript: voice.transcript,
            }
          : null,
    });
  };

  const promote = async (clip: Clip): Promise<void> => {
    await trackActivity('Preparing clip as a reference…', async () => {
      // Switch to Clone rather than silently attaching a reference the current
      // mode cannot send, and fill ref_text from the text that produced it.
      const promotion = promoteToReference(clip);
      const blob = await client.clipAudio(clip.id);
      setMode((current) => ({ ...current, mode: promotion.mode }));
      await prepareReference(
        new File([blob], promotion.referenceName, { type: 'audio/wav' }),
        'upload',
        promotion.refText,
      );
    });
  };

  const saveAsVoice = async (clip: Clip): Promise<void> => {
    await trackActivity('Saving voice…', async () => {
      await client.saveVoice({ clipId: clip.id, name: suggestName(clip.request.instruction) });
      await loadWorkspace();
    });
  };

  const deleteVoice = async (voice: Voice): Promise<void> => {
    const applied = applyDelete(voices, voice.id, Date.now());
    setVoices(applied.voices);
    setPendingUndo(applied.undo);
    await trackActivity('Deleting voice…', async () => client.deleteVoice(voice.id));
  };

  const undoDelete = async (undo: PendingUndo): Promise<void> => {
    setVoices(applyUndo(voices, undo.voice));
    setPendingUndo(null);
    await trackActivity('Restoring voice…', async () => client.restoreVoice(undo.voice.id));
  };

  const reportOperationFailure = (error: unknown, fallback: string): void => {
    const body = error instanceof ApiError ? error.failure : null;
    setFailure({
      message:
        body?.message ??
        (error instanceof Error ? error.message : fallback),
      ...(body?.remedy ? { remedy: body.remedy } : {}),
    });
  };

  const importScript = async (source: string, filename: string): Promise<void> => {
    const imported = await trackActivity(
      'Importing script…',
      async () => client.importScript(source, filename),
    );
    setScript(imported);
  };

  const editCue = async (cueId: string, patch: Partial<Cue>): Promise<void> => {
    if (!script) return;
    const updated = await trackActivity(
      'Saving script edit…',
      async () => client.patchCue(script.id, cueId, patch),
    );
    setScript(updated);
  };

  const runCurrentScript = async (): Promise<void> => {
    if (!script) return;
    setRunning(true);
    try {
      await trackActivity('Running script…', async () => {
        try {
          await client.runScript(script.id, () => {
            void client.script(script.id).then(setScript).catch((error: unknown) => {
              reportOperationFailure(error, 'Script progress could not be refreshed.');
            });
          });
        } finally {
          try {
            setScript(await client.script(script.id));
          } finally {
            await loadWorkspace();
          }
        }
      });
    } finally {
      setRunning(false);
    }
  };

  const renameVoice = async (voice: Voice, name: string): Promise<void> => {
    await trackActivity('Renaming voice…', async () => {
      await client.updateVoice(voice.id, { name });
      await loadWorkspace();
    });
  };

  const exportUrls = useMemo(
    () => (script ? client.scriptExportUrls(script.id) : null),
    [client, script],
  );

  const currentActivity = activitySummary(activities);

  return (
    <div className="app" aria-busy={currentActivity !== null}>
      <header className="masthead">
        <h1>Breeze TTS 2</h1>
        <div className="masthead__signals">
          {currentActivity && <ActivityIndicator label={currentActivity} />}
          <ReadinessBadge
            readiness={health?.readiness ?? 'unknown'}
            measured={health?.measured ?? null}
          />
        </div>
      </header>

      <main>
        {waking && <WakeState elapsedMs={wakeElapsedMs} measured={health?.measured ?? null} />}

        <VoiceModes
          state={mode}
          onChange={(next) => {
            if (stagedReference && next.reference?.source === 'library') {
              void client.deleteReference(stagedReference.referenceId).catch(() => {
                // The age limit still bounds a failed eager cleanup.
              });
            }
            setMode(next);
          }}
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
          onStageReference={(file, source) => stageReference(file, source)}
          referenceMaxSeconds={referenceCeiling.maxSeconds}
          referenceMaxMeasured={referenceCeiling.measured}
          referenceBranchLimits={
            health?.limits.referenceSeconds?.ceilingByBranchMode ?? null
          }
          referenceTokenCeiling={referenceTokenCeiling}
          referenceAudioUrl={(id, start, end) => client.referenceAudioUrl(id, start, end)}
          asrRemedy={health?.asr?.available === false ? health.asr.remedy : null}
        />

        <Console
          draft={draft}
          onDraftChange={setDraft}
          blockedReason={blockedReason}
          statusLine={statusLine}
          cfgScale={mode.cfgScale}
          mode={mode.mode}
          onGenerate={() => void generate()}
          onRerollSeed={() => setDraft({ ...draft, seed: rollSeed() })}
        />

        {playback && playback.bytes > 0 && (
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
            void importScript(source, filename).catch((error: unknown) => {
              reportOperationFailure(error, 'The script could not be imported.');
            });
          }}
          onEditCue={(cueId, patch) => {
            void editCue(cueId, patch).catch((error: unknown) => {
              reportOperationFailure(error, 'The script edit could not be saved.');
            });
          }}
          onRun={() => {
            void runCurrentScript().catch((error: unknown) => {
              reportOperationFailure(error, 'The script could not be completed.');
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
          onPromoteToReference={(clip) => {
            void promote(clip).catch((error: unknown) => {
              reportOperationFailure(error, 'The clip could not be prepared as a reference.');
            });
          }}
          onSaveAsVoice={(clip) => {
            void saveAsVoice(clip).catch((error: unknown) => {
              reportOperationFailure(error, 'The voice could not be saved.');
            });
          }}
        />

        <div style={{ marginTop: 32 }}>
          <VoiceLibrary
            voices={voices}
            selectedId={
              mode.reference?.source === 'library' ? mode.reference.voiceId : null
            }
            pendingUndo={pendingUndo}
            onSelect={(voice) => {
              if (stagedReference) {
                void client.deleteReference(stagedReference.referenceId).catch(() => {
                  // The age limit still bounds a failed eager cleanup.
                });
              }
              setMode({
                ...mode,
                mode: mode.mode === 'design' ? 'clone' : mode.mode,
                reference: {
                  source: 'library',
                  voiceId: voice.id,
                  name: voice.name,
                  durationSeconds: voice.durationSeconds,
                  transcript: voice.transcript,
                },
              });
            }}
            onRename={(voice, name) => {
              void renameVoice(voice, name).catch((error: unknown) => {
                reportOperationFailure(error, 'The voice could not be renamed.');
              });
            }}
            onDelete={(voice) => {
              void deleteVoice(voice).catch((error: unknown) => {
                reportOperationFailure(error, 'The voice could not be deleted.');
              });
            }}
            onUndo={(undo) => {
              void undoDelete(undo).catch((error: unknown) => {
                reportOperationFailure(error, 'The voice could not be restored.');
              });
            }}
          />
        </div>
      </aside>
    </div>
  );
}
