/**
 * The wake state: named, measured, and absent when warm.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ReadinessBadge, WakeState } from '../src/components/WakeState.js';
import {
  WAKE_EXPLANATION,
  formatSeconds,
  readinessSummary,
  shouldShowWake,
  wakeCopy,
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
