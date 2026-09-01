/**
 * Pure voice-intent resolution shared by one-off and scripted synthesis.
 *
 * Reference presence chooses the vendor template. The legacy UI mode is kept
 * only as migration metadata and cannot override the resolved request shape.
 *
 * @module
 */

import type { VoiceMode } from './cache-index.js';
import { GatewayError } from './proxy.js';
import {
  ceilingRefusal,
  findCeilingBreach,
  textEncoderBatch,
  tokenCeilingFor,
} from './script.js';

/** Where a complete reference came from. */
export type ReferenceProvenance =
  | { readonly kind: 'voice'; readonly id: string }
  | { readonly kind: 'staged'; readonly id: string; readonly start: number; readonly end: number }
  | { readonly kind: 'upload'; readonly filename?: string };

/** Audio and its exact transcript, which can never be resolved independently. */
export interface ResolvedReference {
  readonly audio: Buffer;
  readonly transcript: string;
  readonly provenance: ReferenceProvenance;
}

/** The normalized, source-independent request understood by the gateway. */
export interface VoiceIntent {
  readonly text: string;
  readonly instruction: string;
  readonly cfgScale: number;
  readonly seed: number;
  readonly reference?: ResolvedReference;
  readonly legacyMode?: VoiceMode;
}

/** The request shape and validation facts derived from one voice intent. */
export interface ResolvedVoiceIntent {
  readonly text: string;
  readonly instruction: string;
  readonly cfgScale: number;
  readonly seed: number;
  readonly reference?: ResolvedReference;
  readonly template: 'tts_instruction' | 'ref_edit_tata';
  readonly derivedMode: 'design' | 'clone';
  readonly segments: 1 | 2;
  readonly batch: 1 | 2 | 4;
  readonly tokenCeiling: number;
  readonly legacyMismatch: boolean;
}

/** Injectable resolver boundary shared by HTTP speech and script cues. */
export type VoiceIntentResolver = (intent: VoiceIntent) => ResolvedVoiceIntent;

/**
 * Derive the only valid vendor request shape from normalized voice intent.
 *
 * @param intent - Source-independent speech values and an optional complete reference.
 * @returns The validated template, branch size, limit, and provenance-bearing intent.
 * @throws {GatewayError} When required text, numeric settings, or a reference pair is invalid.
 */
export function resolveVoiceIntent(intent: VoiceIntent): ResolvedVoiceIntent {
  const text = intent.text;
  const instruction = intent.instruction;
  if (!text.trim()) throw new GatewayError('validation', 'there is nothing to speak');
  if (!instruction.trim()) {
    throw new GatewayError('validation', 'a delivery instruction is required', {
      remedy: 'Describe how the line should sound before generating.',
    });
  }
  if (!Number.isFinite(intent.cfgScale) || intent.cfgScale <= 0) {
    throw new GatewayError('validation', 'cfg_scale must be a positive number');
  }
  if (!Number.isInteger(intent.seed)) {
    throw new GatewayError('validation', 'seed must be an integer');
  }

  if (intent.reference) {
    if (!Buffer.isBuffer(intent.reference.audio) || intent.reference.audio.length === 0) {
      throw new GatewayError('validation', 'the resolved reference contains no audio');
    }
    if (
      typeof intent.reference.transcript !== 'string' ||
      !intent.reference.transcript.trim()
    ) {
      throw new GatewayError(
        'validation',
        'reference audio was supplied without its exact transcript',
        { remedy: 'Add the transcript that matches the selected audio window.' },
      );
    }
  }

  const derivedMode = intent.reference ? 'clone' : 'design';
  const breach = findCeilingBreach({
    mode: derivedMode,
    cfgScale: intent.cfgScale,
    text,
    instruction,
    ...(intent.reference ? { refText: intent.reference.transcript } : {}),
  });
  if (breach) {
    const refusal = ceilingRefusal(breach, derivedMode);
    throw new GatewayError('validation', refusal.message, { remedy: refusal.remedy });
  }

  const legacyMismatch =
    intent.legacyMode !== undefined &&
    (intent.legacyMode === 'design') !== (derivedMode === 'design');
  const segments = intent.reference ? 2 : 1;
  return {
    text,
    instruction,
    cfgScale: intent.cfgScale,
    seed: intent.seed,
    ...(intent.reference ? { reference: intent.reference } : {}),
    template: intent.reference ? 'ref_edit_tata' : 'tts_instruction',
    derivedMode,
    segments,
    batch: textEncoderBatch(derivedMode, intent.cfgScale),
    tokenCeiling: tokenCeilingFor(derivedMode, intent.cfgScale),
    legacyMismatch,
  };
}
