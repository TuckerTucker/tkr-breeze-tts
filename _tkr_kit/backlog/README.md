# Backlog — the work that keeps the product alive

One YAML file per work item, `<id>.yaml`, git-canonical beside the plan and readable with no
service running. This is the home the `sustainment` capability owns.

## Why this exists separately from the plan

`_tkr_kit/` records how the product was **built**: product → capability → feature → story/slice →
spec. `done` is terminal there by design — every derivation that reads a settled subject depends on
nothing leaving it. So once a capability closes, a bug in its code, a dependency bump, a chore, or
an accepted-debt paydown has nowhere in the hierarchy to go. It goes here instead.

An item is not a smaller slice. A slice is a unit of construction with a territory and a spec; an
item is a commitment to act on something already built.

## The record

| Field | Meaning |
|---|---|
| `id` | `work-<nanoid>`; also the file name |
| `title` | one line — what a report and a gate result name |
| `kind` | `bug` · `chore` · `debt` · `regression` · `dependency` · `follow-up` |
| `severity` | `low` · `medium` · `high` · `critical` |
| `status` | `open` · `accepted` · `in_progress` · `closed` · `declined` |
| `capabilityId` | the capability that owns the anchored code, resolved by declared `paths:` prefix |
| `anchors` | repo-relative paths the work is about — what the gate intersects with the territory under change |
| `provenance` | `{source, ref, fingerprint}` when a signal raised it, keyed by the fingerprint that signal already had |
| `evidence` | `{kind, ref}` — required to close, and persisted so the claim outlives the session |
| `continues` | a settled item this one carries on |
| `remedy` | what clears it, stated for whoever meets it at a gate |

Any key not listed above round-trips untouched, so a field added by hand survives a save.

## Rules that hold here

- **`closed` is terminal.** No transition leaves it. Adjacent work on a closed item becomes a new
  item that `continues` it — the same rule the plan applies to `done`.
- **Closing requires evidence.** A close with no `{kind, ref}` is refused with a remedy naming what
  to supply. `manual` is a first-class kind: an honest attestation beats a sha invented to pass a
  validator.
- **Ownership is declared, never guessed.** An anchor no capability's `paths:` prefix covers is
  skipped with its reason rather than filed under a capability that never agreed to own it.
- **Retention is declared.** This directory accumulates by design; it is registered in
  `KIT_ACCUMULATION_DIRS` with an `op` retention answer, not `exempt`.

## Reaching it

Everything here is reachable headlessly — `tkr work create|get|list|transition|link|close`, the same
`work.*` operations over MCP and HTTP, and the files themselves. The model this capability replaced
had a store and a lifecycle and no route at all, and nothing failed when it shipped that way.
