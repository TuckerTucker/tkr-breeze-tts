/**
 * The CFG control, whose *shape* is a measurement result.
 *
 * `configs/fast.json` captures CUDA graphs at 1.0 and 4.0 with
 * `freeze_after_warmup: true`. Whether an uncaptured value leaves that fast
 * path is an empirical question, and until `bench/cfg_probe.py` has answered
 * it this renders discrete presets — because offering a slider whose latency
 * behaviour is unverified would silently contradict the claim the demo exists
 * to make.
 *
 * @module
 */

import type { JSX } from 'react';

import type { CfgControl as CfgControlShape } from '../state/mode.js';

/** What the control needs. */
export interface CfgControlProps {
  readonly control: CfgControlShape;
  readonly value: number;
  readonly onChange: (value: number) => void;
  /** What this dial does in the current mode. */
  readonly label: string;
  /** True when no finding has been recorded yet. */
  readonly unmeasured: boolean;
}

/**
 * Render the CFG control.
 *
 * @param props - Shape, value and label.
 * @returns The control element.
 */
export function CfgControl(props: CfgControlProps): JSX.Element {
  return (
    <div className="panel--inset" style={{ marginBottom: 16 }}>
      <p className="caption caption--ink">CFG scale</p>
      <p className="caption" style={{ marginBottom: 8 }}>{props.label}</p>

      {props.control.kind === 'presets' ? (
        <div className="row" role="group" aria-label="CFG scale">
          {props.control.values.map((value) => (
            <button
              key={value}
              type="button"
              className="chip"
              aria-pressed={props.value === value}
              onClick={() => props.onChange(value)}
            >
              {value.toFixed(1)}
            </button>
          ))}
        </div>
      ) : (
        <label className="field" style={{ marginBottom: 0 }}>
          <input
            type="range"
            aria-label="CFG scale"
            min={props.control.min}
            max={props.control.max}
            step={props.control.step}
            value={props.value}
            onChange={(event) => props.onChange(Number(event.target.value))}
          />
          <span className="meter"> {props.value.toFixed(1)}</span>
        </label>
      )}

      <p className="caption" style={{ marginTop: 8, marginBottom: 0 }}>
        {props.unmeasured
          ? 'Captured presets only — the fall-off probe has not run against this deployment yet.'
          : props.control.kind === 'presets'
            ? 'Captured presets only — measured: an uncaptured value leaves the fast path.'
            : 'Measured: the fast path survives uncaptured values, so this is continuous.'}
      </p>
    </div>
  );
}
