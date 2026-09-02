# _tkr_kit/

The git-tracked planning and design tier for this project. Its sibling `.tkr-kit/`
is machine-local and gitignored; this directory is committed so planning changes
and implementation evidence have history.

What lives here:

- `*.yaml` — the plan: `product` → capabilities → features → slices → stories → specs
- `memory/` — disposition records promoted from machine-local findings
- `codemap.yml` — the current repository map used for orientation
- `flows/` — historical design-flow snapshots retained with the wireframe pass
- `wireframes/` — historical design-pipeline snapshots, explicitly superseded by the active UI

`.tkr-kit/` (its sibling) holds the machine-local half: `work/` (findings, runs —
recomputable), `index/` (the Koji derived index — reseedable), `runtime/`
(pids, logs, ports), service metadata, and project identity. Its contents are
operational state, not documentation of shipped behavior.
