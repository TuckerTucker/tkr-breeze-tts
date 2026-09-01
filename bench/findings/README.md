# Findings

Recorded measurements. The plan, the brief and the running UI all read this
directory rather than repeating benchmark figures taken on someone else's
hardware.

| File | Written by | Read by |
|---|---|---|
| `latency.json` | `bench/harness.py` | `gateway` → `GET /api/health` (`measured`), so the UI's wake state shows an observed cold-start figure instead of an invented one |
| `cfg-falloff.json` | `bench/cfg_probe.py` | `gateway` → `GET /api/findings`, which decides whether the UI's CFG control is a slider or a pair of presets |

Both files are absent until the probes have run against a deployed endpoint.
That absence is handled rather than papered over:

- The wake state says the duration is **not yet measured**, rather than
  inventing one.
- The CFG control falls back to **discrete presets at the captured 1.0 and
  4.0** — the conservative reading, since presenting a slider whose latency
  behaviour is unverified would silently contradict the claim the demo exists
  to make.

Generate them with:

```bash
python -m bench.harness --warm-runs 5      # → latency.json
python -m bench.cfg_probe --repeats 5      # → cfg-falloff.json
```

Both read the proxy token pair from the repo-root `.env`. Neither shells out to
`modal curl`: it authenticates through local API credentials rather than proxy
headers, which would report Modal's auth round-trip as the model's
time-to-first-audio.
