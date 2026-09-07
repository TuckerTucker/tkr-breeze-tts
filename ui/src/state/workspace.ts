/**
 * Voice intent and persistent task-workspace state.
 *
 * The discriminated union makes a described request and a complete referenced
 * request the only representable synthesis shapes. Navigation and persistence
 * live here so view components never own competing versions of the same draft.
 *
 * @module
 */

import {
  INITIAL_DRAFT,
  loadDraft,
  type Draft,
  type DraftStorage,
} from './draft.js';
import type { StagedReferenceSelection, TimedWord } from './reference.js';
import type { Voice } from './voices.js';

/** All functional destinations implemented by the application. */
export type Workspace = 'voices' | 'speak' | 'scripts';

/**
 * Workspace availability is centralized so dormant tools have no stray UI or
 * background work while their implementation and persisted data remain intact.
 */
export const WORKSPACE_AVAILABILITY: Readonly<Record<Workspace, boolean>> = {
  voices: true,
  speak: true,
  scripts: false,
};

/** Voice choice retained in the Speak draft. */
export type SpeakVoiceSource =
  | { readonly kind: 'described' }
  | { readonly kind: 'saved'; readonly voiceId: string; readonly voiceName: string }
  | { readonly kind: 'staged'; readonly reference: StagedReferenceSelection | null };

/** Availability for the implemented Speak voice-source capabilities. */
export type SpeakVoiceSourceAvailability = Readonly<
  Record<SpeakVoiceSource['kind'], boolean>
>;

/** Speak currently focuses exclusively on voices kept in the local library. */
export const SPEAK_VOICE_SOURCE_AVAILABILITY: SpeakVoiceSourceAvailability = {
  described: false,
  saved: true,
  staged: false,
};

/** A complete voice reference after library or staged-source resolution. */
export type VoiceReference =
  | {
      readonly source: 'voice';
      readonly voiceId: string;
      readonly name: string;
      readonly transcript: string;
      readonly durationSeconds: number;
    }
  | {
      readonly source: 'staged';
      readonly referenceId: string;
      readonly name: string;
      readonly start: number;
      readonly end: number;
      readonly transcript: string;
    };

/** Exactly two synthesis intents: described, or referenced and complete. */
export type VoiceSpec =
  | { readonly kind: 'described'; readonly instruction: string }
  | {
      readonly kind: 'referenced';
      readonly reference: VoiceReference;
      readonly instruction: string;
    };

/** The one-off tool's persisted draft. */
export interface SpeakDraft extends Draft {
  readonly cfgScale: number;
  readonly voice: SpeakVoiceSource;
}

/** Local creation language inside Voices, never an application mode. */
export type VoiceCreationMethod = 'describe' | 'clone-audio' | 'from-clip';

/**
 * Draft retained while the operator navigates to another tool.
 *
 * Declared here rather than in the view that renders it: it is persisted,
 * restored field by field, and survives a reload and a session expiry, none of
 * which a component owns. State importing its own shape from a component was
 * the arrow pointing the wrong way, and it is now gone.
 */
export interface VoiceCreationDraft {
  readonly method: VoiceCreationMethod;
  readonly name: string;
  readonly description: string;
  readonly sampleText: string;
  readonly cfgScale: number;
  readonly seed: number;
  readonly reference: StagedReferenceSelection | null;
  readonly sourceClipId: string | null;
  readonly auditionClipId: string | null;
}

/**
 * Starting voice-creation values.
 *
 * The single copy. The Voices workspace re-exports this under its historic name
 * rather than restating the values, so the persisted draft and the one the view
 * renders cannot drift apart.
 */
export const INITIAL_CREATION_DRAFT: VoiceCreationDraft = {
  method: 'describe',
  name: 'Untitled voice',
  description: 'A warm, clear narrator with an unhurried pace.',
  sampleText: 'This is how this voice will sound when you use it.',
  cfgScale: 4,
  seed: 42,
  reference: null,
  sourceClipId: null,
  auditionClipId: null,
};

