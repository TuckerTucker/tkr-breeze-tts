# Findings

Recorded measurements. The plan, the brief and the running UI all read this
directory rather than repeating benchmark figures taken on someone else's
hardware.

| File | Written by | Read by |
|---|---|---|
| `latency.json` | `bench/harness.py` | `gateway` → `GET /api/health` (`measured`). The checked-in file supplies warm TTFA and RTF; its rejected cold sample leaves cold TTFA null |
| `cfg-falloff.json` | `bench/cfg_probe.py` | `gateway` → `GET /api/findings`, which decides whether the UI's CFG control is a slider or a pair of presets |
| `reference-ceiling.json` | `bench/reference_probe.py` | `gateway` → `GET /api/health` and `GET /api/findings`, which cap the UI trim window for the current CFG branch before a request can wake the GPU |

Findings are absent until their probes have run against a deployed endpoint.
That absence is handled rather than papered over:

- The wake state says the duration is **not yet measured**, rather than
  inventing one.
- The CFG control falls back to **discrete presets at the captured 1.0 and
  4.0** — the conservative reading, since presenting a slider whose latency
  behaviour is unverified would silently contradict the claim the demo exists
  to make.
- Reference trimming uses a labelled **10-second conservative maximum** until
  this deployment has a measured branch-specific wall.

The checked-in `latency.json` predates the batch-4 warmup extension. Its warm
TTFA and RTF are still the recorded baseline, but its `warmup_ms` describes the
older capture profile and must not be presented as current. The extended
deployment captured 69 graphs in 162.6 seconds and reached roughly 170 seconds
to ready in container logs; a new client-observed cold TTFA has not yet been
accepted into this file.

Generate them with:

```bash
.venv/bin/python -m bench.harness --warm-runs 5      # → latency.json
.venv/bin/python -m bench.cfg_probe --repeats 5      # → cfg-falloff.json
.venv/bin/python -m bench.reference_probe            # → reference-ceiling.json
```

All three read the proxy token pair from the repo-root `.env`. None shells out to
`modal curl`: it authenticates through local API credentials rather than proxy
headers, which would report Modal's auth round-trip as the model's
time-to-first-audio.
