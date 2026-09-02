/** Pure task-workspace persistence and mode-free voice request projection. */

import { describe, expect, it } from 'vitest';

import {
  INITIAL_WORKSPACE_STATE,
  legacyModeFor,
  loadWorkspaceState,
  projectSpeechRequest,
  resolveAvailableSpeakVoiceSource,
  resolveVoiceSpec,
  saveWorkspaceState,
  SPEAK_VOICE_SOURCE_AVAILABILITY,
  type SpeakDraft,
  type VoiceSpec,
  type WorkspaceState,
} from '../src/state/workspace.js';
import type { Voice } from '../src/state/voices.js';

function storage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

const VOICE: Voice = {
  id: 'voice-1',
  name: 'Kept narrator',
  createdAt: 1,
  transcript: 'Exact reference words.',
  defaultDirection: 'Warm and close.',
  origin: { kind: 'cloned', sourceFilename: 'speaker.wav' },
  durationSeconds: 4,
  sampleRate: 24_000,
  available: true,
};

function draft(overrides: Partial<SpeakDraft> = {}): SpeakDraft {
  return {
    ...INITIAL_WORKSPACE_STATE.speakDraft,
    text: 'Speak this line.',
    instruction: 'Deliver this with care.',
    ...overrides,
  };
}

describe('voice-spec resolution and projection', () => {
  it('moves dormant Speak sources to the preferred saved voice', () => {
    expect(resolveAvailableSpeakVoiceSource(
      { kind: 'described' },
      [VOICE],
      VOICE.id,
      SPEAK_VOICE_SOURCE_AVAILABILITY,
    )).toEqual({
      kind: 'saved',
      voiceId: VOICE.id,
      voiceName: VOICE.name,
    });
  });

  it('requires a saved voice without inventing one for an empty library', () => {
    const source = resolveAvailableSpeakVoiceSource(
      { kind: 'staged', reference: null },
      [],
      null,
      SPEAK_VOICE_SOURCE_AVAILABILITY,
    );

    expect(source).toEqual({
      kind: 'saved',
      voiceId: '',
      voiceName: 'No saved voice selected',
    });
    expect(resolveVoiceSpec(draft({ voice: source }), [])).toEqual({
      spec: null,
      blocker: 'Choose a saved voice.',
    });
  });

  it('projects described intent with exactly one instruction and no mode', () => {
    const current = draft({ voice: { kind: 'described' } });
    const resolution = resolveVoiceSpec(current, []);
    expect(resolution.blocker).toBeNull();

    const request = projectSpeechRequest(current, resolution.spec!);
    expect(request).toEqual({
      text: 'Speak this line.',
      instruction: 'Deliver this with care.',
      cfgScale: 1,
      seed: 42,
    });
    expect(request).not.toHaveProperty('mode');
    expect(legacyModeFor(resolution.spec!)).toBe('design');
  });

  it('resolves a saved voice into one inseparable audio/transcript reference', () => {
    const current = draft({
      voice: { kind: 'saved', voiceId: VOICE.id, voiceName: VOICE.name },
    });
    const resolution = resolveVoiceSpec(current, [VOICE]);
    expect(resolution.spec).toMatchObject({
      kind: 'referenced',
      instruction: 'Deliver this with care.',
      reference: {
        source: 'voice',
        voiceId: 'voice-1',
        transcript: 'Exact reference words.',
      },
    });
    expect(projectSpeechRequest(current, resolution.spec!)).toMatchObject({
      instruction: 'Deliver this with care.',
      voiceId: 'voice-1',
      refText: 'Exact reference words.',
    });
    expect(legacyModeFor(resolution.spec!)).toBe('clone');
  });

  it('blocks an unavailable saved voice while retaining its name', () => {
    const current = draft({
      voice: { kind: 'saved', voiceId: VOICE.id, voiceName: VOICE.name },
    });
    expect(resolveVoiceSpec(current, [{ ...VOICE, available: false }])).toEqual({
      spec: null,
      blocker: '“Kept narrator” is unavailable. Choose another voice.',
    });
  });

  it('cannot resolve a staged reference without its transcript', () => {
    const current = draft({
      voice: {
        kind: 'staged',
        reference: {
          referenceId: 'ref-1',
          name: 'speaker.wav',
          durationSeconds: 4,
          sampleRate: 24_000,
          peaks: [],
          words: [],
          language: 'en',
          start: 0,
          end: 4,
          transcript: '',
          transcriptEdited: false,
        },
      },
    });
    expect(resolveVoiceSpec(current, [])).toMatchObject({
      spec: null,
      blocker: expect.stringMatching(/exact transcript/i),
    });
  });
});

describe('workspace persistence and migration', () => {
  it('round-trips every workspace field', () => {
    const store = storage();
    const state: WorkspaceState = {
      version: 2,
      active: 'voices',
      selectedVoiceId: 'voice-1',
      speakDraft: draft({
        cfgScale: 4,
        seed: 99,
        voice: { kind: 'saved', voiceId: 'voice-1', voiceName: 'Kept narrator' },
      }),
      lastScriptId: 'script-1',
    };

    saveWorkspaceState(store, state);
    expect(loadWorkspaceState(store)).toEqual(state);
  });

  it('restores the dormant Scripts workspace into Speak without losing script state', () => {
    const store = storage({
      'breeze.workspace.v2': JSON.stringify({
        ...INITIAL_WORKSPACE_STATE,
        active: 'scripts',
        lastScriptId: 'script-1',
      }),
    });

    expect(loadWorkspaceState(store)).toMatchObject({
      active: 'speak',
      lastScriptId: 'script-1',
    });
  });

  it('migrates the legacy draft without changing typed text', () => {
    const store = storage({
      'breeze.draft.v1': JSON.stringify({
        text: '  Leave my spacing alone.  ',
        instruction: '  Same instruction.  ',
        language: 'zh',
        seed: 8,
        seedLocked: false,
      }),
    });

    expect(loadWorkspaceState(store).speakDraft).toMatchObject({
      text: '  Leave my spacing alone.  ',
      instruction: '  Same instruction.  ',
      language: 'zh',
      seed: 8,
      seedLocked: false,
    });
  });

  it('falls back corrupt fields independently without dropping valid siblings', () => {
    const store = storage({
      'breeze.workspace.v2': JSON.stringify({
        active: 'voices',
        selectedVoiceId: 17,
        lastScriptId: 'script-valid',
        speakDraft: {
          text: 'This valid text survives.',
          instruction: 42,
          language: 'en',
          seed: 'bad',
          seedLocked: true,
          cfgScale: -1,
          voice: { kind: 'unknown' },
        },
      }),
    });

    expect(loadWorkspaceState(store)).toMatchObject({
      active: 'voices',
      selectedVoiceId: null,
      lastScriptId: 'script-valid',
      speakDraft: {
        text: 'This valid text survives.',
        instruction: INITIAL_WORKSPACE_STATE.speakDraft.instruction,
        seed: INITIAL_WORKSPACE_STATE.speakDraft.seed,
        cfgScale: 1,
        voice: { kind: 'described' },
      },
    });
  });

  it('keeps VoiceSpec exhaustive to the described and referenced shapes', () => {
    const kinds = (spec: VoiceSpec): string => {
      switch (spec.kind) {
        case 'described': return spec.instruction;
        case 'referenced': return spec.reference.transcript;
      }
    };
    expect(kinds({ kind: 'described', instruction: 'Only one.' })).toBe('Only one.');
  });
});
