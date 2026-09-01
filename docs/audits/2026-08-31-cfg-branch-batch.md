# Clone and Direction hard-fail at any `cfg_scale` != 1.0

**Date:** 2026-08-31
**Severity:** High — two of the three headline voice modes
**Status:** **Resolved** 2026-08-31 by `infra/extend_warmup_profile.py`. Kept for the mechanism, which is not documented upstream.
**Found by:** driving the demo end to end after deploy (`demo-ui/slice/2`)

## What happens

A Clone or Direction request at any `cfg_scale` other than exactly 1.0 produces
no audio. The container raises and the client sees a truncated stream:

```
RuntimeError: text encoder CUDA graph (4, 32) was not declared in the warmup profile
```

## Why

The text-encoder graph cache is keyed `(batch_size, max_length)`, and
`freeze_after_warmup: true` makes an uncaptured key raise rather than fall back.

The batch size is **branches × segments**:

| template | mode | segments | cfg 1.0 (1 branch) | cfg != 1.0 (2 branches) |
|---|---|---|---|---|
| `tts_instruction` | Design | 1 | batch 1 — captured | batch 2 — captured |
| `ref_edit_tata` | Clone, Direction | 2 | batch 2 — captured | **batch 4 — not captured** |

`configs/fast.json` captures only batch 1 (32..256) and batch 2 (32..512).

The root cause is one line of the shipped profile: `warmup_request` is
hardcoded to `{"template": "tts_instruction", ...}`. **`ref_edit_tata` is never
warmed at all.** It works at cfg 1.0 only by coincidence — its 2 segments
happen to land on a batch-2 graph captured for the *other* template.

`service.cfg_scales: [1.0, 4.0]` is therefore misleading. It selects two cfg
*modes* for the design template; it says nothing about reference modes.

## Evidence

Measured directly against `breeze-tts` on an H100:

| request | result |
|---|---|
| `tts_instruction`, cfg 1.0 | OK, 291 ms |
| `tts_instruction`, cfg 2.5 | OK, 237 ms |
| `tts_instruction`, cfg 4.0 | OK, 152 ms |
| `ref_edit_tata`, cfg 1.0 | OK, 80,640 bytes |
| `ref_edit_tata`, cfg 2.5 | **FAIL** — `(4, 32)` not declared |
| `ref_edit_tata`, cfg 4.0 | **FAIL** — `(4, 32)` not declared |

## Why this matters more than a latency footnote

`cfg_scale` is the only thing separating Clone from Direction — both use the
same template and the same request shape, and the dial is what trades
*preserve the reference voice* against *follow the instruction*. At cfg 1.0
Direction **is** Clone. So Direction is not degraded, it is absent.

The demo's own framing calls this "the most interesting control in the system
and the one the docs explain least". It does not currently work in the two
modes where it means the most.

## Resolution

Only the **text encoder** needed new shapes, which made the fix far smaller
than first estimated. `warmup_from_profile` captures text-encoder graphs
directly from declared `(batch_size, token_length)` pairs rather than by
running the warmup request:

```python
for graph in profile.text_encoder_graphs:
    text_cache.warmup_graph(batch_size=graph.batch_size, ...)
```

So no `ref_edit_tata` warmup request was needed — which is fortunate, because
`SyntheticWarmupRequest` carries only `template/text/instruction/speaker/seed`
and has no audio path to express one. The backbone and depth-decoder stages
build from `cfg_scale_by_batch`, which keys on 1 and 2 regardless of segment
count, so they already covered both templates.

`infra/extend_warmup_profile.py` adds 16 graphs at `batch_size 4`, 32..512,
matching batch 2's ceiling. It patches the vendor's own `configs/fast.json` at
build time rather than shipping a hand-copied replacement, so a bump of
`VENDOR_COMMIT` keeps the vendor's changes and only re-applies the addition.
It is idempotent, and a test asserts it runs after the clone.

### Verified after the fix

| request | before | after |
|---|---|---|
| `ref_edit_tata`, cfg 1.0 | OK | OK — 1.84 s |
| `ref_edit_tata`, cfg 2.5 | **FAIL** | **OK** — ttfa 1165 ms |
| `ref_edit_tata`, cfg 4.0 | **FAIL** | **OK** — ttfa 507 ms |

The dial demonstrably steers again: identical input and seed, varying only cfg,
produced 2.64 s of audio at 1.0 against 1.28 s at 4.0.

### What it cost

| | before | after |
|---|---|---|
| declared graphs | 53 | 69 |
| warmup | 148.6 s | **162.6 s** (+14.0 s, +9.4%) |
| cold start | ~166 s | ~170 s |

Fourteen seconds of warmup to restore two of the three voice modes, on a cold
start the operator pays once per sitting. Taken deliberately, with the
operator's agreement that the times are acceptable.
