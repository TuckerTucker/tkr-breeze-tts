/**
 * Slice 4 — password verification and sessions, tested without a server.
 *
 * These are pure modules by design, the same separation cache-index.ts and
 * voices-index.ts already keep from their filesystem halves, so their rules can
 * be asserted directly rather than through a route.
 */

import { hash } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';

import {
  ARGON2ID_PREFIX,
  PasswordHashError,
  argon2Verifier,
  validatePasswordHash,
} from '../src/auth/hash.js';
import { SESSION_LIFETIME_MS, SessionStore } from '../src/auth/session.js';

/** A clock a test drives by hand. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

describe('validatePasswordHash', () => {
  it('returns null when nothing is configured, which is what disables the gate', () => {
    expect(validatePasswordHash(undefined)).toBeNull();
    expect(validatePasswordHash('')).toBeNull();
    expect(validatePasswordHash('   ')).toBeNull();
  });

  it('accepts an Argon2id hash', async () => {
    const stored = await hash('correct horse battery staple');
    expect(stored.startsWith(ARGON2ID_PREFIX)).toBe(true);
    expect(validatePasswordHash(stored)).toBe(stored);
  });

  it('refuses a plaintext password with a remedy, at startup rather than at first login', () => {
    // A malformed hash discovered at login presents as "the password is wrong",
    // which sends the operator to check the one thing that is not broken.
    expect(() => validatePasswordHash('hunter2')).toThrow(PasswordHashError);
    try {
      validatePasswordHash('hunter2');
    } catch (error) {
      expect((error as PasswordHashError).remedy).toContain('Deploy only the printed hash');
    }
  });

  it('refuses a hash from another Argon2 variant', async () => {
    // argon2i and argon2d are not what the gate verifies against.
    expect(() => validatePasswordHash('$argon2i$v=19$m=16,t=2,p=1$abc$def')).toThrow(
      PasswordHashError,
    );
  });
});

describe('argon2Verifier', () => {
  const verifier = argon2Verifier();

  it('accepts the right password and rejects a wrong one', async () => {
    const stored = await hash('correct horse battery staple');
    expect(await verifier.verify(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifier.verify(stored, 'correct horse battery stapl')).toBe(false);
  });

  it('does not leak the password through how much of it is correct', async () => {
    // Argon2 derives the full key on every attempt regardless of the candidate,
    // so a near-miss costs the same as a wild guess. Asserted as an ordering of
    // medians rather than a strict bound, because wall-clock on a shared runner
    // is noisy and a flaky security test gets deleted rather than fixed.
    const stored = await hash('correct horse battery staple');
    const time = async (candidate: string): Promise<number> => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        await verifier.verify(stored, candidate);
        samples.push(performance.now() - started);
      }
      return samples.sort((a, b) => a - b)[2]!;
    };

    const nearMiss = await time('correct horse battery stapl');
    const wildGuess = await time('x');
    const ratio = nearMiss / wildGuess;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it('treats a malformed hash as a failed attempt rather than throwing', async () => {
    // An Argon2 fault must never become an open door, and it must not become a
    // 500 that distinguishes itself from a rejection either.
    expect(await verifier.verify('not-a-hash', 'anything')).toBe(false);
    expect(await verifier.verify('', 'anything')).toBe(false);
  });
});

describe('SessionStore', () => {
  it('issues opaque ids that encode nothing', () => {
    const store = new SessionStore();
    const id = store.create();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.create()).not.toBe(id);
  });

  it('holds a session at 59 minutes and drops it at 61', () => {
    const clock = fakeClock();
    const store = new SessionStore({ now: clock.now });
    const id = store.create();

    clock.advance(59 * 60 * 1000);
    expect(store.verify(id)).toBe(true);

    clock.advance(2 * 60 * 1000);
    expect(store.verify(id)).toBe(false);
  });

  it('expires from creation, not from last activity', () => {
    // A sliding window would mean an open tab never expires, which is not what
    // "the session lasts an hour" says.
    const clock = fakeClock();
    const store = new SessionStore({ now: clock.now });
    const id = store.create();

    for (let i = 0; i < 5; i += 1) {
      clock.advance(15 * 60 * 1000);
      store.verify(id);
    }
    expect(store.verify(id)).toBe(false);
  });

  it('cannot tell an unknown id from an expired one', () => {
    const clock = fakeClock();
    const store = new SessionStore({ now: clock.now });
    const id = store.create();
    clock.advance(SESSION_LIFETIME_MS + 1);

    expect(store.verify(id)).toBe(false);
    expect(store.verify('never-existed')).toBe(false);
  });

  it('treats a missing cookie as no session', () => {
    const store = new SessionStore();
    expect(store.verify(undefined)).toBe(false);
    expect(store.verify('')).toBe(false);
  });

  it('destroys a session immediately, which is what signing out means', () => {
    const store = new SessionStore();
    const id = store.create();
    store.destroy(id);
    expect(store.verify(id)).toBe(false);
  });

  it('sweeps expired entries so the map does not grow without bound', () => {
    const clock = fakeClock();
    const store = new SessionStore({ now: clock.now });
    for (let i = 0; i < 10; i += 1) store.create();
    expect(store.size).toBe(10);

    clock.advance(SESSION_LIFETIME_MS + 1);
    expect(store.size).toBe(0);
  });

  it('imports no Fastify', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/auth/session.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/from 'fastify'/);
  });
});
