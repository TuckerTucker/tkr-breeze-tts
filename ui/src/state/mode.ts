/**
 * The request-shape label and the CFG control's measured shape.
 *
 * The mode-era console that owned this module is gone; what outlives it is the
 * one distinction the vendor actually makes. `VoiceMode` is not a screen any
 * more — it is the request shape that decides the text-encoder batch, and so
 * the token ceiling, which is why `draft.ts`, `history.ts` and the gateway
 * client still key on it. `cfg_scale` is the dial that separates a clone from a
 * direction, and its control shape is measured rather than assumed.
 *
 * @module
 */

/** Which request shape is being assembled. Not a destination the operator picks. */
export type VoiceMode = 'design' | 'clone' | 'direction';

/** The shape the CFG control should take, from the measured finding. */
export type CfgControl =
  | { kind: 'presets'; values: number[]; default: number }
  | { kind: 'slider'; min: number; max: number; step: number; default: number };

/**
 * The conservative control, used until the fall-off probe has run.
 *
 * Presenting a slider whose latency behaviour is unverified would silently
 * contradict the claim the demo exists to make, so absence of evidence selects
 * presets rather than the more permissive option.
 */
export const DEFAULT_CFG_CONTROL: CfgControl = {
  kind: 'presets',
  values: [1.0, 4.0],
  default: 1.0,
};

/**
 * Read the CFG control shape out of a findings payload.
 *
 * @param finding - What `GET /api/findings` returned, or null.
 * @returns The control to render.
 */
export function cfgControlFrom(finding: unknown): CfgControl {
  if (typeof finding !== 'object' || finding === null) return DEFAULT_CFG_CONTROL;
  const control = (finding as { cfgControl?: unknown }).cfgControl;
  if (typeof control !== 'object' || control === null) return DEFAULT_CFG_CONTROL;
  const candidate = control as Record<string, unknown>;

  if (candidate.kind === 'slider') {
    return {
      kind: 'slider',
      min: typeof candidate.min === 'number' ? candidate.min : 1,
      max: typeof candidate.max === 'number' ? candidate.max : 4,
      step: typeof candidate.step === 'number' ? candidate.step : 0.5,
      default: typeof candidate.default === 'number' ? candidate.default : 1,
    };
  }
  if (candidate.kind === 'presets' && Array.isArray(candidate.values)) {
    const values = candidate.values.filter((value): value is number => typeof value === 'number');
    if (values.length > 0) {
      return {
        kind: 'presets',
        values,
        default: typeof candidate.default === 'number' ? candidate.default : values[0]!,
      };
    }
  }
  return DEFAULT_CFG_CONTROL;
}
