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

import {
  ApiError,
  GatewayClient,
  type ScriptRunProgress,
  type SessionOutcome,
  type SpeechRequest,
} from './api/client.js';
import {
  PlaybackOwner,
  type AudioBackend,
  type PlaybackResult,
} from './audio/player.js';
import { AccessGate } from './components/AccessGate.js';
import { ActivityIndicator } from './components/ActivityIndicator.js';
import { ScriptsWorkspace } from './components/ScriptsWorkspace.js';
import {
  SpeakWorkspace,
  type SharedGenerationWait,
} from './components/SpeakWorkspace.js';
import { VoiceWorkspace } from './components/VoiceWorkspace.js';
import { WorkspaceNav } from './components/WorkspaceNav.js';
import {
  FirstAudioReadout,
  ReadinessBadge,
  WakeState,
  WarmUpButton,
} from './components/WakeState.js';
import {
  activitySummary,
  addActivity,
  removeActivity,
  type Activity,
} from './state/activity.js';
import { generateBlockedReason, tokenCeilingFor } from './state/draft.js';
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
  INITIAL_CREATION_DRAFT,
  legacyModeFor,
  loadWorkspaceState,
  projectSpeechRequest,
  resolveAvailableSpeakVoiceSource,
  resolveVoiceSpec,
  saveWorkspaceState,
  SPEAK_VOICE_SOURCE_AVAILABILITY,
  WORKSPACE_AVAILABILITY,
  type ProjectedSpeechRequest,
  type SpeakDraft,
  type SpeakVoiceSourceAvailability,
  type VoiceCreationDraft,
  type Workspace,
  type WorkspaceState,
} from './state/workspace.js';

/**
 * The timer seam.
 *
 * Two things in this shell are decided by elapsed time rather than by anything
 * the viewer does: how long a held request waits before it tries again, and
 * when an undo stops being offerable. Both are behaviour, so both are asserted
 * against an injected clock rather than slept through.
 */
