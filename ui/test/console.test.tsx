/**
 * The console: disabled with a reason, length while typing, seed, persistence.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';

import { Console } from '../src/components/Console.js';
import { speechForm } from '../src/api/client.js';
import {
  INITIAL_DRAFT,
  MAX_TOKENS,
  VOCAL_EVENTS,
  estimateTokens,
  generateBlockedReason,
  insertAtCaret,
  loadDraft,
  rollSeed,
  saveDraft,
  tokenCeilingFor,
  CEILING_BY_BATCH,
  type Draft,
} from '../src/state/draft.js';
import type { VoiceMode } from '../src/state/mode.js';

function Harness(props: {
  initial?: Partial<Draft>;
  onGenerate?: () => void;
  cfgScale?: number;
  mode?: VoiceMode;
  seedControlsVisible?: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft>({ ...INITIAL_DRAFT, ...props.initial });
  return (
    <Console
      draft={draft}
      onDraftChange={setDraft}
      blockedReason={generateBlockedReason({
        draft,
        gatewayReachable: true,
        busy: false,
        generating: false,
        modeBlocker: null,
        mode: props.mode ?? 'design',
        cfgScale: props.cfgScale ?? 1.0,
      })}
      statusLine="Warm — expected 38ms to first audio"
      cfgScale={props.cfgScale ?? 1.0}
      mode={props.mode ?? 'design'}
      onGenerate={props.onGenerate ?? (() => {})}
      seedControlsVisible={props.seedControlsVisible ?? true}
      onRerollSeed={() => setDraft({ ...draft, seed: 999 })}
    />
  );
}

describe('Generate is never enabled into a failure', () => {
  it('is disabled with a reason on empty text', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /generate/i })).toBeDisabled();
    expect(screen.getByText(/Enter some text to enable/i)).toBeInTheDocument();
  });

  it('is disabled with a reason when the gateway is unreachable', () => {
    const reason = generateBlockedReason({
      draft: { ...INITIAL_DRAFT, text: 'hello' },
      gatewayReachable: false,
      busy: false,
      generating: false,
      modeBlocker: null,
      mode: 'design' as const,
      cfgScale: 1.0,
    });
    // Not enabled into a failure — the reason names what is wrong.
    expect(reason).toMatch(/gateway is not running/i);
  });

  it('is disabled with the busy reason while an inference runs', () => {
    expect(
      generateBlockedReason({
        draft: { ...INITIAL_DRAFT, text: 'hello' },
        gatewayReachable: true,
        busy: true,
        generating: false,
        modeBlocker: null,
        mode: 'design' as const,
        cfgScale: 1.0,
      }),
    ).toMatch(/Disabled while a request is running/i);
  });

  it('enables once there is text', () => {
    render(<Harness initial={{ text: 'Hello there.' }} />);
    expect(screen.getByRole('button', { name: /generate/i })).toBeEnabled();
  });

  it('surfaces over-length while typing rather than rejecting on submit', () => {
    const long = 'x'.repeat((MAX_TOKENS + 40) * 4);
    render(<Harness initial={{ text: long }} />);
    expect(screen.getByRole('button', { name: /generate/i })).toBeDisabled();
    // The harness renders at CFG 1.0, whose ceiling is 256, not 512.
    expect(screen.getByText(/past the limit/i)).toBeInTheDocument();
  });

  it('applies the ceiling of the current CFG mode, not a flat one', () => {
    // Measured live: ~299 tokens fails at CFG 1.0 and serves at 2.5 and 4.0,
    // and past the ceiling the request produces no audio at all rather than
    // running slowly — so the reason names the way out.
    expect(tokenCeilingFor('design', 1.0)).toBe(256);
    expect(tokenCeilingFor('design', 2.5)).toBe(512);
    // Clone reaches text-encoder batch 2, but its assembled prompt still uses
    // backbone batch 1. That separately keyed graph is capped at 256.
    expect(tokenCeilingFor('clone', 1.0)).toBe(256);
    expect(tokenCeilingFor('direction', 1.0)).toBe(256);
    expect(CEILING_BY_BATCH).toEqual({ 1: 256, 2: 512, 4: 512 });

    const midLength = 'x'.repeat(300 * 4); // ~300 tokens
    const gate = {
      draft: { ...INITIAL_DRAFT, text: midLength },
      gatewayReachable: true,
      busy: false,
      generating: false,
      modeBlocker: null,
      mode: 'design' as const,
    };
    expect(generateBlockedReason({ ...gate, cfgScale: 1.0 })).toMatch(/raise CFG/);
    expect(generateBlockedReason({
      ...gate,
      cfgScale: 1.0,
      cfgAdjustable: false,
    })).toMatch(/Shorten it to generate/);
    expect(generateBlockedReason({ ...gate, cfgScale: 4.0 })).toBeNull();
  });

  it('reports the mode blocker when one is present', () => {
    expect(
      generateBlockedReason({
        draft: { ...INITIAL_DRAFT, text: 'hello' },
        gatewayReachable: true,
        busy: false,
        generating: false,
        modeBlocker: 'Add the exact transcript of the reference recording.',
        mode: 'design' as const,
        cfgScale: 1.0,
      }),
    ).toMatch(/exact transcript/);
  });
});

describe('length feedback tracks input live', () => {
  it('updates the meter as text is typed, counting what will actually be sent', () => {
    render(<Harness />);
    const meter = (): string =>
      screen.getByRole('status', { name: 'Input length' }).textContent ?? '';

    // The instruction alone, before a word is typed. It is not decoration: it
    // shares one text segment with the line, and the segment is what meets the
    // ceiling — so a meter counting only the box in front of you would read
    // comfortably while the request failed.
    const instructionOnly = estimateTokens(INITIAL_DRAFT.instruction);
    expect(instructionOnly).toBeGreaterThan(0);
    expect(meter()).toContain(`${instructionOnly} / 256`);

    const line = 'a'.repeat(40);
    const textarea = screen.getByLabelText('Text to speak');
    fireEvent.change(textarea, { target: { value: line } });

    // Counted as one joined segment, which is how it is sent — not as two
    // estimates added, since rounding each half separately would under-count
    // exactly where the ceiling matters.
    const joined = estimateTokens(`${INITIAL_DRAFT.instruction} ${line}`);
    expect(meter()).toContain(`${joined} / 256`);
    expect(joined).toBeGreaterThan(estimateTokens(line));
    expect(meter()).toMatch(/line and instruction together/);
  });

  it('estimates tokens from characters, matching the gateway', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('vocal events', () => {
  it('appears before the text entry field', () => {
    render(<Harness />);
    const heading = screen.getByText('Vocal events');
    const textInput = screen.getByLabelText('Text to speak');

    expect(
      heading.compareDocumentPosition(textInput) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('inserts the marker at the caret', () => {
    expect(insertAtCaret('Hello world', 5, '(sigh)')).toEqual({
      text: 'Hello (sigh) world',
      caret: 12,
    });
  });

  it('does not double a space when the caret follows one', () => {
    expect(insertAtCaret('Hello ', 6, '(sigh)').text).toBe('Hello (sigh) ');
  });

  it('inserts the form matching the selected language', () => {
    render(<Harness initial={{ text: 'Hi' }} />);
    fireEvent.click(screen.getByRole('button', { name: '(sigh)' }));
    expect((screen.getByLabelText('Text to speak') as HTMLTextAreaElement).value).toContain(
      '(sigh)',
    );

    fireEvent.click(screen.getByRole('button', { name: '中文' }));
    fireEvent.click(screen.getByRole('button', { name: '[笑]' }));
    expect((screen.getByLabelText('Text to speak') as HTMLTextAreaElement).value).toContain(
      '[笑]',
    );
  });

  it('offers a distinct palette per language', () => {
    expect(VOCAL_EVENTS.en.map((event) => event.marker)).toContain('(laugh)');
    expect(VOCAL_EVENTS.zh.map((event) => event.marker)).toContain('[笑]');
  });
});

describe('no language field is ever sent', () => {
  it('is absent from the outgoing request', () => {
    // The vendor API has no language field; the model infers language from the
    // text. The selection drives the palette only.
    const form = speechForm({
      text: '[笑] 你好',
      instruction: 'warm',
      cfgScale: 1,
      seed: 42,
      mode: 'design',
    });
    expect([...form.keys()].sort()).toEqual([
      'cfg_scale',
      'instruction',
      'mode',
      'seed',
      'text',
    ]);
    expect(form.get('language')).toBeNull();
  });
});

describe('the seed makes a comparison meaningful', () => {
  it('can keep the stored seed while hiding its controls', () => {
    render(<Harness initial={{ seed: 42, seedLocked: false }} seedControlsVisible={false} />);
    expect(screen.queryByLabelText('Seed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reroll' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Locked|Unlocked/ })).not.toBeInTheDocument();
  });

  it('shows the value and its locked state', () => {
    render(<Harness initial={{ seed: 42, seedLocked: true }} />);
    expect((screen.getByLabelText('Seed') as HTMLInputElement).value).toBe('42');
    expect(screen.getByRole('button', { name: 'Locked' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('rerolls to a new displayed value', () => {
    render(<Harness initial={{ seed: 42 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reroll' }));
    expect((screen.getByLabelText('Seed') as HTMLInputElement).value).toBe('999');
  });

  it('draws a fresh seed inside the accepted range', () => {
    expect(rollSeed(() => 0)).toBe(0);
    expect(rollSeed(() => 0.5)).toBe(50_000);
  });

  it('sends the identical seed for an identical request', () => {
    const build = (): FormData =>
      speechForm({
        text: 'same line',
        instruction: 'same instruction',
        cfgScale: 1,
        seed: 42,
        mode: 'design',
      });
    expect(build().get('seed')).toBe(build().get('seed'));
  });
});

describe('a reload loses nothing', () => {
  it('round-trips draft, language and seed through storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };

    const draft: Draft = {
      text: '(sigh) It is good to hear your voice again',
      instruction: 'A warm, thoughtful young woman.',
      language: 'zh',
      seed: 17,
      seedLocked: false,
    };
    saveDraft(storage, draft);
    expect(loadDraft(storage)).toEqual(draft);
  });

  it('falls back to the initial draft rather than throwing on a corrupt entry', () => {
    const storage = {
      getItem: () => '{ not json',
      setItem: () => {},
    };
    expect(loadDraft(storage)).toEqual(INITIAL_DRAFT);
  });

  it('never lets a full storage take the console down', () => {
    const storage = {
      getItem: () => null,
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
    };
    expect(() => saveDraft(storage, INITIAL_DRAFT)).not.toThrow();
  });
});
