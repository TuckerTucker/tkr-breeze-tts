# Conditional Rules

Rules that bind only in a named situation — kept out of every task's context so a rule that
rarely applies is not paid for on every turn.

- **Authoring bar:** frontmatter naming the situation mechanically.
- **Written by:** human.
- **Retention:** bounded — replace-on-write.

## The key that fires is `paths:`

Selective loading is keyed by **`paths:` frontmatter** (a list of globs), and it works
**wherever the rule file lives** — it is not a property of this directory.

Observed 2026-08-24, in a session whose loaded rule set was inspected directly: the five rules
carrying `paths:` (`lang-bash`, `lang-go`, `lang-python`, `lang-typescript`,
`agentic-architecture` — all of them in `.claude/rules/tkr-kit/`, the "always-loaded" home)
were exactly the five absent from context, while every frontmatter-less sibling was present.
Scoping is therefore per-file, not per-directory.

`trigger:` — the key this README documented until 2026-08-24, and which
[`docs/canonical-layout.md`](../../../docs/canonical-layout.md) still names for this home — has
never been carried by any rule in this repo, so nothing here demonstrates that it fires. Author
`paths:` unless and until a non-glob trigger is shown to work.

## Why this directory is empty

The four language rules and the agentic-architecture rule are the repo's live conditional rules,
and they sit in `.claude/rules/tkr-kit/` beside the universal ones — correctly, since that is the
tier that ships to consuming projects as a unit, and their `paths:` scoping travels with the file.

This home stays a canonical Rule home (registered at `core/governance/layout-conformance.ts` and
walked by `governance.citation_audit`) for a situation-keyed rule that is **not** a file glob —
an event or a command. Nothing has needed one yet. Empty here is measured, not unexamined.
