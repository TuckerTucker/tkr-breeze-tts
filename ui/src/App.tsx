/**
 * Application composition root for the voice lifecycle workspaces.
 *
 * State ownership stays here while each workspace remains a prop-driven view.
 * Gateway, audio, and storage are injected so resource failure, persistence,
 * and complete user journeys remain testable without browser globals.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import { ApiError, GatewayClient, type SpeechRequest } from './api/client.js';
import {
  StreamingPlayer,
  playCachedClip,
  type AudioBackend,
  type PlaybackResult,
} from './audio/player.js';
import { ActivityIndicator } from './components/ActivityIndicator.js';
import { ScriptsWorkspace } from './components/ScriptsWorkspace.js';
import { SpeakWorkspace } from './components/SpeakWorkspace.js';
import {
  INITIAL_VOICE_CREATION_DRAFT,
  VoiceWorkspace,
  type VoiceCreationDraft,
} from './components/VoiceWorkspace.js';
import { WorkspaceNav } from './components/WorkspaceNav.js';
import { FirstAudioReadout, ReadinessBadge, WakeState } from './components/WakeState.js';
import {
  activitySummary,
  addActivity,
  removeActivity,
  type Activity,
} from './state/activity.js';
import { generateBlockedReason, rollSeed, tokenCeilingFor } from './state/draft.js';
import { restoreFromClip, type Clip } from './state/history.js';
import { cfgControlFrom, type CfgControl } from './state/mode.js';
import { suggestName } from './state/name.js';
import {
  createInitialReferenceSelection,
  moveReferenceWindow,
  referenceCeilingFor,
  referenceSelectionBlocker,
  type StagedReferenceSelection,
} from './state/reference.js';
import {
  incompleteStreamFailure,
  readinessSummary,
  shouldShowWake,
  type Health,
} from './state/readiness.js';
import {
  applyCuePatch,
  applyScriptDefaults,
  type CuePatch,
  type Script,
  type ScriptDefaults,
  type ScriptSummary,
} from './state/script.js';
import { applyDelete, applyUndo, type PendingUndo, type Voice } from './state/voices.js';
import {
  legacyModeFor,
  loadWorkspaceState,
  projectSpeechRequest,
  resolveVoiceSpec,
  saveWorkspaceState,
  type SpeakDraft,
  type Workspace,
  type WorkspaceState,
} from './state/workspace.js';

/** What the app needs injected, so it can be mounted in a test. */
export interface AppProps {
  readonly client: GatewayClient;
  readonly audio: AudioBackend;
  readonly storage: Storage;
}

interface ContextFailure {
  readonly message: string;
  readonly remedy?: string;
}

function failureFrom(error: unknown, fallback: string): ContextFailure {
  const body = error instanceof ApiError ? error.failure : null;
  return {
    message: body?.message ?? (error instanceof Error ? error.message : fallback),
    ...(body?.remedy ? { remedy: body.remedy } : {}),
  };
}

function failureLine(failure: ContextFailure | null): string | null {
  if (!failure) return null;
  return `${failure.message}${failure.remedy ? ` — ${failure.remedy}` : ''}`;
}

/**
 * Render and compose Voices, Speak, and Scripts over one normalized state graph.
 *
 * @param props - Injected gateway, audio backend, and durable storage.
 * @returns The complete application.
 */