export interface Scheduler {
  readonly setTimeout: (handler: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
}

const WINDOW_SCHEDULER: Scheduler = {
  setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

/** What the app needs injected, so it can be mounted in a test. */
export interface AppProps {
  readonly client: GatewayClient;
  readonly audio: AudioBackend;
  readonly storage: Storage;
  /** Overridden in tests; the browser's timers otherwise. */
  readonly scheduler?: Scheduler;
  /** Override dormant Speak sources for focused capability tests or future configuration. */
  readonly speakVoiceSourceAvailability?: Partial<SpeakVoiceSourceAvailability>;
  /**
   * Override dormant workspaces, so a gated tool can be exercised as it will
   * ship rather than only as a collection of parts.
   *
   * This decides what the shell mounts and loads. The primary navigation is
   * built from the module-level availability, so an override reaches a
   * workspace through the affordances that lead to it, not through a new tab.
   */
  readonly workspaceAvailability?: Partial<Record<Workspace, boolean>>;
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
 * How long a change waits before the workspace is written.
 *
 * The whole workspace is one JSON string, and a staged reference puts its peak
 * envelope and every word timing inside it. Writing that synchronously on each
 * keystroke would put a growing cost on the typing path for no benefit, since
 * nothing reads the value back until a reload. Coalescing is safe only because
 * the pending write is flushed before the page can go away.
 */
const PERSIST_DELAY_MS = 250;

/**
 * How long an export's object URL is kept alive after the anchor is clicked.
 *
 * The browser reads the blob when it starts writing the file, which is after
 * the click handler returns. Revoking synchronously is why the previous export
 * worked in Chrome, which tolerates it, and silently produced nothing in
 * Firefox, which does not.
 */
const EXPORT_URL_LIFETIME_MS = 10_000;

/**
 * How long a request refused by someone else's generation waits before it is
 * sent again, once per entry.
 *
 * Bounded on both axes on purpose. A waiting state that only waits would throw
 * away the press that produced it, and the standing rules do not permit losing
 * user work — but an unbounded retry is a queue nobody asked for, and this demo
 * has no live channel telling it when the lock is free. Three tries over
 * seventeen seconds is long enough to cover a neighbour's line and short enough
 * that "it gave up" is still an answer rather than a hang.
 */
const CONTENDED_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

/**
 * Fold one run frame into the open document.
 *
 * The frame carries the cue's state and its problem, which is everything a row
 * shows while a run is in flight. Actual duration and drift arrive with the one
 * refresh at the end, because only the cache can supply them.
 *
 * @param script - The open document, or null.
 * @param progress - One cue transition from the run stream.
 * @returns The document with that row updated, or the same object when nothing
 *   changed — so an unrelated frame cannot cause a re-render.
 */
function applyRunProgress(
  script: Script | null,
  progress: ScriptRunProgress,
): Script | null {
  // A frame naming another document belongs to a run whose script is no longer
  // open. Applying it by cue id alone would edit whatever happens to match.
  if (!script || script.id !== progress.scriptId) return script;
  let changed = false;
  const cues = script.cues.map((cue) => {
    if (cue.id !== progress.cueId) return cue;
    if (cue.state === progress.state && cue.problem === progress.problem) return cue;
    changed = true;
    return { ...cue, state: progress.state, problem: progress.problem };
  });
  return changed ? { ...script, cues } : script;
}

/**
 * Render and compose the available voice tools over one normalized state graph.
 *
 * @param props - Injected gateway, audio backend, and durable storage.
 * @returns The complete application.
 */
export function App(props: AppProps): JSX.Element {
  const { client } = props;
  const scheduler = props.scheduler ?? WINDOW_SCHEDULER;
  const speakVoiceSourceAvailability: SpeakVoiceSourceAvailability = {
    ...SPEAK_VOICE_SOURCE_AVAILABILITY,
    ...props.speakVoiceSourceAvailability,
  };
  const workspaceAvailability: Readonly<Record<Workspace, boolean>> = {
    ...WORKSPACE_AVAILABILITY,
    ...props.workspaceAvailability,
  };
  const scriptsAvailable = workspaceAvailability.scripts;
  const [workspace, setWorkspace] = useState<WorkspaceState>(() =>
    loadWorkspaceState(props.storage),
  );
  const creation = workspace.creationDraft;
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
  // Mirrors `waking` for the guard in warmUp, because a state read inside a
  // callback would see the value from the render that created it.
  const wakingRef = useRef(false);
  const [wakeElapsedMs, setWakeElapsedMs] = useState(0);
  const [playback, setPlayback] = useState<PlaybackResult | null>(null);
  const [speakFailure, setSpeakFailure] = useState<ContextFailure | null>(null);
  const [voiceFailure, setVoiceFailure] = useState<ContextFailure | null>(null);
  const [scriptFailure, setScriptFailure] = useState<ContextFailure | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [sharedWait, setSharedWait] = useState<SharedGenerationWait | null>(null);
  // The gate is on screen. The console below it stays mounted in this
  // component's state, which is the whole reason an expiry costs nothing.
  const [gated, setGated] = useState(false);
  // This deployment has a gate at all. Unknowable before the first refusal —
  // the shell is served to everyone and carries no configuration — so it is
  // learned rather than asked for, and the local demo, which never refuses
  // anything, never learns it and reads exactly as it always did.
  const [gateInUse, setGateInUse] = useState(false);
  /**
   * The gate went up over a console that was already working, rather than
   * standing in front of a visitor who has not been in yet.
   *
   * It changes only one sentence, but that sentence is the one that tells
   * someone mid-draft their work has not gone anywhere.
   */
  const [interrupted, setInterrupted] = useState(false);
  // Bumped by a successful re-entry, so the console reloads what it could not
  // read while the gate was up.
  const [sessionEpoch, setSessionEpoch] = useState(0);

  const nextActivityId = useRef(0);
  const initialLastScriptId = useRef(workspace.lastScriptId);
  const defaultsRevision = useRef(0);
  const cueRevisions = useRef(new Map<string, number>());
  const runRevision = useRef(0);
  const unwrittenWorkspace = useRef<WorkspaceState | null>(null);
  const retryTimer = useRef<number | null>(null);
  const heldRequest = useRef<ProjectedSpeechRequest | null>(null);
  /**
   * How many synthesis requests this client has open right now.
   *
   * This is the whole of the own-versus-other distinction. The vendor's lock is
   * process-wide and its 409 says nothing about who holds it, so the only fact
   * that separates "you are already generating" from "somebody else is" lives
   * here, in the browser that either did or did not send the other request.
   */
  const synthesisInFlight = useRef(0);
  /**
   * Which held request the waiting state belongs to.
   *
   * Bumped by a cancel and by a fresh press, so an attempt that was already on
   * the wire when the viewer stopped waiting cannot come back and reinstate the
   * state they just dismissed.
   */
  const waitEpoch = useRef(0);
  /**
   * The console has answered at least once.
   *
   * Distinguishes a first visit from a session that went away underneath
   * somebody, which is the only thing the gate says differently.
   */
  const consoleEverLoaded = useRef(false);
  /**
   * Staged references restored from storage at first render.
   *
   * Read once, because a reference staged later in this session cannot have
   * expired yet and re-checking it on every render would be a request per
   * keystroke.
   */
  const restoredReferences = useRef({
    speak:
      workspace.speakDraft.voice.kind === 'staged'
        ? workspace.speakDraft.voice.reference?.referenceId ?? null
        : null,
    creation: workspace.creationDraft.reference?.referenceId ?? null,
  });

  // One owner for everything audible, so a second source can never join the
  // first. Held in a ref rather than a memo because it owns an AudioContext.
  const ownerRef = useRef<PlaybackOwner | null>(null);
  if (ownerRef.current === null) ownerRef.current = new PlaybackOwner(props.audio);
  const audio = ownerRef.current;

  useEffect(() => {
    unwrittenWorkspace.current = workspace;
    const timer = setTimeout(() => {
      unwrittenWorkspace.current = null;
      saveWorkspaceState(props.storage, workspace);
    }, PERSIST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [props.storage, workspace]);

  useEffect(() => {
    const flush = (): void => {
      const pending = unwrittenWorkspace.current;
      if (!pending) return;
      unwrittenWorkspace.current = null;
      saveWorkspaceState(props.storage, pending);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      // Declared after the coalescing effect, so on teardown this runs once its
      // timer has already been cleared: a delayed write is never lost work.
      flush();
    };
  }, [props.storage]);

  /** Drop the held request and whatever timer was going to send it. */
  const clearHeldRetry = useCallback((): void => {
    if (retryTimer.current !== null) {
      scheduler.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    heldRequest.current = null;
  }, [scheduler]);

  // One handler for an expiry that can land on any of two dozen calls. Raising
  // the gate here rather than at each call site is what keeps a console from
  // rendering against a gateway that refuses everything.
  useEffect(
    () =>
      client.onAuthRequired(() => {
        setGated(true);
        setGateInUse(true);
        setInterrupted(consoleEverLoaded.current);
        // A stream cut off by an expiry is a partial clip, and leaving it
        // sounding behind the gate would present it as a whole one.
        void audio.stop();
        clearHeldRetry();
        setSharedWait(null);
      }),
    [audio, clearHeldRetry, client],
  );

  // Nothing retries in the background once this component is gone.
  useEffect(() => () => clearHeldRetry(), [clearHeldRetry]);

  // The undo window belongs to the deleter's client, so it has to close there
  // too: a strip that outlives its 30 seconds offers a restore the gateway has
  // already purged.
  useEffect(() => {
    if (!pendingUndo) return undefined;
    const timer = scheduler.setTimeout(
      () => setPendingUndo(null),
      Math.max(0, pendingUndo.expiresAt - Date.now()),
    );
    return () => scheduler.clearTimeout(timer);
  }, [pendingUndo, scheduler]);

  const setCreation = useCallback((creationDraft: VoiceCreationDraft): void => {
    setWorkspace((current) => ({ ...current, creationDraft }));
  }, []);

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
      consoleEverLoaded.current = true;
    } catch {
      setHealth(null);
    }
  }, [client]);

  /**
   * Pay the cold start now, at the viewer's request.
   *
   * Guarded on `waking` rather than debounced by time: a second press while the
   * first wake is in flight would start nothing new upstream but would reset
   * the elapsed timer, which reads as the wait restarting.
   *
   * The failure is deliberately quiet in the masthead. A wake is a
   * convenience, not work the viewer composed, so a refused one leaves the
   * badge saying what it already said rather than putting an error where a
   * status belongs. A real problem resurfaces the moment they generate.
   */
  const warmUp = useCallback(async (): Promise<void> => {
    if (wakingRef.current) return;
    wakingRef.current = true;
    setWaking(true);
    setWakeElapsedMs(0);
    try {
      const { readiness } = await client.wake();
      setHealth((current) => (current ? { ...current, readiness } : current));
    } catch {
      // Swallowed on purpose; see above.
    } finally {
      wakingRef.current = false;
      setWaking(false);
      await refreshHealth();
    }
  }, [client, refreshHealth]);

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
    // Nothing behind the gate loads while the gate is up. The console is not
    // rendered, so this is belt and braces — but it is what makes "no request
    // is made while the password field is on screen" a property of the shell
    // rather than of where a component happens to sit in the tree.
    if (gated) return;
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
    if (scriptsAvailable) {
      void trackActivity('Loading scripts…', async () => {
        const next = await refreshSummaries();
        const wanted = initialLastScriptId.current;
        if (wanted && next.some((summary) => summary.id === wanted)) {
          await openScript(wanted);
        }
      });
    }
  }, [
    client,
    gated,
    openScript,
    refreshClips,
    refreshHealth,
    refreshSummaries,
    refreshVoices,
    scriptsAvailable,
    sessionEpoch,
    trackActivity,
  ]);

  /**
   * Check a restored staged reference once, before anything needs it.
   *
   * Staged audio expires by age on the gateway while a restored draft can
   * outlive it by any amount of time, and nothing pushes that expiry to the
   * browser. Without this the first news of it is a refused Audition or
   * Generate, after the operator has already written the line they meant to say
   * in that voice.
   *
   * Nothing in the draft is discarded, including the selection whose audio is
   * gone: its window and its hand-corrected transcript are work this browser
   * cannot get back, and re-staging the same recording would only re-offer the
   * machine transcript the operator already fixed. The point-of-use refusal
   * stays as the backstop; this only moves the news earlier.
   */
  useEffect(() => {
    if (gated) return;
    const restored = restoredReferences.current;
    if (!restored.speak && !restored.creation) return;
    // Asked once. A reference staged later in this session cannot have expired.
    restoredReferences.current = { speak: null, creation: null };
    void trackActivity('Checking prepared reference…', async () => {
      let unanswered = false;
      const alive = async (id: string): Promise<boolean> => {
        try {
          return await client.referenceExists(id);
        } catch {
          // A refused or unreachable check is not an absence, and reporting one
          // as an expiry would send the operator to re-record working audio.
          unanswered = true;
          return true;
        }
      };
      if (restored.creation && !(await alive(restored.creation))) {
        setVoiceFailure({
          message: 'The recording behind this reference has expired on the gateway.',
          remedy:
            'Upload or record it again before auditioning — your transcript and everything else here stay as they are.',
        });
      }
      if (restored.speak && !(await alive(restored.speak))) {
        setSpeakFailure({
          message: 'The recording behind this temporary reference has expired on the gateway.',
          remedy:
            'Upload or record it again before generating — your line and delivery stay as they are.',
        });
      }
      // A check the gate refused answered nothing. Putting the question back
      // means it is asked once more after re-entry, rather than the expiry
      // going unnoticed because it happened to be asked at the wrong moment.
      if (unanswered) restoredReferences.current = restored;
    });
  }, [client, gated, trackActivity]);

  useEffect(() => {
    if (!waking) return undefined;
    const startedAt = Date.now();
    const timer = setInterval(() => setWakeElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(timer);
  }, [waking]);

  const setActive = (active: Workspace): void =>
    setWorkspace((current) => ({
      ...current,
      active: workspaceAvailability[active] ? active : 'speak',
    }));

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

  const availableSpeakVoice = resolveAvailableSpeakVoiceSource(
    workspace.speakDraft.voice,
    voices,
    workspace.selectedVoiceId,
    speakVoiceSourceAvailability,
  );
  const availableSpeakDraft: SpeakDraft =
    availableSpeakVoice === workspace.speakDraft.voice
      ? workspace.speakDraft
      : { ...workspace.speakDraft, voice: availableSpeakVoice };
  const effectiveSpeakDraft: SpeakDraft =
    availableSpeakDraft.voice.kind === 'staged' && availableSpeakDraft.voice.reference
      ? {
          ...availableSpeakDraft,
          voice: {
            kind: 'staged',
            reference: moveReferenceWindow(
              availableSpeakDraft.voice.reference,
              availableSpeakDraft.voice.reference.start,
              speakCeiling.maxSeconds,
            ),
          },
        }
      : availableSpeakDraft;
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
  const selectedReferenceDuration =
    resolution.spec?.kind === 'referenced'
      ? resolution.spec.reference.source === 'voice'
        ? resolution.spec.reference.durationSeconds
        : resolution.spec.reference.end - resolution.spec.reference.start
      : effectiveSpeakDraft.voice.kind === 'staged' && effectiveSpeakDraft.voice.reference
        ? effectiveSpeakDraft.voice.reference.end - effectiveSpeakDraft.voice.reference.start
        : undefined;
  const selectionBlocker =
    effectiveSpeakDraft.voice.kind === 'staged' && effectiveSpeakDraft.voice.reference
      ? referenceSelectionBlocker(
          effectiveSpeakDraft.voice.reference,
          speakCeiling.maxSeconds,
          tokenCeilingFor('clone', effectiveSpeakDraft.cfgScale),
        )
      : null;
  /**
   * Somebody else has the vendor's lock and this viewer's request is held.
   *
   * Suppressed while a retry is actually in flight, so the control says
   * "Generating…" for the moment it is, rather than describing a wait that has
   * momentarily stopped being one.
   */
  const sharedWaitReason =
    sharedWait && !sharedWait.exhausted && !generating
      ? `Someone else is generating. Your request is held — try ${sharedWait.attempt} of ${sharedWait.attempts}.`
      : null;
  const blockedReason = sharedWaitReason ?? generateBlockedReason({
    draft: effectiveSpeakDraft,
    gatewayReachable: health !== null,
    busy: false,
    generating,
    modeBlocker: resolution.blocker ?? selectionBlocker,
    cfgScale: effectiveSpeakDraft.cfgScale,
    cfgAdjustable: false,
    mode: requestMode,
    ...(selectedTranscript ? { refText: selectedTranscript } : {}),
    ...(selectedReferenceDuration === undefined
      ? {}
      : { refDurationSeconds: selectedReferenceDuration }),
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

  /**
   * Send one synthesis request, counted.
   *
   * Every path that can hold the vendor's process-wide lock goes through here,
   * because the count is the only evidence a 409 is this viewer's own doing —
   * an audition started in Voices and a line generated in Speak contend with
   * each other exactly as two people would.
   *
   * @param request - The composed request.
   * @returns The upstream response, streaming.
   */
  const sendSpeech = async (request: SpeechRequest): Promise<Response> => {
    synthesisInFlight.current += 1;
    try {
      return await client.speech(request);
    } finally {
      synthesisInFlight.current -= 1;
    }
  };

  const playResponse = async (
    response: Response,
    startedAt: number,
  ): Promise<PlaybackResult> => {
    const result = await audio.play(response, startedAt, {
      onFirstAudio: () => setWaking(false),
    });
    setPlayback(result);
    setSelectedClipId(result.clipId);
    return result;
  };

  /**
   * Send one composed request and say what stopped it, if anything did.
   *
   * @param request - Exactly what will be sent, already projected. A retry
   *   re-sends this object rather than recomposing from the draft, so a request
   *   held while the viewer keeps typing is still the request they pressed for.
   * @returns Whether the demo was busy with somebody else's generation, which
   *   is the one failure this shell answers by waiting rather than by reporting.
   */
  const attemptGeneration = async (
    request: ProjectedSpeechRequest,
  ): Promise<'done' | 'contended'> => {
    let contended = false;
    await trackActivity('Generating speech…', async () => {
      setSpeakFailure(null);
      setPlayback(null);
      setGenerating(true);
      const cold = shouldShowWake(health?.readiness ?? 'unknown');
      setWaking(cold);
      setWakeElapsedMs(0);
      const startedAt = performance.now();
      try {
        const result = await playResponse(await sendSpeech(request), startedAt);
        if (result.incomplete) setSpeakFailure(incompleteStreamFailure(result, false));
      } catch (error) {
        const failure = error instanceof ApiError ? error.failure : null;
        // This request has already left the count, so anything still in it is
        // an audition or a script run of this viewer's own — the
        // single-operator case, which keeps the wording the local demo has
        // always shown. A count of nothing means the lock is somebody else's.
        if (failure?.type === 'busy' && synthesisInFlight.current === 0) {
          contended = true;
        } else {
          setSpeakFailure(failureFrom(error, 'Speech could not be generated.'));
        }
      } finally {
        setGenerating(false);
        setWaking(false);
        await Promise.all([refreshHealth(), refreshClips()]);
      }
    });
    return contended ? 'contended' : 'done';
  };

  /**
   * Run one held request to a conclusion, waiting out someone else's turn.
   *
   * @param request - The composed request, unchanged between attempts.
   * @param retry - How many retries have already been spent.
   */
  const driveGeneration = async (
    request: ProjectedSpeechRequest,
    retry: number,
  ): Promise<void> => {
    const epoch = waitEpoch.current;
    const outcome = await attemptGeneration(request);
    // Cancelled, or superseded by a fresh press, while this attempt was open.
    if (waitEpoch.current !== epoch) return;
    if (outcome === 'done') {
      // A retry that succeeds is indistinguishable from a first press, because
      // it is one.
      clearHeldRetry();
      setSharedWait(null);
      return;
    }
    const attempts = CONTENDED_RETRY_DELAYS_MS.length;
    const delay = CONTENDED_RETRY_DELAYS_MS[retry];
    if (delay === undefined) {
      // Say so and stop. The composed request stays on screen, so a second
      // press costs nothing but the press.
      clearHeldRetry();
      setSharedWait({ attempt: attempts, attempts, exhausted: true });
      return;
    }
    heldRequest.current = request;
    setSharedWait({ attempt: retry + 1, attempts, exhausted: false });
    retryTimer.current = scheduler.setTimeout(() => {
      retryTimer.current = null;
      const held = heldRequest.current;
      // Cancelled, or the shell went away. Either way nothing is owed.
      if (!held) return;
      void driveGeneration(held, retry + 1);
    }, delay);
  };

  const generate = (): void => {
    if (!resolution.spec) return;
    clearHeldRetry();
    waitEpoch.current += 1;
    setSharedWait(null);
    void driveGeneration(projectSpeechRequest(effectiveSpeakDraft, resolution.spec), 0);
  };

  /** Stop waiting. The line, the voice and the delivery are untouched. */
  const cancelSharedWait = (): void => {
    clearHeldRetry();
    waitEpoch.current += 1;
    setSharedWait(null);
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
        const result = await playResponse(await sendSpeech(request), startedAt);
        if (result.incomplete) {
          setVoiceFailure(incompleteStreamFailure(result));
          return;
        }
        if (!result.clipId) throw new Error('The audition completed without a reusable clip.');
        setWorkspace((current) => ({
          ...current,
          creationDraft: { ...current.creationDraft, auditionClipId: result.clipId },
        }));
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
      setCreation(INITIAL_CREATION_DRAFT);
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
    setLibraryNotice(null);
    try {
      await trackActivity('Deleting voice…', async () => client.deleteVoice(voice.id));
    } catch (error) {
      // Another viewer got there first. The intent was satisfied, so the entry
      // stays gone; the only correction is to withdraw an undo whose window
      // belongs to whoever actually deleted it, and which would fail here.
      if (error instanceof ApiError && error.failure.type === 'not-found') {
        setPendingUndo(null);
        setLibraryNotice(`“${voice.name}” was already removed by someone else.`);
        return;
      }
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
    const scriptId = script.id;
    runRevision.current += 1;
    const revision = runRevision.current;
    // Cue edits made from here on outrank whatever the queue reports for those
    // rows: the operator changed the line, so the row is stale regardless of
    // what the run was doing with the text it replaced.
    const revisionsAtStart = new Map(cueRevisions.current);
    setRunning(true);
    setScriptFailure(null);
    // A run holds the vendor's lock for as many requests as it has stale cues,
    // so it counts for the same reason an audition does: a 409 in Speak during
    // one of them is this viewer's own doing, not another visitor's.
    synthesisInFlight.current += 1;
    try {
      await trackActivity('Running stale script cues…', async () => {
        // The gateway already sends each transition. Reading it is one render
        // per cue instead of one whole-document fetch per cue, and the stream's
        // own order is the only order there is — the refetches it replaces
        // could resolve out of order and paint a row's previous state back on.
        await client.runScript(scriptId, (progress) => {
          if (runRevision.current !== revision) return;
          if (
            (cueRevisions.current.get(progress.cueId) ?? 0) !==
            (revisionsAtStart.get(progress.cueId) ?? 0)
          ) {
            return;
          }
          setScript((current) => applyRunProgress(current, progress));
        });
        // One refresh, for what the stream cannot carry: actual duration and
        // the drift derived from it, both of which only the cache knows.
        const finished = await client.script(scriptId);
        if (runRevision.current === revision) setScript(finished);
        await Promise.all([refreshSummaries(), refreshClips()]);
      });
    } catch (error) {
      setScriptFailure(failureFrom(error, 'The script run could not be completed.'));
    } finally {
      synthesisInFlight.current -= 1;
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
        anchor.rel = 'noopener';
        // Firefox dispatches a click only on an anchor that is in the document,
        // and reads the object URL after the handler returns. Both halves of
        // the previous version — detached anchor, synchronous revoke — are
        // Chrome tolerating what the standard does not promise.
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), EXPORT_URL_LIFETIME_MS);
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
          : resolveAvailableSpeakVoiceSource(
              { kind: 'described' },
              voices,
              current.selectedVoiceId,
              speakVoiceSourceAvailability,
            ),
      },
    }));
  };

