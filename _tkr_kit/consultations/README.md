# Consultations

Settled cross-project consultations — one `<id>.yaml` per exchange between this
project and another registered project.

- **Authoring bar:** written only by `consultation.*`. A consultation records the
  subject, both projects, the snapshot each side read, the dependency the
  initiator pins, the bounds the exchange ran under, every turn, and a close form
  per side (FINDING, AGREED CHANGE, OWNER, ANCHORS). Never hand-authored: the
  bounds and the transition table are what make the record checkable, and a file
  written around them carries neither.
- **Written by:** `consultation.close` / `consultation.file`, via the store's
  promotion step. Nothing else writes here.
- **Retention:** `op` — `consultation.prune` removes settled records past a
  retention window. Declared in `KIT_ACCUMULATION_DIRS`
  (`core/governance/retention-audit.ts`). This directory accumulates by design,
  one file per exchange that happened, and a settled record is the only thing
  that ever stops being worth keeping.

## Two tiers, one writer each

An OPEN consultation lives in `.tkr-kit/work/consultations/` — the ephemeral
run-state tier, where turns append without touching a git-canonical file
mid-exchange. On any terminal transition the record is promoted WHOLE to this
directory and the ephemeral copy is reclaimed, so a record is never readable
from both tiers and never absent from both.

## What is not here

The target project's copy. A consultation is read-only by contract: the only
write it makes to the other project is the work item filed at close, and that
item's provenance names the record that produced it. A second copy in the target
would be a second writer on a home that has one.