export function App(props: AppProps): JSX.Element {
  const { client } = props;
  const [workspace, setWorkspace] = useState<WorkspaceState>(() =>
    loadWorkspaceState(props.storage),
  );
  const [creation, setCreation] = useState<VoiceCreationDraft>(
    INITIAL_VOICE_CREATION_DRAFT,
  );
  const [health, setHealth] = useState<Health | null>(null);
  const [cfgControl, setCfgControl] = useState<CfgControl>(() => cfgControlFrom(null));
  const [cfgUnmeasured, setCfgUnmeasured] = useState(true);
  const [referenceFinding, setReferenceFinding] = useState<unknown>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [summaries, setSummaries] = useState<ScriptSummary[]>([]);
  const [script, setScript] = useState<Script | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);
  const [activities, setActivities] = useState<readonly Activity[]>([]);
  const [generating, setGenerating] = useState(false);
  const [running, setRunning] = useState(false);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wakeElapsedMs, setWakeElapsedMs] = useState(0);
  const [playback, setPlayback] = useState<PlaybackResult | null>(null);
  const [speakFailure, setSpeakFailure] = useState<ContextFailure | null>(null);
  const [voiceFailure, setVoiceFailure] = useState<ContextFailure | null>(null);
  const [scriptFailure, setScriptFailure] = useState<ContextFailure | null>(null);

  const player = useRef<StreamingPlayer | null>(null);
  const replay = useRef<HTMLAudioElement | null>(null);
  const nextActivityId = useRef(0);
  const initialLastScriptId = useRef(workspace.lastScriptId);
  const defaultsRevision = useRef(0);
  const cueRevisions = useRef(new Map<string, number>());

  useEffect(() => saveWorkspaceState(props.storage, workspace), [props.storage, workspace]);

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

  const refreshHealth = useCallback(async (): Promise<void> => {
    try {
      setHealth(await client.health());
    } catch {
      setHealth(null);
    }
  }, [client]);

  const refreshClips = useCallback(async (): Promise<void> => {
    try {
      setClips(await client.clips());
    } catch (error) {
      setSpeakFailure(failureFrom(error, 'Recent clips could not be loaded.'));
    }
  }, [client]);

  const refreshVoices = useCallback(async (): Promise<void> => {
    try {
      setVoices(await client.voices());
    } catch (error) {
      setVoiceFailure(failureFrom(error, 'The voice library could not be loaded.'));
    }
  }, [client]);

  const refreshSummaries = useCallback(async (): Promise<ScriptSummary[]> => {
    try {
      const next = await client.scripts();
      setSummaries(next);
      return next;
    } catch (error) {
      setScriptFailure(failureFrom(error, 'Script documents could not be loaded.'));
      return [];
    }
  }, [client]);

  const openScript = useCallback(async (id: string): Promise<void> => {
    setScriptLoading(true);
    setScriptFailure(null);
    try {
      const next = await trackActivity('Opening script…', () => client.script(id));
      setScript(next);
      setWorkspace((current) => ({ ...current, lastScriptId: next.id }));
    } catch (error) {
      setScript(null);
      setScriptFailure(failureFrom(error, 'The script could not be opened.'));
      setWorkspace((current) => ({ ...current, lastScriptId: null }));
    } finally {
      setScriptLoading(false);
    }
  }, [client, trackActivity]);

  useEffect(() => {
    void trackActivity('Checking readiness…', refreshHealth);
    void trackActivity('Loading recent clips…', refreshClips);
    void trackActivity('Loading voice library…', refreshVoices);
    void trackActivity('Loading measured limits…', async () => {
      try {
        const finding = await client.findings();
        setCfgControl(cfgControlFrom(finding));
        setCfgUnmeasured(!(finding as { measured?: boolean }).measured);
        setReferenceFinding(finding);
      } catch {
        // Conservative controls are already active and identify themselves.
      }
    });
    void trackActivity('Loading scripts…', async () => {
      const next = await refreshSummaries();
      const wanted = initialLastScriptId.current;
      if (wanted && next.some((summary) => summary.id === wanted)) {
        await openScript(wanted);
      }
    });
  }, [client, openScript, refreshClips, refreshHealth, refreshSummaries, refreshVoices, trackActivity]);

  useEffect(() => {
    if (!waking) return undefined;
    const startedAt = Date.now();
    const timer = setInterval(() => setWakeElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(timer);
  }, [waking]);

  const setActive = (active: Workspace): void =>
    setWorkspace((current) => ({ ...current, active }));

  const measuredReferenceShape = health?.limits.referenceSeconds
    ? { referenceCeiling: { measured: true, ...health.limits.referenceSeconds } }
    : null;
  const findingSpeakCeiling = referenceCeilingFor(
    referenceFinding,
    workspace.speakDraft.cfgScale,
  );
  const findingCreationCeiling = referenceCeilingFor(
    referenceFinding,
    creation.cfgScale,
  );
  const speakCeiling = findingSpeakCeiling.measured
    ? findingSpeakCeiling
    : referenceCeilingFor(measuredReferenceShape, workspace.speakDraft.cfgScale);
  const creationCeiling = findingCreationCeiling.measured
    ? findingCreationCeiling
    : referenceCeilingFor(measuredReferenceShape, creation.cfgScale);

  const effectiveSpeakDraft: SpeakDraft =
    workspace.speakDraft.voice.kind === 'staged' && workspace.speakDraft.voice.reference
      ? {
          ...workspace.speakDraft,
          voice: {
            kind: 'staged',
            reference: moveReferenceWindow(
              workspace.speakDraft.voice.reference,
              workspace.speakDraft.voice.reference.start,
              speakCeiling.maxSeconds,
            ),
          },
        }
      : workspace.speakDraft;
  const effectiveCreation: VoiceCreationDraft = creation.reference
    ? {
        ...creation,
        reference: moveReferenceWindow(
          creation.reference,
          creation.reference.start,
          creationCeiling.maxSeconds,
        ),
      }
    : creation;

  const resolution = resolveVoiceSpec(effectiveSpeakDraft, voices);
  const requestMode = resolution.spec
    ? legacyModeFor(resolution.spec)
    : effectiveSpeakDraft.voice.kind === 'described'
      ? 'design'
      : 'clone';
  const selectedTranscript =
    resolution.spec?.kind === 'referenced'
      ? resolution.spec.reference.transcript
      : effectiveSpeakDraft.voice.kind === 'staged'
        ? effectiveSpeakDraft.voice.reference?.transcript
        : undefined;
  const selectionBlocker =
    effectiveSpeakDraft.voice.kind === 'staged' && effectiveSpeakDraft.voice.reference
      ? referenceSelectionBlocker(
          effectiveSpeakDraft.voice.reference,
          speakCeiling.maxSeconds,
          tokenCeilingFor('clone', effectiveSpeakDraft.cfgScale),
        )
      : null;
  const blockedReason = generateBlockedReason({
    draft: effectiveSpeakDraft,
    gatewayReachable: health !== null,
    busy: false,
    generating,
    modeBlocker: resolution.blocker ?? selectionBlocker,
    cfgScale: effectiveSpeakDraft.cfgScale,
    mode: requestMode,
    ...(selectedTranscript ? { refText: selectedTranscript } : {}),
  });
  const speakStatus =
    failureLine(speakFailure) ??
    readinessSummary(health?.readiness ?? 'unknown', health?.measured ?? null);

  const stageReference = async (
    file: File,
    _source: 'upload' | 'record',
    maxSeconds: number,
  ): Promise<StagedReferenceSelection> =>
    trackActivity('Preparing reference…', async () => {
      const resource = await client.stageReference(file);
      return createInitialReferenceSelection(resource, file.name, maxSeconds);
    });

  const playResponse = async (
    response: Response,
    startedAt: number,
  ): Promise<PlaybackResult> => {
    await player.current?.stop();
    const active = new StreamingPlayer(props.audio);
    player.current = active;
    const result = await active.play(response, startedAt, {
      onFirstAudio: () => setWaking(false),
    });
    setPlayback(result);
    setSelectedClipId(result.clipId);
    return result;
  };

  const generate = async (): Promise<void> => {
    if (!resolution.spec) return;
    const spec = resolution.spec;
    await trackActivity('Generating speech…', async () => {
      setSpeakFailure(null);
      setPlayback(null);
      setGenerating(true);
      const cold = shouldShowWake(health?.readiness ?? 'unknown');
      setWaking(cold);
      setWakeElapsedMs(0);
      const seed = effectiveSpeakDraft.seedLocked ? effectiveSpeakDraft.seed : rollSeed();
      if (!effectiveSpeakDraft.seedLocked) {
        setWorkspace((current) => ({
          ...current,
          speakDraft: { ...current.speakDraft, seed },
        }));
      }
      const request = projectSpeechRequest({ ...effectiveSpeakDraft, seed }, spec);
      const startedAt = performance.now();
      try {
        const result = await playResponse(await client.speech(request), startedAt);
        if (result.incomplete) setSpeakFailure(incompleteStreamFailure(result));
      } catch (error) {
        setSpeakFailure(failureFrom(error, 'Speech could not be generated.'));
      } finally {
        setGenerating(false);
        setWaking(false);
        await Promise.all([refreshHealth(), refreshClips()]);
      }
    });
  };

  const auditionVoice = async (): Promise<void> => {
    setVoiceFailure(null);
    await trackActivity('Auditioning voice…', async () => {
      let request: SpeechRequest;
      if (effectiveCreation.method === 'clone-audio') {
        const reference = effectiveCreation.reference;
        if (!reference) {
          setVoiceFailure({ message: 'Prepare a reference before auditioning.' });
          return;
        }
        const blocker = referenceSelectionBlocker(
          reference,
          creationCeiling.maxSeconds,
          tokenCeilingFor('clone', effectiveCreation.cfgScale),
        );
        if (blocker) {
          setVoiceFailure({ message: blocker });
          return;
        }
        request = {
          text: effectiveCreation.sampleText,
          instruction: effectiveCreation.description,
          cfgScale: effectiveCreation.cfgScale,
          seed: effectiveCreation.seed,
          referenceId: reference.referenceId,
          refStart: reference.start,
          refEnd: reference.end,
          refText: reference.transcript,
        };
      } else {
        request = {
          text: effectiveCreation.sampleText,
          instruction: effectiveCreation.description,
          cfgScale: effectiveCreation.cfgScale,
          seed: effectiveCreation.seed,
        };
      }
      try {
        const startedAt = performance.now();
        const result = await playResponse(await client.speech(request), startedAt);
        if (result.incomplete) {
          setVoiceFailure(incompleteStreamFailure(result));
          return;
        }
        if (!result.clipId) throw new Error('The audition completed without a reusable clip.');
        setCreation((current) => ({ ...current, auditionClipId: result.clipId }));
        await refreshClips();
      } catch (error) {
        setVoiceFailure(failureFrom(error, 'The voice audition failed.'));
      }
    });
  };

  const saveCreatedVoice = async (): Promise<void> => {
    const clipId =
      effectiveCreation.method === 'from-clip'
        ? effectiveCreation.sourceClipId
        : effectiveCreation.auditionClipId;
    if (!clipId) return;
    setVoiceFailure(null);
    try {
      await trackActivity('Saving voice…', async () => {
        await client.saveVoice({
          clipId,
          name: effectiveCreation.name,
          defaultDirection: effectiveCreation.description || null,
        });
        await refreshVoices();
      });
      setCreation({ ...INITIAL_VOICE_CREATION_DRAFT, open: false });
    } catch (error) {
      setVoiceFailure(failureFrom(error, 'The voice could not be saved.'));
    }
  };

  const useVoiceInSpeak = (voice: Voice): void => {
    setWorkspace((current) => ({
      ...current,
      active: 'speak',
      selectedVoiceId: voice.id,
      speakDraft: {
        ...current.speakDraft,
        instruction: voice.defaultDirection ?? current.speakDraft.instruction,
        voice: { kind: 'saved', voiceId: voice.id, voiceName: voice.name },
      },
    }));
  };

  const updateScriptDefaults = (patch: Partial<ScriptDefaults>): void => {
    if (!script) return;
    defaultsRevision.current += 1;
    const revision = defaultsRevision.current;
    setScript((current) => (current ? applyScriptDefaults(current, patch) : current));
    void trackActivity('Saving script defaults…', async () => {
      try {
        const updated = await client.updateScript(script.id, patch);
        if (defaultsRevision.current === revision) setScript(updated);
        await refreshSummaries();
      } catch (error) {
        setScriptFailure(failureFrom(error, 'Script defaults could not be saved.'));
      }
    });
  };

  const useVoiceInScript = (voice: Voice): void => {
    setWorkspace((current) => ({
      ...current,
      active: 'scripts',
      selectedVoiceId: voice.id,
    }));
    if (script) updateScriptDefaults({ voiceId: voice.id, voiceName: voice.name });
  };

  const deleteVoice = async (voice: Voice): Promise<void> => {
    const previous = voices;
    const applied = applyDelete(voices, voice.id, Date.now());
    setVoices(applied.voices);
    setPendingUndo(applied.undo);
    try {
      await trackActivity('Deleting voice…', async () => client.deleteVoice(voice.id));
    } catch (error) {
      setVoices(previous);
      setPendingUndo(null);
      setVoiceFailure(failureFrom(error, 'The voice could not be deleted.'));
    }
  };

  const undoDelete = async (undo: PendingUndo): Promise<void> => {
    setVoices((current) => applyUndo(current, undo.voice));
    setPendingUndo(null);
    try {
      await trackActivity('Restoring voice…', async () => client.restoreVoice(undo.voice.id));
    } catch (error) {
      setVoices((current) => current.filter((voice) => voice.id !== undo.voice.id));
      setVoiceFailure(failureFrom(error, 'The voice could not be restored.'));
    }
  };

  const importScript = async (source: string, filename: string): Promise<void> => {
    setScriptFailure(null);
    try {
      const imported = await trackActivity('Importing script…', () =>
        client.importScript(source, filename, {
          ...(workspace.selectedVoiceId
            ? {
                voiceId: workspace.selectedVoiceId,
                voiceName:
                  voices.find((voice) => voice.id === workspace.selectedVoiceId)?.name ?? null,
              }
            : {}),
        }),
      );
      setScript(imported);
      setWorkspace((current) => ({ ...current, lastScriptId: imported.id }));
      await refreshSummaries();
    } catch (error) {
      setScriptFailure(failureFrom(error, 'The script could not be imported.'));
    }
  };

  const editScriptCue = (cueId: string, patch: CuePatch): void => {
    if (!script) return;
    const revision = (cueRevisions.current.get(cueId) ?? 0) + 1;
    cueRevisions.current.set(cueId, revision);
    setScript((current) => (current ? applyCuePatch(current, cueId, patch) : current));
    void trackActivity('Saving cue edit…', async () => {
      try {
        const updated = await client.patchCue(script.id, cueId, patch);
        if (cueRevisions.current.get(cueId) === revision) setScript(updated);
      } catch (error) {
        setScriptFailure(failureFrom(error, 'The cue edit could not be saved.'));
      }
    });
  };

  const runCurrentScript = async (): Promise<void> => {
    if (!script) return;
    setRunning(true);
    setScriptFailure(null);
    try {
      await trackActivity('Running stale script cues…', async () => {
        await client.runScript(script.id, () => {
          void client.script(script.id).then(setScript).catch(() => {});
        });
        setScript(await client.script(script.id));
        await Promise.all([refreshSummaries(), refreshClips()]);
      });
    } catch (error) {
      setScriptFailure(failureFrom(error, 'The script run could not be completed.'));
    } finally {
      setRunning(false);
    }
  };

  const exportScript = async (format: 'vtt' | 'wav'): Promise<void> => {
    if (!script) return;
    try {
      await trackActivity(`Exporting ${format.toUpperCase()}…`, async () => {
        const blob = await client.exportScript(script.id, format);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${script.name.replace(/\.(vtt|txt)$/i, '')}.${format}`;
        anchor.click();
        URL.revokeObjectURL(url);
      });
    } catch (error) {
      setScriptFailure(failureFrom(error, `The ${format.toUpperCase()} export failed.`));
    }
  };

  const loadVariation = (clip: Clip): void => {
    const restored = restoreFromClip(clip);
    const voice = restored.voiceId
      ? voices.find((candidate) => candidate.id === restored.voiceId)
      : undefined;
    setWorkspace((current) => ({
      ...current,
      active: 'speak',
      selectedVoiceId: voice?.id ?? null,
      speakDraft: {
        ...current.speakDraft,
        text: restored.text,
        instruction: restored.instruction,
        cfgScale: restored.cfgScale,
        seed: restored.seed,
        voice: voice
          ? { kind: 'saved', voiceId: voice.id, voiceName: voice.name }
          : { kind: 'described' },
      },
    }));
  };

  const replayClip = async (clip: Clip): Promise<void> => {
    setSpeakFailure(null);
    try {
      await trackActivity('Loading replay…', async () => {
        replay.current?.pause();
        const cached = playCachedClip(client.clipUrl(clip.id));
        replay.current = cached.element;
        await cached.started;
      });
    } catch (error) {
      setSpeakFailure(failureFrom(error, 'The cached clip could not be replayed.'));
    }
  };

  const currentActivity = activitySummary(activities);
  const branchLimits = health?.limits.referenceSeconds?.ceilingByBranchMode ?? null;
  const recordReason =
    health?.ffmpeg.available === false
      ? `Recording requires ffmpeg. ${health.ffmpeg.remedy ?? ''}`
      : null;
  const playbackReadout =
    playback && playback.bytes > 0 ? (
      <FirstAudioReadout
        ttfaMs={playback.ttfaMs}
        rtf={health?.measured?.rtf ?? null}
        transport={playback.mode}
        fellBack={playback.fellBack}
      />
    ) : null;

  return (
    <div className="app-shell" aria-busy={currentActivity !== null}>
      <header className="masthead">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">B</span>
          <div><h1>Breeze Voice Studio</h1><p>Create a voice once. Use it everywhere.</p></div>
        </div>
        <div className="masthead__signals">
          {currentActivity && <ActivityIndicator label={currentActivity} />}
          <ReadinessBadge readiness={health?.readiness ?? 'unknown'} measured={health?.measured ?? null} />
        </div>
      </header>

      <WorkspaceNav active={workspace.active} onSelect={setActive} />

      <main className="workspace-stage">
        {waking && <WakeState elapsedMs={wakeElapsedMs} measured={health?.measured ?? null} />}

        {workspace.active === 'voices' && (
          <VoiceWorkspace
            voices={voices}
            clips={clips}
            draft={effectiveCreation}
            onDraftChange={setCreation}
            cfgControl={cfgControl}
            cfgUnmeasured={cfgUnmeasured}
            busy={currentActivity !== null}
            problem={failureLine(voiceFailure)}
            pendingUndo={pendingUndo}
            onAudition={() => void auditionVoice()}
            onSave={() => void saveCreatedVoice()}
            onRename={(voice, name) => {
              void trackActivity('Renaming voice…', async () => {
                try {
                  await client.updateVoice(voice.id, { name });
                  await refreshVoices();
                } catch (error) {
                  setVoiceFailure(failureFrom(error, 'The voice could not be renamed.'));
                }
              });
            }}
            onDelete={(voice) => void deleteVoice(voice)}
            onUndo={(undo) => void undoDelete(undo)}
            onUseInSpeak={useVoiceInSpeak}
            onUseInScript={useVoiceInScript}
            voiceAudioUrl={(id) => `/api/voices/${encodeURIComponent(id)}/audio`}
            onStage={(file, source) => stageReference(file, source, creationCeiling.maxSeconds)}
            canRecord={health?.ffmpeg.available ?? false}
            recordDisabledReason={recordReason}
            referenceMaxSeconds={creationCeiling.maxSeconds}
            referenceMaxMeasured={creationCeiling.measured}
            referenceBranchLimits={branchLimits}
            referenceTokenCeiling={tokenCeilingFor('clone', effectiveCreation.cfgScale)}
            referenceAudioUrl={(id, start, end) => client.referenceAudioUrl(id, start, end)}
            asrRemedy={health?.asr.available === false ? health.asr.remedy : null}
          />
        )}

        {workspace.active === 'speak' && (
          <SpeakWorkspace
            draft={effectiveSpeakDraft}
            onDraftChange={(speakDraft) => setWorkspace((current) => ({ ...current, speakDraft }))}
            voices={voices}
            cfgControl={cfgControl}
            cfgUnmeasured={cfgUnmeasured}
            blockedReason={blockedReason}
            statusLine={speakStatus}
            onGenerate={() => void generate()}
            onRerollSeed={() => setWorkspace((current) => ({ ...current, speakDraft: { ...current.speakDraft, seed: rollSeed() } }))}
            generating={generating}
            clips={clips}
            selectedClipId={selectedClipId}
            onSelectClip={(clip) => setSelectedClipId(clip.id)}
            onReplay={(clip) => {
              void replayClip(clip);
            }}
            onLoadVariation={loadVariation}
            onCreateVoiceFromClip={(clip) => {
              setCreation({
                ...INITIAL_VOICE_CREATION_DRAFT,
                open: true,
                method: 'from-clip',
                sourceClipId: clip.id,
                name: suggestName(clip.request.instruction),
              });
              setActive('voices');
            }}
            onSaveVoice={(clip) => {
              void trackActivity('Saving voice…', async () => {
                try {
                  await client.saveVoice({ clipId: clip.id, name: suggestName(clip.request.instruction) });
                  await refreshVoices();
                } catch (error) {
                  setSpeakFailure(failureFrom(error, 'The voice could not be saved.'));
                }
              });
            }}
            clipUrl={(id) => client.clipUrl(id)}
            historyReadOnlyReason={health === null ? 'The gateway is unreachable — history is read-only.' : null}
            playbackReadout={playbackReadout}
            onStage={(file, source) => stageReference(file, source, speakCeiling.maxSeconds)}
            canRecord={health?.ffmpeg.available ?? false}
            recordDisabledReason={recordReason}
            referenceMaxSeconds={speakCeiling.maxSeconds}
            referenceMaxMeasured={speakCeiling.measured}
            referenceBranchLimits={branchLimits}
            referenceTokenCeiling={tokenCeilingFor('clone', effectiveSpeakDraft.cfgScale)}
            referenceAudioUrl={(id, start, end) => client.referenceAudioUrl(id, start, end)}
            asrRemedy={health?.asr.available === false ? health.asr.remedy : null}
          />
        )}

        {workspace.active === 'scripts' && (
          <ScriptsWorkspace
            summaries={summaries}
            script={script}
            voices={voices}
            running={running}
            loading={scriptLoading}
            problem={failureLine(scriptFailure)}
            onOpen={(id) => void openScript(id)}
            onImport={(source, filename) => void importScript(source, filename)}
            onCreate={() => void importScript('New line.', 'Untitled script.txt')}
            onUpdateDefaults={updateScriptDefaults}
            onEditCue={editScriptCue}
            onRun={() => void runCurrentScript()}
            onExport={(format) => void exportScript(format)}
            clipUrl={(id) => client.clipUrl(id)}
          />
        )}
      </main>
    </div>
  );
}
