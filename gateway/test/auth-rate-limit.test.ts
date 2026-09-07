/**
 * Slice 4 — login rate limiting.
 *
 * The limiter takes its key rather than deriving one; the plugin resolves a
 * client address behind a proxy in slice 5. What is asserted here is the rule
 * itself, including the eviction that keeps the counter map bounded.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WINDOW_MS,
  RateLimiter,
} from '../src/auth/rate-limit.js';

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

describe('RateLimiter', () => {
  it('allows an untouched key', () => {
    expect(new RateLimiter().check('1.2.3.4')).toBe(true);
  });

  it('allows attempts up to the ceiling and refuses the next', () => {
    const limiter = new RateLimiter({ maxAttempts: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check('1.2.3.4')).toBe(true);
      limiter.record('1.2.3.4');
    }
    expect(limiter.check('1.2.3.4')).toBe(false);
  });

  it('leaves someone who mistypes twice entirely unaffected', () => {
    // The threshold exists to stop a script, not to punish a person.
    const limiter = new RateLimiter();
    limiter.record('1.2.3.4');
    limiter.record('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(DEFAULT_MAX_ATTEMPTS).toBeGreaterThan(2);
  });

  it('keys are independent, so one source cannot lock out another', () => {
    const limiter = new RateLimiter({ maxAttempts: 2 });
    limiter.record('1.2.3.4');
    limiter.record('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(false);
    expect(limiter.check('5.6.7.8')).toBe(true);
  });

  it('recovers when the window closes', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ now: clock.now, maxAttempts: 2 });
    limiter.record('1.2.3.4');
    limiter.record('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(false);

    clock.advance(DEFAULT_WINDOW_MS + 1);
    expect(limiter.check('1.2.3.4')).toBe(true);
  });

  it('recovers within a wait a person will tolerate', () => {
    // If address resolution ever collapses many visitors onto one key, a long
    // ban would turn a shared bucket into an outage for everyone with the link.
    expect(DEFAULT_WINDOW_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('clears a key on success, so a corrected typo is not carried forward', () => {
    const limiter = new RateLimiter({ maxAttempts: 2 });
    limiter.record('1.2.3.4');
    limiter.clear('1.2.3.4');
    limiter.record('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(true);
  });

  it('evicts closed windows so the map does not grow with distinct sources', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ now: clock.now });
    for (let i = 0; i < 50; i += 1) limiter.record(`10.0.0.${i}`);
    expect(limiter.size).toBe(50);

    clock.advance(DEFAULT_WINDOW_MS + 1);
    expect(limiter.size).toBe(0);
  });

  it('starts a fresh window rather than resuming a closed one', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ now: clock.now, maxAttempts: 2 });
    limiter.record('1.2.3.4');

    clock.advance(DEFAULT_WINDOW_MS + 1);
    limiter.record('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(true);
  });

  it('imports no Fastify and derives no address of its own', async () => {
    const source = await readFile(new URL('../src/auth/rate-limit.ts', import.meta.url), 'utf8');
    // Comments stripped first: this module's own docstring explains why it does
    // not reach for request.ip, and an assertion that trips over the
    // explanation is testing prose rather than code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/from 'fastify'/);
    expect(code).not.toMatch(/request\.ip/);
  });
});
