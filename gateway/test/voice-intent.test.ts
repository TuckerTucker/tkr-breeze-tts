/** Voice intent chooses request shape from reference presence, never a UI mode. */

import { describe, expect, it } from 'vitest';

import { GatewayError } from '../src/proxy.js';
import {
  resolveVoiceIntent,
  type ReferenceProvenance,
  type VoiceIntent,
} from '../src/voice-intent.js';

const AUDIO = Buffer.from([1, 2, 3, 4]);

describe('voice-intent resolution', () => {
  it.each([
    { cfgScale: 1, template: 'tts_instruction', batch: 1, ceiling: 256 },
    { cfgScale: 4, template: 'tts_instruction', batch: 2, ceiling: 512 },
  ] as const)(
    'derives a described template at CFG $cfgScale',
    ({ cfgScale, template, batch, ceiling }) => {
      const result = resolveVoiceIntent({
        text: '  Keep this line intact.  ',
        instruction: '  Warm and direct.  ',
        cfgScale,
        seed: 42,
      });

      expect(result).toMatchObject({
        template,
        derivedMode: 'design',
        segments: 1,
        batch,
        tokenCeiling: ceiling,
        legacyMismatch: false,
      });
      expect(result.reference).toBeUndefined();
      expect(result.text).toBe('  Keep this line intact.  ');
      expect(result.instruction).toBe('  Warm and direct.  ');
    },
  );

  it.each([
    { provenance: { kind: 'voice', id: 'voice-1' } },
    { provenance: { kind: 'staged', id: 'ref-1', start: 1, end: 5 } },
    { provenance: { kind: 'upload', filename: 'speaker.wav' } },
  ] as readonly { provenance: ReferenceProvenance }[])(
    'derives a referenced template for $provenance.kind provenance',
    ({ provenance }) => {
      const result = resolveVoiceIntent({
        text: 'A line.',
        instruction: 'Deliver it quietly.',
        cfgScale: 1,
        seed: 7,
        reference: { audio: AUDIO, transcript: 'Reference words.', provenance },
      });

      expect(result).toMatchObject({
        template: 'ref_edit_tata',
        derivedMode: 'clone',
        segments: 2,
        batch: 2,
        tokenCeiling: 256,
        reference: { provenance },
      });
    },
  );

  it('moves a referenced request to batch four above CFG 1.0', () => {
    expect(resolveVoiceIntent({
      text: 'A line.',
      instruction: 'Deliver it quietly.',
      cfgScale: 4,
      seed: 7,
      reference: {
        audio: AUDIO,
        transcript: 'Reference words.',
        provenance: { kind: 'voice', id: 'voice-1' },
      },
    })).toMatchObject({ batch: 4, tokenCeiling: 512, segments: 2 });
  });

  it.each([
    {
      legacyMode: 'clone' as const,
      reference: undefined,
      derivedMode: 'design',
    },
    {
      legacyMode: 'design' as const,
      reference: {
        audio: AUDIO,
        transcript: 'Exact words.',
        provenance: { kind: 'voice' as const, id: 'voice-1' },
      },
      derivedMode: 'clone',
    },
  ])('reports but cannot obey a contradictory $legacyMode mode', (testCase) => {
    const result = resolveVoiceIntent({
      text: 'A line.',
      instruction: 'Natural.',
      cfgScale: 1,
      seed: 42,
      legacyMode: testCase.legacyMode,
      ...(testCase.reference ? { reference: testCase.reference } : {}),
    });

    expect(result.legacyMismatch).toBe(true);
    expect(result.derivedMode).toBe(testCase.derivedMode);
  });
});

describe('invalid voice intent', () => {
  it.each([
    {
      name: 'missing audio',
      reference: {
        audio: undefined,
        transcript: 'Exact words.',
        provenance: { kind: 'upload', filename: 'speaker.wav' },
      },
      message: /contains no audio/i,
    },
    {
      name: 'missing transcript',
      reference: {
        audio: AUDIO,
        transcript: '   ',
        provenance: { kind: 'upload', filename: 'speaker.wav' },
      },
      message: /without its exact transcript/i,
    },
  ])('refuses a reference with $name as a typed failure', ({ reference, message }) => {
    const intent = {
      text: 'A line.',
      instruction: 'Natural.',
      cfgScale: 1,
      seed: 42,
      reference,
    } as unknown as VoiceIntent;

    expect(() => resolveVoiceIntent(intent)).toThrowError(message);
    try {
      resolveVoiceIntent(intent);
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).type).toBe('validation');
    }
  });

  it('refuses the largest overflowing text segment locally', () => {
    expect(() => resolveVoiceIntent({
      text: 'word '.repeat(300),
      instruction: 'Natural.',
      cfgScale: 1,
      seed: 42,
    })).toThrowError(/token ceiling/i);
  });
});
