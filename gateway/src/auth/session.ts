/**
 * Sessions for the shared-password gate.
 *
 * In memory by deliberate choice, recorded here so that a container restart
 * ending every session reads as the decision it is rather than as a defect
 * someone should fix. The hosted app pins itself to one container precisely
 * because its stores hold authoritative in-memory indexes; a session map is the
 * least surprising thing in that container.
 *
 * The clock is injected, matching the rest of the gateway, so expiry is tested
 * rather than slept through.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

/** Reads the current time in epoch milliseconds. */
export type Clock = () => number;

/** How long a session lives from the moment it was created. */
export const SESSION_LIFETIME_MS = 60 * 60 * 1000;

/** Bytes of entropy behind a session id. */
const SESSION_ID_BYTES = 32;

/** What the store holds against an id. Deliberately not a person. */
interface SessionEntry {
  readonly createdAt: number;
}

/**
 * Opaque, expiring sessions keyed by a random id.
 *
 * A session id encodes nothing — no identity, no claims, no timestamp — so a
 * stolen cookie reveals only that a session existed. There are no accounts to
 * reveal anything about.
 */
export class SessionStore {
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #now: Clock;
  readonly #lifetimeMs: number;

  /**
   * @param options - The clock to read, and the lifetime to enforce.
   */
  constructor(options: { now?: Clock; lifetimeMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#lifetimeMs = options.lifetimeMs ?? SESSION_LIFETIME_MS;
  }

  /**
   * Open a session.
   *
   * @returns Its id, to be carried in the session cookie.
   */
  create(): string {
    this.#sweep();
    const id = randomBytes(SESSION_ID_BYTES).toString('base64url');
    this.#sessions.set(id, { createdAt: this.#now() });
    return id;
  }

  /**
   * Decide whether an id names a live session.
   *
   * An unknown id and an expired one are indistinguishable in the return value.
   * The difference is only useful to someone probing.
   *
   * @param id - The value read from the cookie, if there was one.
   * @returns True only for a session that exists and has not expired.
   */
  verify(id: string | undefined): boolean {
    this.#sweep();
    if (!id) return false;
    const entry = this.#sessions.get(id);
    if (entry === undefined) return false;
    return !this.#expired(entry, this.#now());
  }

  /**
   * End one session immediately.
   *
   * @param id - The session to drop; an unknown id is not an error.
   */
  destroy(id: string | undefined): void {
    if (id) this.#sessions.delete(id);
  }

  /** How many live sessions are held. Exposed for tests and diagnostics. */
  get size(): number {
    this.#sweep();
    return this.#sessions.size;
  }

  /**
   * Expiry is fixed from creation, not slid forward on activity.
   *
   * A fixed lifetime is the honest reading of "the session lasts an hour";
   * sliding expiry would mean an open tab never expires at all.
   */
  #expired(entry: SessionEntry, now: number): boolean {
    return now - entry.createdAt >= this.#lifetimeMs;
  }

  /**
   * Drop expired entries.
   *
   * Swept on access rather than on a timer: the map is small, and a timer would
   * be a second thing to shut down cleanly.
   */
  #sweep(): void {
    const now = this.#now();
    for (const [id, entry] of this.#sessions) {
      if (this.#expired(entry, now)) this.#sessions.delete(id);
    }
  }
}
