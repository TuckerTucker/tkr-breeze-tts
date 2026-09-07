/**
 * The wake state: named, measured, and absent when warm.
 */

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ReadinessBadge, WakeState, WarmUpButton } from '../src/components/WakeState.js';
import {
  WAKE_EXPLANATION,
  WARM_UP_COST,
  formatSeconds,
  readinessSummary,
  shouldShowWake,
  wakeCopy,
  warmUpBlockedReason,
  type MeasuredLatency,
} from '../src/state/readiness.js';

const MEASURED: MeasuredLatency = {
  warmupMs: 41_234,
  coldTtfaMs: 45_000,
  warmTtfaMs: 38,
  rtf: 0.32,
};

describe('readiness is visible before submission', () => {
  it('says what a warm request will cost', () => {
    render(<ReadinessBadge readiness="warm" measured={MEASURED} />);
    expect(screen.getByRole('status').textContent).toMatch(/Warm — expected 38ms/);
  });

  it('says a cold request is coming, and roughly how long', () => {
    expect(readinessSummary('cold', MEASURED)).toMatch(/cold start, about 45s/);
  });

  it('reports unknown as unknown, never as warm', () => {
    // A wrong warm claim is the one that misleads.
    const summary = readinessSummary('unknown', MEASURED);
    expect(summary).toMatch(/unknown/i);
    expect(summary).not.toMatch(/^Warm/);
  });

  it('says a figure is not measured rather than inventing one', () => {
    expect(readinessSummary('warm', null)).toMatch(/not yet measured/);
    expect(readinessSummary('cold', null)).toMatch(/not yet measured/);
    expect(readinessSummary('warm', { ...MEASURED, warmTtfaMs: null })).toMatch(
      /not yet measured/,
    );
  });
});

describe('the wake state is distinct from ordinary generation', () => {
  it('is shown for a cold or unknown request and never for a warm one', () => {
    expect(shouldShowWake('cold')).toBe(true);
    expect(shouldShowWake('unknown')).toBe(true);
    // Warm requests show no wake state at all — that is what makes the cold
    // one legible when it appears.
    expect(shouldShowWake('warm')).toBe(false);
  });

  it('names itself rather than being a spinner', () => {
    render(<WakeState elapsedMs={18_000} measured={MEASURED} />);
    expect(screen.getByLabelText('Waking the GPU')).toBeInTheDocument();
    expect(screen.getByText(/container cold start/i)).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });

  it('shows the expected duration and the warm latency that follows it', () => {
    render(<WakeState elapsedMs={18_000} measured={MEASURED} />);
    // "cold start 45s, then 38ms" is both truer and more interesting.
    expect(screen.getByText(/Expected 45s, then 38ms per clip once warm/i)).toBeInTheDocument();
  });

  it('explains why a cold start happens, in place', () => {
    render(<WakeState elapsedMs={1000} measured={MEASURED} />);
    for (const line of WAKE_EXPLANATION) {
      expect(screen.getByText(line)).toBeInTheDocument();
    }
    // Status appears in place, next to the action. Never a toast.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('holds the state past its estimate rather than switching to a spinner', () => {
    const copy = wakeCopy(60_000, MEASURED);
    expect(copy.elapsed).toBe('60 seconds elapsed');
    expect(copy.expectation).toMatch(/Longer than the measured 45s — still waking/);
  });

  it('says the duration is not measured rather than inventing one', () => {
    expect(wakeCopy(5_000, null).expectation).toMatch(/has not been measured yet/);
    expect(wakeCopy(5_000, { ...MEASURED, coldTtfaMs: null }).expectation).toMatch(
      /has not been measured/,
    );
  });

  it('tells the operator replay still works while the GPU wakes', () => {
    render(<WakeState elapsedMs={1000} measured={MEASURED} />);
    expect(screen.getByText(/never reaches the GPU/i)).toBeInTheDocument();
  });
});

