/**
 * The shared-password gate, as the visitor meets it.
 *
 * This component is the reason the gateway serves its static shell to an
 * unauthenticated visitor: the password field is React, so the bundle has to
 * load before anyone can type. Everything it needs is injected, and it issues
 * nothing on its own — an unauthenticated visitor's first request is the one
 * they chose to make.
 *
 * It is deliberately not a modal. The console it replaces stays mounted behind
 * the shell's own state, so re-entry resumes rather than restarts, and the
 * standing UX rules apply here exactly as everywhere else: failure in place
 * beside the field, no toast, no dialog, nothing thrown away.
 *
 * @module
 */

import { useRef, useState, type FormEvent, type JSX } from 'react';

import type { SessionOutcome, SessionRefusal } from '../api/client.js';

/** What the gate needs from the shell around it. */
export interface AccessGateProps {
  /**
   * Try one password. The only call this component ever makes, and only ever
   * on submission.
   */
  readonly onSubmit: (password: string) => Promise<SessionOutcome>;
  /**
   * Whether this viewer had a session that went away, rather than arriving for
   * the first time. It changes only the sentence above the field, but that
   * sentence is what tells someone mid-sentence that their work is still here.
   */
  readonly returning: boolean;
}

/**
 * What to add when the gateway's own message does not carry a remedy.
 *
 * Rate limiting and rejection arrive in the same typed envelope, so without
 * this a limited visitor reads "not accepted" and retypes a password that was
 * very likely correct — which is both a lie and the one action that keeps the
 * limiter closed.
 */
const REMEDY: Readonly<Record<SessionRefusal, string>> = {
  rejected: 'Check for a stray space or a missing character, then try again.',
  'rate-limited': 'This is not a judgement about the password — wait, then try again.',
  unavailable: 'Nothing was checked, so nothing here is wrong yet.',
};

/**
 * Render the one field that stands between a visitor and the console.
 *
 * @param props - The injected login exchange and why the viewer is here.
 * @returns The gate.
 */
export function AccessGate(props: AccessGateProps): JSX.Element {
  const field = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<Extract<SessionOutcome, { ok: false }> | null>(
    null,
  );

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    // Disabled rather than guarded after the fact, but a keyboard submit can
    // still arrive while the first one is open.
    if (submitting || !password) return;
    setSubmitting(true);
    setRefusal(null);
    try {
      const outcome = await props.onSubmit(password);
      if (outcome.ok) return;
      setRefusal(outcome);
      // The field keeps focus and its content: the remedy for every refusal
      // here is another attempt from where they already are.
      field.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="masthead">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">B</span>
          <div><h1>Breeze Voice Studio</h1><p>Create a voice once. Use it everywhere.</p></div>
        </div>
      </header>

      <main className="workspace-stage">
        <section className="tool-card tool-card--accent" aria-label="Access">
          <div className="tool-card__heading">
            <div>
              <p className="step-label">Shared demo</p>
              <h3>{props.returning ? 'Sign in again to continue' : 'Enter the demo password'}</h3>
            </div>
          </div>
          <p className="section-copy">
            {props.returning
              ? 'This session expired. Everything you had written is still here and comes back with you.'
              : 'One password opens this demo. Everyone who has it shares the same workspace.'}
          </p>
          <form onSubmit={(event) => void submit(event)}>
            <label className="field">
              <span>Password</span>
              <input
                ref={field}
                type="password"
                aria-label="Demo password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  // The refusal described the value they have now replaced.
                  setRefusal(null);
                }}
              />
            </label>
            <button
              type="submit"
              className="primary-action"
              disabled={submitting || password.length === 0}
            >
              {submitting ? 'Checking…' : 'Enter'}
            </button>
            {/* In place, beside the field. Never a toast. */}
            {refusal && (
              <p className="inline-problem" role="status">
                {refusal.message} — {refusal.remedy ?? REMEDY[refusal.reason]}
              </p>
            )}
          </form>
        </section>
      </main>
    </div>
  );
}
