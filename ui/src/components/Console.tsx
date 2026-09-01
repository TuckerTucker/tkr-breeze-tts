/**
 * The synthesis console: text, instruction, vocal events, seed, and Generate.
 *
 * Everything essential is visible at once, because the two fields every mode
 * needs are the two fields every mode needs. Length is shown while typing
 * rather than rejected on submit, and Generate carries its reason for being
 * off rather than being a dead control.
 *
 * @module
 */

import { useRef, type JSX } from 'react';

import {
  VOCAL_EVENTS,
  estimateTokens,
  insertAtCaret,
  tokenCeilingFor,
  type Draft,
  type EventLanguage,
} from '../state/draft.js';
import type { VoiceMode } from '../state/mode.js';

/** What the console needs from its parent. */
export interface ConsoleProps {
  readonly draft: Draft;
  readonly onDraftChange: (draft: Draft) => void;
  /** Null when Generate is enabled; otherwise the reason it is not. */
  readonly blockedReason: string | null;
  readonly onGenerate: () => void;
  /** The status line beside the control — readiness, or what is happening. */
  readonly statusLine: string;
  readonly onRerollSeed: () => void;
  /** With the mode, decides the token ceiling. */
  readonly cfgScale: number;
  /** With the cfg, decides the token ceiling: Design at 1.0 is the only 256. */
  readonly mode: VoiceMode;
}

/**
 * Render the console.
 *
 * @param props - Draft state and its handlers.
 * @returns The console element.
 */
export function Console(props: ConsoleProps): JSX.Element {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const { draft, onDraftChange } = props;
  // The instruction shares the spoken segment with the text, so the readout
  // counts what will actually be sent rather than the box in front of you.
  const tokens = estimateTokens(`${draft.instruction} ${draft.text}`);
  const ceiling = tokenCeilingFor(props.mode, props.cfgScale);
  const over = tokens > ceiling;

  const insertEvent = (marker: string): void => {
    const element = textRef.current;
    const caret = element?.selectionStart ?? draft.text.length;
    const next = insertAtCaret(draft.text, caret, marker);
    onDraftChange({ ...draft, text: next.text });
    // Put the caret after the marker so typing continues where it left off.
    queueMicrotask(() => {
      element?.focus();
      element?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <section className="panel" aria-label="Synthesis console">
      <label className="field">
        <p className="caption caption--ink">Text to speak</p>
        <textarea
          ref={textRef}
          aria-label="Text to speak"
          value={draft.text}
          onChange={(event) => onDraftChange({ ...draft, text: event.target.value })}
        />
      </label>

      <div className="row row--between">
        <p
          className={`caption meter${over ? ' meter--over' : ''}`}
          role="status"
          aria-label="Input length"
        >
          {tokens} / {ceiling} tokens — line and instruction together
          {over ? `, ${tokens - ceiling} past the limit` : ''}
        </p>
      </div>

      <label className="field">
        <p className="caption caption--ink">Delivery instruction</p>
        <input
          type="text"
          aria-label="Instruction"
          value={draft.instruction}
          onChange={(event) => onDraftChange({ ...draft, instruction: event.target.value })}
        />
      </label>

      <div className="panel--inset" style={{ marginBottom: 16 }}>
        <p className="caption">Vocal events</p>
        <div className="row">
          {(['en', 'zh'] as EventLanguage[]).map((language) => (
            <button
              key={language}
              type="button"
              className="chip"
              aria-pressed={draft.language === language}
              onClick={() => onDraftChange({ ...draft, language })}
            >
              {language === 'en' ? 'EN' : '中文'}
            </button>
          ))}
          <span className="muted" style={{ marginLeft: 8, marginRight: 8 }}>|</span>
          {VOCAL_EVENTS[draft.language].map((event) => (
            <button
              key={event.marker}
              type="button"
              className="chip"
              onClick={() => insertEvent(event.marker)}
            >
              {event.label}
            </button>
          ))}
        </div>
        <p className="caption" style={{ marginTop: 8, marginBottom: 0 }}>
          The palette only — the model infers language from the text, and no
          language field is sent.
        </p>
      </div>

      <div className="row row--between">
        <div className="row">
          <p className="caption" style={{ margin: 0 }}>Seed</p>
          <input
            type="number"
            aria-label="Seed"
            value={draft.seed}
            style={{ width: 96 }}
            onChange={(event) =>
              onDraftChange({ ...draft, seed: Number(event.target.value) || 0 })
            }
          />
          <button
            type="button"
            className="chip"
            aria-pressed={draft.seedLocked}
            onClick={() => onDraftChange({ ...draft, seedLocked: !draft.seedLocked })}
          >
            {draft.seedLocked ? 'Locked' : 'Unlocked'}
          </button>
          <button type="button" className="chip" onClick={props.onRerollSeed}>
            Reroll
          </button>
        </div>
      </div>
      <p className="caption" style={{ marginTop: 8 }}>
        Hold the seed and an audible difference is the setting you changed, not a
        different sample.
      </p>

      <button
        type="button"
        className="generate"
        disabled={props.blockedReason !== null}
        onClick={props.onGenerate}
      >
        Generate →
      </button>
      {/* In place, next to the control it concerns. Never a toast. */}
      <p
        className={`caption reason${props.blockedReason ? ' blocked' : ''}`}
        role="status"
        aria-label="Generate status"
      >
        {props.blockedReason ?? props.statusLine}
      </p>
    </section>
  );
}
