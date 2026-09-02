# Models

Descriptions of what IS: architecture overviews, data-flow maps, subsystem descriptions.

- **Authoring bar:** every volatile claim carries a `verify:` command — a Model without one
  drifts silently (the most-reproduced defect in the DRP corpus review).
- **Written by:** human; the codemap (`_tkr_kit/codemap.yml`) is the machine-maintained Model.
- **Retention:** bounded — replace-on-write; a Model of a torn-down system is deleted, not kept.

## Index

- [`architecture.md`](architecture.md) — current product surface, data flow, deployment posture,
  limits, storage lifetimes, API, and verification commands.
