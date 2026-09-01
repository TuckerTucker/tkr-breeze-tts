/**
 * The application-wide processing signal.
 *
 * The moving rail provides a compact visual cue while the explicit label says
 * what work is happening. Motion is removed when the operating system asks
 * for reduced motion; the text and filled rail continue to communicate state.
 *
 * @module
 */

import type { JSX } from 'react';

/** Render the current application activity. */
export function ActivityIndicator(props: { readonly label: string }): JSX.Element {
  return (
    <div
      className="activity-indicator"
      role="status"
      aria-label="Application activity"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="activity-indicator__rail" aria-hidden="true" />
      <span className="caption caption--ink">{props.label}</span>
    </div>
  );
}
