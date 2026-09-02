/** Task-oriented primary navigation. */

import type { JSX, KeyboardEvent } from 'react';

import {
  WORKSPACE_AVAILABILITY,
  type Workspace,
} from '../state/workspace.js';

/** Props for the available-workspace navigation. */
export interface WorkspaceNavProps {
  readonly active: Workspace;
  readonly onSelect: (workspace: Workspace) => void;
}

const ALL_WORKSPACES: readonly { id: Workspace; label: string; summary: string }[] = [
  { id: 'voices', label: 'Voices', summary: 'Create and keep' },
  { id: 'speak', label: 'Speak', summary: 'Generate one line' },
  { id: 'scripts', label: 'Scripts', summary: 'Direct a document' },
];

const WORKSPACES = ALL_WORKSPACES.filter(
  (workspace) => WORKSPACE_AVAILABILITY[workspace.id],
);

/**
 * Render keyboard-, pointer-, touch-, and screen-reader-equivalent navigation.
 *
 * @param props - Active tool and selection callback.
 * @returns The primary workspace navigation.
 */
export function WorkspaceNav(props: WorkspaceNavProps): JSX.Element {
  const move = (event: KeyboardEvent<HTMLButtonElement>, current: number): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? WORKSPACES.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + WORKSPACES.length) %
            WORKSPACES.length;
    const workspace = WORKSPACES[next]!;
    props.onSelect(workspace.id);
    document.getElementById(`workspace-tab-${workspace.id}`)?.focus();
  };

  return (
    <nav className="workspace-nav" aria-label="Primary tools">
      <div role="tablist" aria-label="Voice lifecycle tools" className="workspace-nav__list">
        {WORKSPACES.map((workspace, index) => (
          <button
            id={`workspace-tab-${workspace.id}`}
            key={workspace.id}
            type="button"
            role="tab"
            aria-selected={props.active === workspace.id}
            aria-controls={`workspace-panel-${workspace.id}`}
            tabIndex={props.active === workspace.id ? 0 : -1}
            onClick={() => props.onSelect(workspace.id)}
            onKeyDown={(event) => move(event, index)}
          >
            <span>{workspace.label}</span>
            <small>{workspace.summary}</small>
          </button>
        ))}
      </div>
    </nav>
  );
}
