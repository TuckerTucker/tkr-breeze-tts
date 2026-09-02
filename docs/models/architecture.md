# Current architecture

**Date:** 2026-09-01
**Status:** Current implementation model
**Scope:** Repository HEAD, including the active product gates and checked-in measurement evidence

This is the current-state companion to the retired
[pre-implementation brief](../../_tkr_kit/breeze-tts-2-modal-brief.md). It describes what is
built and what the active browser surface exposes; it is not a target-state proposal.

## Product surface

The active browser navigation contains **Voices** and **Speak**. Voices creates and keeps local
reference voices. Speak generates one line with a saved voice, a delivery instruction, CFG, seed,
streaming playback, and clip history.

Scripts, described-voice input in Speak, and temporary-reference input in Speak are implemented
and retain their data, but are dormant behind centralized capability gates. Their backend routes
and tests remain live; they are not currently promised as visible product features.

`verify: sed -n '21,50p' ui/src/state/workspace.ts`

## Runtime shape

```text
browser ── same-origin /api ──► local gateway ── proxy auth ──► Modal TTS ──► H100
   │                                │
   │                                ├─ raw PCM clip cache
   │                                ├─ durable voice library
   │                                ├─ expiring staged references
   │                                └─ script store and sequential cue queue
   └─ AudioWorklet consumes 24 kHz mono s16le PCM incrementally

reference upload ──► gateway normalization ──► optional Modal ASR on L4
                  └─ waveform + timed transcript stored once; selected window trimmed at send
```

The browser uses only relative `/api/*` URLs. The gateway owns `MODAL_KEY`, `MODAL_SECRET`, and
the upstream endpoint; the browser bundle receives none of them. The gateway also serves the
built UI, so there is no cross-origin browser request to configure.

`verify: rg -n "this.#fetch" ui/src/api/client.ts`

## Modal services

| Service | Default GPU | Idle window | Model | Purpose |
|---|---:|---:|---|---|
| Synthesis | `H100!` | 600 s | Breeze-TTS-2 | Interactive streaming TTS |
| Recognition | `L4` | 120 s | faster-whisper-large-v3 | One-time reference transcription with word times |

Both services mount the same weights Volume and require Modal proxy authentication. They use
separate images, GPUs, and warm windows because their workloads have opposite residency needs.

`verify: sed -n '56,72p;123,162p;212,246p;290,386p' infra/config.py`

The synthesis image patches the pinned vendor `configs/fast.json` at build time with sixteen
batch-4 text-encoder graphs. The deployed profile therefore declares **69 graphs**, not the
vendor profile's original 53. Without this extension, Clone and Direction fail whenever
`cfg_scale != 1.0`.

`verify: sed -n '94,116p' infra/image.py && sed -n '43,79p' infra/extend_warmup_profile.py`

## Measurements and hard limits

| Fact | Current evidence |
|---|---|
| Warm TTFA | 161.52 ms median in the checked-in latency run |
| Warm RTF | 0.3929 median in the checked-in latency run |
| Graph capture | 162.6 s over 69 graphs after the batch-4 extension |
| Cold readiness | Approximately 170 s in container logs; client-observed cold TTFA remains unmeasured |
| CFG control | Continuous 1.0–4.0 slider; graph selection is binary at exactly 1.0 vs. non-1.0 |
| Reference ceiling | 14.08 s at CFG 1.0; 28.16 s above CFG 1.0 |

`bench/findings/latency.json` predates the batch-4 extension. Its warm request figures remain the
checked-in warm baseline, but its `warmup_ms=148597.21` is historical and its attempted cold
sample was discarded. The current graph-capture and readiness figures are recorded in the
[batch-4 audit](../audits/2026-08-31-cfg-branch-batch.md).

`verify: jq '.summary' bench/findings/latency.json && jq '{verdict, cfg_control, token_ceiling}' bench/findings/cfg-falloff.json && jq '{max_reference_seconds, ceiling_by_branch_mode}' bench/findings/reference-ceiling.json`

Text-encoder and backbone-prefill ceilings are separate. The gateway refuses a request before
dispatch when either frozen graph family cannot serve it. Reference audio contributes prompt
codes as well as transcript tokens, which is why reference duration is validated independently
from text length.

`verify: sed -n '240,370p' gateway/src/script.ts`

## Storage lifetimes

| Store | Default | Lifetime |
|---|---|---|
| Clips | `.cache/clips` | Evicted oldest-first at 2 GiB |
| Voices | `.cache/voices` | Durable; owns a WAV copy independent of the source clip |
| References | `.cache/references` | Working material; WAV and transcript sidecar expire together after 24 hours |
| Scripts | `.cache/scripts` | Durable documents; cue audio remains in the clip cache |

`verify: sed -n '240,279p' gateway/src/config.ts`

## Gateway API

| Area | Routes |
|---|---|
| Health | `GET /api/health`, `POST /api/wake`, `GET /api/findings` |
| Speech | `POST /api/speech` |
| References | `POST /api/reference`, `GET /api/reference/:id/audio`, `DELETE /api/reference/:id` |
| Clips | `GET /api/clips`, `GET /api/clips/:id`, `DELETE /api/clips/:id` |
| Voices | `GET /api/voices`, `POST /api/voices`, `PATCH /api/voices/:id`, `DELETE /api/voices/:id`, `GET /api/voices/:id/audio` |
| Scripts | `POST /api/scripts`, `GET /api/scripts`, `GET/PATCH/DELETE /api/scripts/:id`, `PATCH /api/scripts/:id/cues/:cueId`, `PUT /api/scripts/:id/cues`, `POST /api/scripts/:id/run`, `GET /api/scripts/:id/export.vtt`, `GET /api/scripts/:id/export.wav` |

`verify: rg -n "app\.(get|post|put|patch|delete)" gateway/src/index.ts`

Script cue cache identity covers text, voice, instruction, CFG, and seed. Neutral legacy
instructions preserve their old identity; a visible non-neutral delivery instruction always
participates in the key.

`verify: sed -n '146,186p' gateway/src/cache-index.ts`

## Verification posture

The repository currently contains 134 Python tests, 220 gateway tests, and 194 UI tests: 548 in
total. No test needs a GPU, external network, or deployed service. Three gateway tests bind an
ephemeral loopback socket to verify post-header stream failure; reference-intake tests invoke the
real local `ffmpeg`.

`verify: npm test && npm run test:python && npm run typecheck && npm run build`
