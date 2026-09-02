# Published assertion register

Last synchronized: 2026-09-01

| Assertion | Reach | Source | Verify | Last verified |
|---|---|---|---|---|
| The browser receives streaming PCM through the local gateway, never the Modal credentials or endpoint | public | `README.md` | `rg -n "this.#fetch" ui/src/api/client.ts` | 2026-09-01 |
| Voices and Speak are active; Scripts and temporary-reference Speak are capability-gated | public | `README.md` | `sed -n '21,50p' ui/src/state/workspace.ts` | 2026-09-01 |
| Synthesis defaults to H100, a 600-second idle window, and proxy auth | public | `README.md` | `sed -n '123,162p;338,386p' infra/config.py` | 2026-09-01 |
| The current warmup profile declares 69 graphs | public | `README.md` | `sed -n '43,79p' infra/extend_warmup_profile.py` | 2026-09-01 |
| Warm TTFA is 161.52 ms median and warm RTF is 0.3929 in the checked-in latency run | public | `README.md` | `jq '.summary.warm' bench/findings/latency.json` | 2026-09-01 |
| Client-observed cold TTFA is not yet measured | public | `README.md` | `jq '.summary.cold' bench/findings/latency.json` | 2026-09-01 |
| The current automated suite totals 511 tests | internal | `README.md` | `npm test && npm run test:python` | 2026-09-01 |
