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
  DEFAULT_INSTRUCTION,
  INITIAL_DRAFT,
  loadDraft,
  type Draft,
  type DraftStorage,
} from './draft.js';
import type { StagedReferenceSelection } from './reference.js';
import type { Voice } from './voices.js';

/** The three functional destinations in the application. */
export type Workspace = 'voices' | 'speak' | 'scripts';

/** Voice choice retained in the Speak draft. */
export type SpeakVoiceSource =
  | { readonly kind: 'described' }
  | { readonly kind: 'saved'; readonly voiceId: string; readonly voiceName: string }
  | { readonly kind: 'staged'; readonly reference: StagedReferenceSelection | null };

/** A complete voice reference after library or staged-source resolution. */
export type VoiceReference =
  | {
      readonly source: 'voice';
      readonly voiceId: string;
      readonly name: string;
      readonly transcript: string;
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

/** Durable shell state restored across navigation and reload. */
export interface WorkspaceState {
  readonly version: 2;
  readonly active: Workspace;
  readonly selectedVoiceId: string | null;
  readonly speakDraft: SpeakDraft;
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
  lastScriptId: null,
};

const STORAGE_KEY = 'breeze.workspace.v2';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function activeWorkspace(value: unknown): Workspace {
  return value === 'voices' || value === 'scripts' ? value : 'speak';
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
  if (value.kind === 'staged' && value.reference === null) {
    return { kind: 'staged', reference: null };
  }
  if (value.kind === 'staged' && isRecord(value.reference)) {
    const reference = value.reference as unknown as StagedReferenceSelection;
    if (
      typeof reference.referenceId === 'string' &&
      typeof reference.name === 'string' &&
      typeof reference.transcript === 'string' &&
      typeof reference.start === 'number' &&
      typeof reference.end === 'number' &&
      typeof reference.durationSeconds === 'number' &&
      Array.isArray(reference.peaks) &&
      Array.isArray(reference.words)
    ) {
      return { kind: 'staged', reference };
    }
  }
  return { kind: 'described' };
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

/** Ensure an empty migrated instruction receives the neutral initial value only on first creation. */
export function initialInstruction(value: string | undefined): string {
  return value === undefined ? DEFAULT_INSTRUCTION : value;
}
