/** Script defaults, nullable cue exceptions, and selective optimistic staleness. */

import { describe, expect, it } from 'vitest';

import {
  INITIAL_SCRIPT_DEFAULTS,
  applyCuePatch,
  applyScriptDefaults,
  effectiveCueSettings,
  type Cue,
  type Script,
} from '../src/state/script.js';

function cue(id: string, overrides: Cue['overrides']): Cue {
  return {
    id,
    index: id === 'one' ? 0 : 1,
    text: `Line ${id}.`,
    voiceId: null,
    voiceName: null,
    instruction: INITIAL_SCRIPT_DEFAULTS.instruction,
    cfgScale: 1,
    seed: 42,
    overrides,
    targetStart: null,
    targetEnd: null,
    state: 'done',
    clipId: `clip-${id}`,
    actualSeconds: 1,
    driftSeconds: null,
    problem: null,
  };
}

function script(): Script {
  return {
    id: 'script-1',
    name: 'Scene',
    source: 'text',
    defaults: { ...INITIAL_SCRIPT_DEFAULTS },
    cues: [
      cue('one', {
        voiceId: null,
        voiceName: null,
        instruction: null,
        cfgScale: null,
        seed: null,
      }),
      cue('two', {
        voiceId: null,
        voiceName: null,
        instruction: 'Pinned delivery.',
        cfgScale: 4,
        seed: 9,
      }),
    ],
    problems: [],
  };
}

describe('script effective settings', () => {
  it('inherits null fields and gives explicit cue exceptions precedence', () => {
    const current = script();
    expect(effectiveCueSettings(current, current.cues[0]!)).toEqual({
      voiceId: null,
      voiceName: null,
      instruction: INITIAL_SCRIPT_DEFAULTS.instruction,
      cfgScale: 1,
      seed: 42,
    });
    expect(effectiveCueSettings(current, current.cues[1]!)).toMatchObject({
      instruction: 'Pinned delivery.',
      cfgScale: 4,
      seed: 9,
    });
  });

  it('clears an override back to inheritance', () => {
    const current = script();
    const cleared = applyCuePatch(current, 'two', {
      overrides: { instruction: null, cfgScale: null, seed: null },
    });
    expect(effectiveCueSettings(cleared, cleared.cues[1]!)).toMatchObject({
      instruction: INITIAL_SCRIPT_DEFAULTS.instruction,
      cfgScale: 1,
      seed: 42,
    });
  });

  it('marks only the edited cue stale', () => {
    const current = script();
    const edited = applyCuePatch(current, 'one', { text: 'Changed line.' });
    expect(edited.cues[0]).toMatchObject({
      text: 'Changed line.',
      state: 'stale',
      actualSeconds: null,
    });
    expect(edited.cues[1]).toBe(current.cues[1]);
  });

  it('stales only cues whose inherited effective default changes', () => {
    const current = script();
    const updated = applyScriptDefaults(current, {
      instruction: 'New common delivery.',
      cfgScale: 2,
      seed: 100,
    });

    expect(updated.cues[0]).toMatchObject({ state: 'stale', actualSeconds: null });
    expect(updated.cues[1]).toBe(current.cues[1]);
    expect(effectiveCueSettings(updated, updated.cues[1]!)).toMatchObject({
      instruction: 'Pinned delivery.',
      cfgScale: 4,
      seed: 9,
    });
  });
});
