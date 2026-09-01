/** Primary task navigation has equivalent pointer and keyboard behavior. */

import { fireEvent, render, screen } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { describe, expect, it } from 'vitest';

import { WorkspaceNav } from '../src/components/WorkspaceNav.js';
import type { Workspace } from '../src/state/workspace.js';

function Harness(): JSX.Element {
  const [active, setActive] = useState<Workspace>('speak');
  return (
    <>
      <WorkspaceNav active={active} onSelect={setActive} />
      <p role="status">{active}</p>
    </>
  );
}

describe('workspace navigation', () => {
  it('names only the three lifecycle tools and switches by pointer', () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'VoicesCreate and keep',
      'SpeakGenerate one line',
      'ScriptsDirect a document',
    ]);
    expect(screen.queryByRole('tab', { name: 'Clone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Direction' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /voices/i }));
    expect(screen.getByRole('status')).toHaveTextContent('voices');
    expect(screen.getByRole('tab', { name: /voices/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('moves, wraps, and focuses as one accessible tab set', () => {
    render(<Harness />);
    const speak = screen.getByRole('tab', { name: /speak/i });
    speak.focus();
    fireEvent.keyDown(speak, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('scripts');
    expect(screen.getByRole('tab', { name: /scripts/i })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('tab', { name: /scripts/i }), { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('voices');
    expect(screen.getByRole('tab', { name: /voices/i })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('tab', { name: /voices/i }), { key: 'End' });
    expect(screen.getByRole('status')).toHaveTextContent('scripts');
  });
});