  const replayClip = async (clip: Clip): Promise<void> => {
    setSpeakFailure(null);
    try {
      await trackActivity('Loading replay…', () =>
        audio.playCached(client.clipUrl(clip.id)),
      );
    } catch (error) {
      setSpeakFailure(failureFrom(error, 'The cached clip could not be replayed.'));
    }
  };

  /**
   * Try one password and, on success, resume exactly where the viewer was.
   *
   * Nothing is reset: the workspace they were in, the line they were writing
   * and the voice they had chosen all live in this component's state, which the
   * gate never unmounted.
   *
   * @param password - Exactly what was typed.
   * @returns The outcome, for the gate to say in place.
   */
  const enterWithPassword = async (password: string): Promise<SessionOutcome> => {
    const outcome = await client.createSession(password);
    if (outcome.ok) {
      setGated(false);
      setSessionEpoch((epoch) => epoch + 1);
    }
    return outcome;
  };

  const signOut = async (): Promise<void> => {
    clearHeldRetry();
    setSharedWait(null);
    await audio.stop();
    await client.endSession();
    setGated(true);
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

  // Everything above ran, so the console's state is intact behind this. The
  // gate replaces the view, never the shell.
  if (gated) {
    return <AccessGate onSubmit={enterWithPassword} returning={interrupted} />;
  }

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
          <WarmUpButton
            readiness={health?.readiness ?? 'unknown'}
            waking={waking}
            onWarmUp={() => void warmUp()}
          />
          {/* Only where a gate exists to sign out of, which the local demo
              never learns about because nothing there ever refuses a call. */}
          {gateInUse && (
            <button type="button" className="chip" onClick={() => void signOut()}>
              Sign out
            </button>
          )}
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
            libraryNotice={libraryNotice}
            onReleaseReference={(id) => client.deleteReference(id)}
            scriptsAvailable={scriptsAvailable}
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
            blockedReason={blockedReason}
            statusLine={speakStatus}
            onGenerate={generate}
            generating={generating}
            sharedWait={sharedWait}
            onCancelSharedWait={cancelSharedWait}
            onReleaseReference={(id) => client.deleteReference(id)}
            clips={clips}
            selectedClipId={selectedClipId}
            onSelectClip={(clip) => setSelectedClipId(clip.id)}
            onReplay={(clip) => {
              void replayClip(clip);
            }}
            onLoadVariation={loadVariation}
            onCreateVoiceFromClip={(clip) => {
              setCreation({
                ...INITIAL_CREATION_DRAFT,
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
            sourceAvailability={speakVoiceSourceAvailability}
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

        {scriptsAvailable && workspace.active === 'scripts' && (
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
