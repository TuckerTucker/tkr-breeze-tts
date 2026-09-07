/**
 * Fixed-window rate limiting for login attempts.
 *
 * One shared password behind a public URL is precisely the shape brute force is
 * good at, so the gate counts failures before it spends Argon2 time on them.
 *
 * The limiter takes its key and never derives one. Resolving a client address
 * from behind a proxy is a Fastify concern that belongs with the plugin: a pure
 * module reaching for `request.ip` would be neither pure nor, behind Modal's
 * proxy, correct.
 *
 * @module
 */

import type { Clock } from './session.js';

/** Failures allowed within one window before refusal. */
export const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Window length.
 *
 * Chosen so a locked-out key recovers within a wait a person will tolerate.
 * That matters more than it looks: if address resolution collapses many
 * visitors onto one key, a long ban would turn a shared bucket into an outage
 * for everyone holding the link.
 */
export const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

interface Window {
  count: number;
  readonly startedAt: number;
}

/**
 * Counts failed attempts per key over a fixed window.
 *
 * Only failures are recorded. A visitor who gets the password right on their
 * first try never appears here at all.
 */
export class RateLimiter {
  readonly #windows = new Map<string, Window>();
  readonly #now: Clock;
  readonly #maxAttempts: number;
  readonly #windowMs: number;

  /**
   * @param options - The clock to read, the failure ceiling, and the window.
   */
  constructor(options: { now?: Clock; maxAttempts?: number; windowMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * Decide whether a key may attempt again.
   *
   * @param key - The caller-resolved source key.
   * @returns True while the key is under its ceiling.
   */
  check(key: string): boolean {
    this.#sweep();
    const window = this.#windows.get(key);
    if (window === undefined) return true;
    return window.count < this.#maxAttempts;
  }

  /**
   * Record one failed attempt.
   *
   * @param key - The caller-resolved source key.
   */
  record(key: string): void {
    this.#sweep();
    const now = this.#now();
    const window = this.#windows.get(key);
    if (window === undefined || now - window.startedAt >= this.#windowMs) {
      this.#windows.set(key, { count: 1, startedAt: now });
      return;
    }
    window.count += 1;
  }

  /**
   * Forget a key's failures.
   *
   * Called on a successful login so a person who mistyped several times and
   * then succeeded does not carry the count into their next visit.
   *
   * @param key - The caller-resolved source key.
   */
  clear(key: string): void {
    this.#windows.delete(key);
  }

  /** How many keys are held. Exposed so a test can assert eviction. */
  get size(): number {
    this.#sweep();
    return this.#windows.size;
  }

  /** Drop windows that have closed, so the map cannot grow with distinct keys over time. */
  #sweep(): void {
    const now = this.#now();
    for (const [key, window] of this.#windows) {
      if (now - window.startedAt >= this.#windowMs) this.#windows.delete(key);
    }
  }
}