/**
 * Durable shell state restored across navigation and reload.
 *
 * The creation draft lives here rather than in component state because it is
 * the most expensive thing the operator can be holding — a staged reference, a
 * corrected transcript, and a name they chose — and losing it to a reload is
 * the one outcome this application is not allowed to produce.
 */
export interface WorkspaceState {
  readonly version: 2;
  readonly active: Workspace;
  readonly selectedVoiceId: string | null;
  readonly speakDraft: SpeakDraft;
  readonly creationDraft: VoiceCreationDraft;
  readonly lastScriptId: string | null;
}

/** Starting state for a first visit. */
export const INITIAL_WORKSPACE_STATE: WorkspaceState = {
  version: 2,
  active: 'speak',
  selectedVoiceId: null,
  speakDraft: {
    ...INITIAL_DRAFT,
    cfgScale: 1,
    voice: { kind: 'described' },
  },
  creationDraft: INITIAL_CREATION_DRAFT,
  lastScriptId: null,
};

const STORAGE_KEY = 'breeze.workspace.v2';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function activeWorkspace(value: unknown): Workspace {
  if (value !== 'voices' && value !== 'scripts') return 'speak';
  return WORKSPACE_AVAILABILITY[value] ? value : 'speak';
}

/**
 * Rebuild a staged selection from storage, or refuse it whole.
 *
 * A selection only means anything with its window, its transcript and the
 * waveform the trimmer draws against, so a partial one is dropped rather than
 * repaired into something the operator would have to notice and correct.
 */
function safeStagedReference(value: unknown): StagedReferenceSelection | null {
  if (!isRecord(value)) return null;
  const {
    referenceId,
    name,
    durationSeconds,
    sampleRate,
    peaks,
    words,
    language,
    start,
    end,
    transcript,
    transcriptEdited,
  } = value;
  if (
    typeof referenceId !== 'string' ||
    typeof name !== 'string' ||
    typeof transcript !== 'string' ||
    typeof durationSeconds !== 'number' ||
    typeof sampleRate !== 'number' ||
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Array.isArray(peaks) ||
    !Array.isArray(words)
  ) {
    return null;
  }
  return {
    referenceId,
    name,
    durationSeconds,
    sampleRate,
    peaks: peaks as readonly number[],
    words: words as readonly TimedWord[],
    language: typeof language === 'string' ? language : null,
    start,
    end,
    transcript,
    // An operator's correction outranks the recognised text it replaced.
    // Dropping the flag would quietly re-offer the transcript they just fixed.
    transcriptEdited: transcriptEdited === true,
  };
}

function safeSource(value: unknown): SpeakVoiceSource {
  if (!isRecord(value)) return { kind: 'described' };
  if (
    value.kind === 'saved' &&
    typeof value.voiceId === 'string' &&
    typeof value.voiceName === 'string'
  ) {
    return { kind: 'saved', voiceId: value.voiceId, voiceName: value.voiceName };
  }
  if (value.kind === 'staged') {
    return { kind: 'staged', reference: safeStagedReference(value.reference) };
  }
  return { kind: 'described' };
}

const CREATION_METHODS: readonly VoiceCreationMethod[] = [
  'describe',
  'clone-audio',
  'from-clip',
];

/**
 * Restore the creation draft field by field, matching the Speak draft's rule.
 *
 * One unreadable value resets only itself: a corrupt seed must not be able to
 * take a staged reference and a typed name down with it.
 */
function safeCreationDraft(value: unknown): VoiceCreationDraft {
  const candidate = isRecord(value) ? value : {};
  const initial = INITIAL_CREATION_DRAFT;
  return {
    method: CREATION_METHODS.includes(candidate.method as VoiceCreationMethod)
      ? (candidate.method as VoiceCreationMethod)
      : initial.method,
    name: typeof candidate.name === 'string' ? candidate.name : initial.name,
    description:
      typeof candidate.description === 'string' ? candidate.description : initial.description,
    sampleText:
      typeof candidate.sampleText === 'string' ? candidate.sampleText : initial.sampleText,
    cfgScale:
      typeof candidate.cfgScale === 'number' &&
      Number.isFinite(candidate.cfgScale) &&
      candidate.cfgScale > 0
        ? candidate.cfgScale
        : initial.cfgScale,
    seed:
      typeof candidate.seed === 'number' && Number.isInteger(candidate.seed)
        ? candidate.seed
        : initial.seed,
    reference: safeStagedReference(candidate.reference),
    sourceClipId:
      typeof candidate.sourceClipId === 'string' ? candidate.sourceClipId : null,
    auditionClipId:
      typeof candidate.auditionClipId === 'string' ? candidate.auditionClipId : null,
  };
}

