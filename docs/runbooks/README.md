# Procedures (runbooks)

Run-time operations: the steps a person follows when the system needs a hand.

- **Authoring bar:** trigger, numbered steps, expected observables, and a `rehearsal:` date —
  an unrehearsed runbook is a hypothesis.
- **Written by:** human.
- **Retention:** bounded — superseded procedures are deleted on rewrite; the git history is the archive.

Available procedures:

- [`release.md`](release.md) — synchronize versions, cut a tag, and drive the GitHub Packages workflow.
