# Historical wireframes

The registered SVGs in this directory are dated design snapshots from the original mode-first UI
work. They are retained with their registry records as evidence of that design pass; they are not
the current product specification and are not updated when implementation copy or availability
changes.

The active implementation is task-first: Voices and Speak are visible, Speak uses saved voices,
and Scripts, described-voice Speak, and temporary-reference Speak are dormant behind centralized
availability gates. Current behavior belongs in [`docs/models/architecture.md`](../../docs/models/architecture.md),
with source truth in `ui/src/state/workspace.ts`.
