# _tkr_kit/

The **git-canonical plan tier** — the versioned-if-desired half of tkr-kit's
two-directory layout (ADR-019). Its sibling `.tkr-kit/` is machine-local and
gitignored; this directory is not, so you can commit it when you want a history.

What lives here (each created lazily by the skill that owns it):

- `*.yaml` — the plan: `product` → capabilities → features → slices → stories → specs (`/planning`)
- `memory/` — promoted memory: decisions, kept insights and patterns (`knowledge.triage`)
- `codemap.yml` — the "Understand" artifact read to orient (`/codemap`)
- `wireframes/` — design-pipeline wireframe artifacts

`.tkr-kit/` (its sibling) holds the machine-local half: `work/` (findings, runs —
recomputable), `index/` (the Koji derived index — reseedable), `runtime/`
(pids, logs, ports), `vaults/` (encrypted secrets), and project identity.