/**
 * Resolve a persisted source into one offered by the current Speak surface.
 *
 * @param source - Persisted source, which may belong to a dormant capability.
 * @param voices - Current saved-voice library.
 * @param selectedVoiceId - Last library selection shared by the app shell.
 * @param availability - Voice-source capabilities offered by this app surface.
 * @returns The retained source or a sensible saved-voice fallback.
 */
export function resolveAvailableSpeakVoiceSource(
  source: SpeakVoiceSource,
  voices: readonly Voice[],
  selectedVoiceId: string | null,
  availability: SpeakVoiceSourceAvailability,
): SpeakVoiceSource {
  if (availability[source.kind]) {
    if (source.kind !== 'saved' || source.voiceId) return source;
    if (!voices.some((voice) => voice.available)) return source;
  }

  const preferred =
    voices.find((voice) => voice.available && voice.id === selectedVoiceId) ??
    voices.find((voice) => voice.available);
  return preferred
    ? { kind: 'saved', voiceId: preferred.id, voiceName: preferred.name }
    : { kind: 'saved', voiceId: '', voiceName: 'No saved voice selected' };
}

function safeSpeakDraft(value: unknown, legacy: Draft): SpeakDraft {
  const candidate = isRecord(value) ? value : {};
  const language = candidate.language === 'zh' ? 'zh' : legacy.language;
  const seed =
    typeof candidate.seed === 'number' && Number.isInteger(candidate.seed)
      ? candidate.seed
      : legacy.seed;
  const cfgScale =
    typeof candidate.cfgScale === 'number' &&
    Number.isFinite(candidate.cfgScale) &&
    candidate.cfgScale > 0
      ? candidate.cfgScale
      : 1;
  return {
    text: typeof candidate.text === 'string' ? candidate.text : legacy.text,
    instruction:
      typeof candidate.instruction === 'string'
        ? candidate.instruction
        : legacy.instruction,
    language,
    seed,
    seedLocked:
      typeof candidate.seedLocked === 'boolean'
        ? candidate.seedLocked
        : legacy.seedLocked,
    cfgScale,
    voice: safeSource(candidate.voice),
  };
}

/**
 * Restore versioned workspace state, migrating the original console draft.
 *
 * @param storage - Injected browser-compatible storage.
 * @returns A field-by-field validated state; one corrupt field cannot erase the rest.
 */
export function loadWorkspaceState(storage: DraftStorage): WorkspaceState {
  const legacy = loadDraft(storage);
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        ...INITIAL_WORKSPACE_STATE,
        speakDraft: { ...INITIAL_WORKSPACE_STATE.speakDraft, ...legacy },
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    const candidate = isRecord(parsed) ? parsed : {};
    return {
      version: 2,
      active: activeWorkspace(candidate.active),
      selectedVoiceId:
        typeof candidate.selectedVoiceId === 'string' ? candidate.selectedVoiceId : null,
      speakDraft: safeSpeakDraft(candidate.speakDraft, legacy),
      creationDraft: safeCreationDraft(candidate.creationDraft),
      lastScriptId:
        typeof candidate.lastScriptId === 'string' ? candidate.lastScriptId : null,
    };
  } catch {
    return {
      ...INITIAL_WORKSPACE_STATE,
      speakDraft: { ...INITIAL_WORKSPACE_STATE.speakDraft, ...legacy },
    };
  }
}

/**
 * Persist the normalized workspace without changing operator-authored text.
 *
 * @param storage - Injected browser-compatible storage.
 * @param state - Current canonical workspace state.
 */
