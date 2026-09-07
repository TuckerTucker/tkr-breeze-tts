/**
 * Password verification for the shared-password gate.
 *
 * Only an Argon2id hash is ever deployed. The plaintext exists in the
 * operator's head and in no file, image layer, or environment variable — which
 * is why this module verifies and never hashes at runtime: nothing here has a
 * plaintext to hash except the one a visitor just typed.
 *
 * The verifier is injected rather than imported at the call site, so the gate's
 * rules can be tested without the native module and so the algorithm is a
 * substitution rather than a rewrite.
 *
 * @module
 */

import { verify, type Algorithm } from '@node-rs/argon2';

/**
 * Verifies a candidate password against a stored hash.
 *
 * Implementations must not distinguish "wrong password" from "malformed hash"
 * in their return value; both are `false`. The difference matters to the
 * operator at startup, not to a caller at the gate.
 */
export interface PasswordVerifier {
  /**
   * @param hash - The stored PHC-format hash.
   * @param candidate - What the visitor typed.
   * @returns True only when the candidate produces the stored hash.
   */
  verify(hash: string, candidate: string): Promise<boolean>;
}

/** PHC prefix every hash this gate accepts must carry. */
export const ARGON2ID_PREFIX = '$argon2id$';

/** Raised when configuration carries something that is not an Argon2id hash. */
export class PasswordHashError extends Error {
  /** What the operator should do about it. */
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'PasswordHashError';
    this.remedy = remedy;
  }
}

/**
 * Validate a configured password hash before any traffic is accepted.
 *
 * A malformed hash must fail at startup, not at a visitor's first login: by
 * then it presents as "the password is wrong", which sends the operator to
 * check the one thing that is not broken.
 *
 * @param raw - The configured value, or undefined when the gate is disabled.
 * @returns The validated hash, or null when no gate is configured.
 * @throws {PasswordHashError} When a value is present but is not Argon2id.
 */
export function validatePasswordHash(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (!value.startsWith(ARGON2ID_PREFIX)) {
    throw new PasswordHashError(
      'GATEWAY_PASSWORD_HASH is not an Argon2id hash',
      'Generate one with:\n' +
        `  node -e "import('@node-rs/argon2').then(a=>a.hash(process.argv[1]).then(console.log))" 'your password'\n` +
        'Deploy only the printed hash. The plaintext belongs nowhere but your head.',
    );
  }
  return value;
}

/**
 * The production verifier.
 *
 * Argon2 derives the full key on every attempt regardless of how much of the
 * candidate is correct, and compares the result in constant time, so neither
 * the length nor any prefix of the password leaks through timing. A thrown
 * error is reported as a failed attempt rather than propagating — an Argon2
 * fault must never become an open door.
 *
 * @param algorithm - Overridable only so a test can force a mismatch; the
 *   default is the Argon2id the stored hashes are produced with.
 * @returns A verifier over the native implementation.
 */
export function argon2Verifier(algorithm?: Algorithm): PasswordVerifier {
  return {
    async verify(hash: string, candidate: string): Promise<boolean> {
      try {
        return await verify(hash, candidate, algorithm === undefined ? {} : { algorithm });
      } catch {
        return false;
      }
    },
  };
}
