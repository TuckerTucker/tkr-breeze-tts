# Patterns

Reusable build-time solutions: how a Rule is discharged while writing code.

- **Authoring bar:** the problem it solves, the shape of the solution, at least one live usage.
- **Provenance:** the live usage is cited as `file:line` and dated. A Pattern claims that a shape
  is in use *here*, which stops being true when the usage moves — so a reader must be able to
  re-verify it without trusting the prose. A citation that no longer resolves is caught by
  `tkr op governance.citation_audit`.
- **Written by:** human; candidates surfaced by `knowledge.detect_patterns`.
- **Retention:** bounded — a pattern with no live usage is retired, not accumulated.
