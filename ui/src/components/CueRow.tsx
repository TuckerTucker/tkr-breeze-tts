/**
 * One row of the script.
 *
 * The row carries everything the operator needs to judge it — its text, its
 * voice, its state, and where a timed cue landed against its slot — in place,
 * without opening anything.
 *
 * @module
 */

import type { JSX } from 'react';

import {
  CUE_STATE_LABEL,
  cueBlocker,
  driftLabel,
  formatTarget,
  type Cue,
} from '../state/script.js';
import type { Voice } from '../state/voices.js';

/** What a row needs. */
export interface CueRowProps {
  readonly cue: Cue;
  readonly voices: readonly Voice[];
  readonly availableVoiceIds: ReadonlySet<string>;
  readonly onEdit: (patch: Partial<Pick<Cue, 'text' | 'voiceId' | 'voiceName' | 'seed'>>) => void;
  readonly onReroll: () => void;
}

/**
 * Render one cue row.
 *
 * @param props - The cue and its handlers.
 * @returns A table row.
 */
export function CueRow(props: CueRowProps): JSX.Element {
  const { cue } = props;
  const blocker = cueBlocker(cue, props.availableVoiceIds);
  const drift = driftLabel(cue);
  const drifted = drift !== '—';

  return (
    <tr>
      <td className="muted">{String(cue.index + 1).padStart(2, '0')}</td>
      <td>
        <input
          type="text"
          aria-label={`Cue ${cue.index + 1} text`}
          value={cue.text}
          onChange={(event) => props.onEdit({ text: event.target.value })}
        />
        {blocker && (
          <p
            className="caption blocked"
            style={{ margin: '2px 0 0' }}
            role="status"
            aria-label={`Cue ${cue.index + 1} problem`}
          >
            {blocker}
          </p>
        )}
      </td>
      <td>
        <select
          aria-label={`Cue ${cue.index + 1} voice`}
          value={cue.voiceId ?? ''}
          onChange={(event) => {
            const voice = props.voices.find((entry) => entry.id === event.target.value);
            props.onEdit({
              voiceId: voice?.id ?? null,
              voiceName: voice?.name ?? null,
            });
          }}
        >
          <option value="">— no voice —</option>
          {props.voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
            </option>
          ))}
        </select>
      </td>
      <td className="meter">{formatTarget(cue.targetStart)}</td>
      <td className="meter">
        {cue.actualSeconds === null ? '—' : `${cue.actualSeconds.toFixed(1)}s`}
      </td>
      <td className={`meter${drifted ? ' meter--over' : ''}`}>{drift}</td>
      <td>
        <span
          className={`cue-state${
            cue.state === 'failed' || cue.state === 'unrunnable'
              ? ' cue-state--failed'
              : drifted
                ? ' cue-state--drifted'
                : ''
          }`}
        >
          {drifted && cue.state === 'done' ? 'DRIFTED' : CUE_STATE_LABEL[cue.state]}
        </span>
        {drifted && (
          <div className="row" style={{ marginTop: 4 }}>
            {/* Reroll, shorten, or accept — the three honest responses. The
                audio is never stretched to fit, so no such control exists. */}
            <button type="button" className="chip" onClick={props.onReroll}>
              Reroll
            </button>
            <span className="caption">or shorten the line, or accept</span>
          </div>
        )}
      </td>
    </tr>
  );
}
