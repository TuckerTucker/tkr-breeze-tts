# Clone and Direction hard-fail at any `cfg_scale` != 1.0

**Date:** 2026-08-31
**Severity:** High — two of the three headline voice modes
**Status:** Open. Verified against the deployed H100; not fixed.
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

## Options

1. **Ship a custom `fast.json`** capturing batch 4 and adding a `ref_edit_tata`
   warmup request. Correct and complete; costs warmup time on an already 166 s
   cold start, and cold start is already the demo's worst interaction.
2. **Pin cfg to 1.0 in the reference modes** and drop Direction as a distinct
   mode. Cheap and honest, but deletes a headline capability.
3. **Disable the fast path for reference modes only** — eager for Clone and
   Direction, fast for Design. Keeps all three modes at the cost of the
   latency claim in two of them.

Option 1 is the only one that keeps both the capability and the claim. It needs
a measurement first: how much does capturing batch 4 add to the 148 s warmup?

## Until then

The UI will offer CFG values in Clone and Direction that cannot succeed. The
gateway refuses over-length input before dispatch but does **not** yet refuse
this combination, so it reaches the GPU and fails there.