export function saveWorkspaceState(
  storage: DraftStorage,
  state: WorkspaceState,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Disabled or full storage must not make the app unusable.
  }
}

/** A voice-spec resolution plus an actionable preflight reason. */
export interface VoiceSpecResolution {
  readonly spec: VoiceSpec | null;
  readonly blocker: string | null;
}

/**
 * Resolve a Speak source into one complete voice intent.
 *
 * @param draft - Persisted one-off speech draft.
 * @param voices - Current durable library.
 * @returns A valid spec, or a contextual replacement/transcript blocker.
 */
export function resolveVoiceSpec(
  draft: SpeakDraft,
  voices: readonly Voice[],
): VoiceSpecResolution {
  const instruction = draft.instruction;
  if (!instruction.trim()) {
    return { spec: null, blocker: 'Describe how the line should sound.' };
  }
  if (draft.voice.kind === 'described') {
    return { spec: { kind: 'described', instruction }, blocker: null };
  }
  if (draft.voice.kind === 'saved') {
    const source = draft.voice;
    if (!source.voiceId) {
      return { spec: null, blocker: 'Choose a saved voice.' };
    }
    const voice = voices.find((candidate) => candidate.id === source.voiceId);
    if (!voice || !voice.available) {
      return {
        spec: null,
        blocker: `“${source.voiceName}” is unavailable. Choose another voice.`,
      };
    }
    if (!voice.transcript.trim()) {
      return {
        spec: null,
        blocker: `“${voice.name}” has no usable reference transcript.`,
      };
    }
    return {
      spec: {
        kind: 'referenced',
        instruction,
        reference: {
          source: 'voice',
          voiceId: voice.id,
          name: voice.name,
          transcript: voice.transcript,
          durationSeconds: voice.durationSeconds,
        },
      },
      blocker: null,
    };
  }

  const reference = draft.voice.reference;
  if (!reference) {
    return { spec: null, blocker: 'Upload or record a temporary reference.' };
  }
  if (!reference.transcript.trim()) {
    return {
      spec: null,
      blocker: 'Add the exact transcript of the selected reference audio.',
    };
  }
  return {
    spec: {
      kind: 'referenced',
      instruction,
      reference: {
        source: 'staged',
        referenceId: reference.referenceId,
        name: reference.name,
        start: reference.start,
        end: reference.end,
        transcript: reference.transcript,
      },
    },
    blocker: null,
  };
}

/** Request body projected from the visible one-instruction UI. */
export interface ProjectedSpeechRequest {
  readonly text: string;
  readonly instruction: string;
  readonly cfgScale: number;
  readonly seed: number;
  readonly voiceId?: string;
  readonly referenceId?: string;
  readonly refStart?: number;
  readonly refEnd?: number;
  readonly refText?: string;
}

/**
 * Project a complete VoiceSpec into the mode-free gateway contract.
 *
 * @param draft - Visible line, instruction, CFG, and seed.
 * @param spec - Complete described or referenced voice intent.
 * @returns The exact request fields; no mode or second instruction exists.
 */
export function projectSpeechRequest(
  draft: Pick<SpeakDraft, 'text' | 'cfgScale' | 'seed'>,
  spec: VoiceSpec,
): ProjectedSpeechRequest {
  const base = {
    text: draft.text,
    instruction: spec.instruction,
    cfgScale: draft.cfgScale,
    seed: draft.seed,
  };
  if (spec.kind === 'described') return base;
  return spec.reference.source === 'voice'
    ? {
        ...base,
        voiceId: spec.reference.voiceId,
        refText: spec.reference.transcript,
      }
    : {
        ...base,
        referenceId: spec.reference.referenceId,
        refStart: spec.reference.start,
        refEnd: spec.reference.end,
        refText: spec.reference.transcript,
      };
}

/**
 * Legacy display mode derived from reference presence only.
 *
 * @param spec - Resolved voice specification.
 * @returns Design for described intent, Clone for the shared reference template.
 */
export function legacyModeFor(spec: VoiceSpec): 'design' | 'clone' {
  return spec.kind === 'described' ? 'design' : 'clone';
}