describe('formatting', () => {
  it('reads milliseconds under a second and seconds above', () => {
    expect(formatSeconds(38)).toBe('38ms');
    expect(formatSeconds(4_500)).toBe('4.5s');
    expect(formatSeconds(45_000)).toBe('45s');
  });
});

describe('warmUpBlockedReason', () => {
  it('allows a warm-up when the demo is cold', () => {
    expect(warmUpBlockedReason('cold', false)).toBeNull();
  });

  it('blocks it when already warm, and says why', () => {
    // The press would do nothing upstream, so it says so rather than
    // pretending to act.
    expect(warmUpBlockedReason('warm', false)).toMatch(/Already warm/);
  });

  it('blocks a second press while the first wake is running', () => {
    expect(warmUpBlockedReason('cold', true)).toMatch(/Starting the GPU/);
  });

  it('stays pressable when readiness is unknown', () => {
    // Refusing to let someone warm a demo because we are unsure whether it is
    // already warm would be exactly the wrong way round.
    expect(warmUpBlockedReason('unknown', false)).toBeNull();
  });

  it('reports the in-flight reason even when readiness says warm', () => {
    expect(warmUpBlockedReason('warm', true)).toMatch(/Starting the GPU/);
  });
});

describe('the warm-up control', () => {
  const noop = (): void => {};

  it('is pressable when cold and states what it costs', () => {
    render(<WarmUpButton readiness="cold" waking={false} onWarmUp={noop} />);
    const button = screen.getByRole('button', { name: 'Warm up' });
    expect(button).toBeEnabled();
    expect(screen.getByText(WARM_UP_COST)).toBeInTheDocument();
  });

  it('names the cost in time, which is what the viewer can act on', () => {
    // Both numbers a viewer weighs: how long they wait, and how long it stays
    // fast. Matched loosely on the digits so rewording the phrase does not
    // break the test, but dropping either figure does.
    expect(WARM_UP_COST).toMatch(/\b3\b/);
    expect(WARM_UP_COST).toMatch(/\b10\b/);
  });

  it('keeps the note short enough for one line in the masthead', () => {
    // .caption territory is 9px uppercase with heavy tracking. A full sentence
    // here wrapped to four lines and doubled the header height — a helpful note
    // becoming a layout defect.
    expect(WARM_UP_COST.length).toBeLessThanOrEqual(40);
    expect(warmUpBlockedReason('warm', false)!.length).toBeLessThanOrEqual(40);
    expect(warmUpBlockedReason('cold', true)!.length).toBeLessThanOrEqual(40);
  });

  it('is disabled and not hidden when already warm', () => {
    // Greying out with the reason beside it is the standing rule; hiding it
    // would make the control vanish from the masthead as the warm window
    // closes, which reads as a glitch rather than as a state.
    render(<WarmUpButton readiness="warm" waking={false} onWarmUp={noop} />);
    expect(screen.getByRole('button', { name: 'Warm up' })).toBeDisabled();
    expect(screen.getByText(/Already warm/)).toBeInTheDocument();
  });

  it('does not call the handler while disabled', () => {
    let pressed = 0;
    render(<WarmUpButton readiness="warm" waking={false} onWarmUp={() => { pressed += 1; }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Warm up' }));
    expect(pressed).toBe(0);
  });

  it('calls the handler once when pressed', () => {
    let pressed = 0;
    render(<WarmUpButton readiness="cold" waking={false} onWarmUp={() => { pressed += 1; }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Warm up' }));
    expect(pressed).toBe(1);
  });

  it('reports progress and refuses a second press while waking', () => {
    render(<WarmUpButton readiness="cold" waking onWarmUp={noop} />);
    expect(screen.getByRole('button', { name: 'Warming…' })).toBeDisabled();
  });

  it('describes the button by its cost note, so the reason is announced', () => {
    render(<WarmUpButton readiness="warm" waking={false} onWarmUp={noop} />);
    const button = screen.getByRole('button', { name: 'Warm up' });
    const noteId = button.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId!)?.textContent).toMatch(/Already warm/);
  });
});
