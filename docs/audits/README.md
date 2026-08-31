# Audits

Dated, findings-bearing audit records. An audit is a **measurement of the repo against a stated
bar**, producing numbered findings that stay addressable until closed.

Distinct from its neighbours:

| Home | Holds | Not this |
|---|---|---|
| `docs/audits/` | dated measurements + numbered findings | — |
| `docs/adr/` | decisions | an audit records what *is*, not what was decided |
| `docs/drp/` | the doc-review-protocol campaign and its corpora | that campaign's own findings live with it |
| `_review/` | frozen point-in-time reviews of superseded builds | audits here are live work queues |
| `.tkr-kit/work/findings/` | machine-recorded raw findings (gitignored, ephemeral) | audits here are durable and citable |

## Conventions

- **Authoring bar:** a dated measurement against a stated bar, with numbered findings that each
  carry a location and an evidence marker. A claim with neither is not a finding.
- **Written by:** human, or an agent sweep whose output a human re-verifies before it lands.
- **Retention:** unbounded by design — an audit record is the durable trace of what was measured and
  when. Findings are closed in place, never deleted; superseded audits stay for the history.

> **Routing status:** registered as a canonical artifact type in `LAYOUT_HOMES`
> (`core/governance/layout-conformance.ts`) and the `docs/canonical-layout.md` table per
> [ADR-028](../adr/028-audit-records-are-a-canonical-artifact-type.md), so
> `governance.layout_conformance` measures this home (README bar + retention) like every other. This
> closed finding B-15 — the home no longer passes conformance by being invisible to it.

- **One file per audit**, named `YYYY-MM-DD-<slug>.md`.
- **Stable finding IDs** (`A-01`, `B-03`, …) scoped to the file. IDs are never reused or
  renumbered — a withdrawn finding keeps its number and records why.
- **Evidence markers** on every claim: **[V]** verified directly during the pass ·
  **[R]** reported by a sub-agent or reviewer, not independently re-verified ·
  **[W]** withdrawn, with the reason stated.
- **Provenance and maintenance** section closes every file: authored date, HEAD pin, and a table
  of volatile facts mapped to one-line re-verification commands.

Findings are closed by editing the entry in place (status → RESOLVED, with the commit that did
it), not by deleting it. A deleted finding is indistinguishable from one that was never found —
which is the failure mode `2026-07-21-silent-failure-modes.md` exists to document.

## Index

- [`2026-07-21-silent-failure-modes.md`](2026-07-21-silent-failure-modes.md) — code paths whose
  "did nothing" outcome is encoded identically to "nothing to do". 51 findings, 5 detection checks.
