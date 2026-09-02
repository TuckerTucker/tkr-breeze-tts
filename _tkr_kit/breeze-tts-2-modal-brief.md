# Breeze TTS 2 demo — technical brief

**Date:** 2026-08-31
**Status:** **Retired after implementation.** Preserved as the dated pre-build investigation; do
not use its provisional decisions or unknowns as current behavior.
**Subject:** A demo web app showcasing [BreezeBlue/Breeze-TTS-2](https://huggingface.co/BreezeBlue/Breeze-TTS-2).
**Shape:** Inference on Modal (NVIDIA GPU), UI local on macOS. Single user.

---

## Current outcome

The shipped system is documented in [`docs/models/architecture.md`](../docs/models/architecture.md).
Material changes from this original investigation are:

| Original investigation | Current implementation |
|---|---|
| No plan or implementation | Product, four capabilities, gateway, UI, infrastructure, and 511 tests are complete |
| 53 vendor graphs | 69 graphs after a batch-4 text-encoder extension |
| Five-minute provisional scaledown | Ten-minute synthesis default; two-minute ASR default |
| Intermediate CFG assumed to leave the fast path | Measured continuous slider; graph selection is binary at 1.0 vs. non-1.0 |
| Warmup and end-to-end behavior unknown | Warm TTFA 161.52 ms, warm RTF 0.3929; graph capture 162.6 s; cold readiness roughly 170 s in logs |
| Three mode-first browser controls proposed | Active UI is task-first: Voices and Speak; Scripts and temporary-reference Speak are capability-gated |

The remainder of this file is intentionally unchanged historical reasoning. Statements such as
"chosen", "still open", and "unmeasured" describe the 2026-08-31 decision point, not repository
HEAD. The [batch-4 audit](../docs/audits/2026-08-31-cfg-branch-batch.md) records the most important
post-build correction.

---

## 1. The subject

| | |
|---|---|
| Params | 3B (`BreezeForConditionalGeneration`), bf16 safetensors |
| Download | ~7.7 GB — 6.9 GB model (2 shards) + 683 MB bundled `audio_tokenizer` |
| Languages | **English + Mandarin only** |
| Output | mono **24 kHz** PCM s16le, streamed in chunks |
| Context | `max_position_embeddings` 2048; codec `codebook_size` 2048 |
| Inference code | `github.com/breezeblue-ai/breeze-tts` (Apache-2.0) |
| Weights licence | **BreezeBlue Research & Non-Commercial** (RESONIA, INC.) |

> An Artificial Analysis post claims 50 languages. The model card and the inference repo both say
> two. Treat the repo as authoritative for *this* checkpoint.

### The four demoable capabilities

| Capability | Driven by | Template |
|---|---|---|
| **Voice cloning** | `ref_audio` + `ref_text` (exact transcript, enforced both-or-neither) | `ref_edit_tata` |
| **Voice design** | `instruction` only — natural-language voice description | `tts_instruction` |
| **Voice direction** | ref audio + instruction, balanced by `cfg_scale` | `ref_edit_tata` |
| **Vocal events** | inline `(laugh)` / `(sigh)` EN, `[笑]` ZH | either |

Cloning and direction are the **same code path**. `breeze_infer/templates.py:115-120` makes
`instruction` a *required field* of `ref_edit_tata` — there is no pure-clone template exposed
(`_ref_clone_tata_segments` exists at line 74 but is never registered in `TEMPLATES`). A "pure"
clone is a clone with a neutral instruction.

`cfg_scale` runs a dual-branch CFG (`_ref_edit_tata_dual_branches`, line 99) trading *preserve the
reference voice* against *follow the instruction*. **This is the most interesting control in the
system and the one the docs explain least.**

---

## 2. Why Modal, and what it buys

The original target was local-on-Mac (M1 Pro / 32 GB). That is blocked hard:

```python
# models/fast_streaming.py:192  — in FastBreezeStreamingRuntime.__init__, unconditional
if self.device.type != "cuda":
    raise RuntimeError("fast streaming requires a CUDA device")
```

Both `infer.py:89` and `breeze_infer/api.py:98` construct that class on every run regardless of the
`--fast-*` flags, so on Apple silicon the CLI and the API both die at startup — not slow, dead.
A second, independent blocker is in §3.1 below.

Moving inference to Modal satisfies the guard, unlocks `models/cudagraph/`, and makes the headline
claim — **<40 ms time-to-first-audio, 0.32 RTF** — actually demoable on the hardware it was
measured on (H100).

---

## 3. Constraints verified in source

These are the non-obvious findings. Each is cited; each changes a design decision.

### 3.1 FlashAttention is mandatory, not optional

The shipped `config.json` sets `text_encoder_config.preferred_attn_implementation =
"flash_attention_2"`. `models/breeze.py:970-987` reads that value directly when constructing the
text encoder.

The `attn_implementation="eager"` passed by `infer.py:73` and `breeze_infer/api.py:79` reaches only
the **backbone** — it never overrides the text encoder. So flash-attn is required on *every* path,
including the one advertised as eager. (`requirements.txt` does not list it; it is Docker-only.)

**Consequence — revised 2026-08-31:** `docker/README.md` builds FlashAttention 2.8.3 from source
with `FLASH_ATTN_CUDA_ARCHS=90` (Hopper only), which would bake GPU choice into the image. **That is
avoidable.** An official prebuilt wheel matches this stack exactly:

```
flash_attn-2.8.3+cu12torch2.9cxx11abiTRUE-cp312-cp312-linux_x86_64.whl
```

torch 2.9 / CUDA 12 / Python 3.12 / x86_64, and the official wheels are built multi-arch. Using it
in place of `docker/build.sh` removes both the from-source build and the arch lock — **GPU type
becomes a config value, not an image property.** Caveats: cp312 is the only Python published for
torch 2.9, so **Python 3.12 is pinned**; and the cxx11abi must match torch's, which is exactly what
`docker/smoke_check.py` exists to catch.

*(Corollary: a future Mac attempt would need this key overridden in `config.json` in addition to
removing the §2 guard. Two blockers, not one.)*

### 3.2 The CUDA graphs are shape-frozen — this constrains the UI

`configs/fast.json` is the warmup profile `--fast-all` replays, with `"freeze_after_warmup": true`:

```
service:              { concurrency: 1, cfg_scales: [1.0, 4.0] }
text_encoder:         batch 1 → 32..256 tokens (step 32)   [8 graphs]
                      batch 2 → 32..512 tokens (step 32)  [16 graphs]
backbone_prefill:     same 24 shapes, keyed branch_batch_size × sequence_length
backbone_decode:      branch_batch_size 1, 2
depth_decoder:        batch_size 1, 2
codec:                num_lanes 1, chunk_frames 1
                                                     — 53 graphs total
```

Three consequences:

- **`cfg_scale` is captured at 1.0 and 4.0 only.** A continuous CFG slider falls off the fast path
  at every other value — correct audio, much worse latency, silently contradicting the headline.
- **Fast path caps at 512 input tokens** (256 at batch 1), against 2048 overall.
- batch 1 = single branch (design, cfg 1.0); batch 2 = dual-branch CFG (clone/direct, cfg 4.0).
  The two service `cfg_scales` map exactly onto the two capability groups.

**Open design fork:** discrete CFG presets that stay fast, vs. a free slider that abandons the
latency story, vs. a custom profile capturing more `cfg_scales` and paying for it in warmup.

### 3.3 Strictly one request at a time

`breeze_infer/api.py:131` takes `_request_lock` non-blocking and returns **409** otherwise;
`fast.json` agrees with `"concurrency": 1`. This matches Modal's default of one input per
container — **do not add `@modal.concurrent`.** For the UI it means *disable*, never *error*.

### 3.4 Other hard numbers

- `MAX_NEW_TOKENS = 1500`, `MAX_SEQ_LEN = 2048` (`api.py:31-32`) — caps utterance length.
- `REPETITION_PENALTY = 1.1`, default `cfg_scale` 1.0, default seed 42.
- `runtime.py:22-29` `resolve_device()` falls back to `"cpu"` and exposes no `--device` flag.
- `qwen-tts==0.1.1` is a pure-Python wheel; deps are ordinary (torch 2.9.1, transformers 4.57.3).

---

## 4. The server surface

```
python -m breeze_infer.api <model_dir> --host 0.0.0.0 --port 7860
```

| Route | Contract |
|---|---|
| `GET /health` | `{status, sample_rate}`; **503 while loading** |
| `POST /v1/audio/speech` | multipart: `text`, `instruction`, `cfg_scale`, `ref_audio`, `ref_text`, `seed` |

Response is a `StreamingResponse` of **raw PCM** — `media_type: audio/pcm`, headers
`X-Sample-Rate`, `X-Sample-Format: s16le`, `Cache-Control: no-store`.

Because this is already a FastAPI app, `@modal.asgi_app()` returning `breeze_infer.api:app` is
close to the entire Modal server. The glue is small; the decisions are elsewhere.

---

## 5. Cold start dominates cost

The economics invert relative to intuition. At H100 ($0.001097/s = **$3.95/hr**) and RTF 0.32:

- a 10-second clip ≈ **3 s of GPU ≈ $0.003**
- a 60-second cold start ≈ **$0.066 — 20× the generation it precedes**

Cold start is three stacked costs: container start, **7.7 GB** off a `modal.Volume` onto the GPU,
then capture of all **53 graphs**. The third is **unmeasured** — the code prints
`fast warmup: {ms}` (`infer.py:95`) and no public number exists.

| Modal dial | Fit here |
|---|---|
| `scaledown_window` (default 60 s, **max 20 min**) | **Chosen: 5 min** — provisional, see §7. One cold start per sitting, warm after |
| `min_containers=1` | Zero cold start, but ~$31.60 for an 8-hour day — torches the $30/mo Starter credit in one sitting |
| `enable_memory_snapshot` | Weaker than it sounds — Modal's docs state snapshots **do not accelerate weight loading from storage**; they skip imports and JIT |
| GPU snapshots (`experimental_options={"enable_gpu_snapshot": True}`) | **Alpha.** Specific landmine: docs warn `torch.cuda.is_available()` during snapshotting breaks later GPU access — which is exactly `runtime.py:27` |

Volume storage for the weights is **free** (1 TiB/month included; $0.09/GiB/mo beyond).

### GPU candidates

| GPU | $/hr | VRAM | Note |
|---|---|---|---|
| **H100** | $3.95 | 80 GB | The benchmarked part. `H100!` pins it against H200 auto-upgrade |
| **L40S** | $1.95 | 48 GB | Modal's inference recommendation |
| **A100-40GB** | $2.10 | 40 GB | — |
| A10 | $1.10 | 24 GB | Exactly at the `--fast-all` 24 GB minimum — no headroom |

`--fast-all` needs ~14.4 GiB actual (eager ~7.7 GiB), so VRAM is not the binding constraint on
anything from A100 up.

---

## 6. Local UI architecture

A browser talking directly to Modal hits three problems simultaneously:

1. Modal web endpoints are **public by default**.
2. `requires_proxy_auth=True` requires `Modal-Key` / `Modal-Secret` headers — putting a secret in
   browser JavaScript.
3. It is cross-origin, and the shipped app configures no CORS.

**A thin local backend collapses all three.** It holds the proxy token so the browser never sees
it, is same-origin so CORS never arises, and gives a natural home for two chores the browser is bad
at:

- **Reference audio.** Mic capture yields WebM/Opus; cloning needs WAV plus an exact transcript.
  `ffmpeg` is already installed locally.
- **Caching.** Generated clips to disk, so re-auditioning a voice costs nothing.

### The last mile is where the demo can lose its point

The endpoint returns raw 24 kHz s16le PCM as a stream. No `<audio src>` can play it.

- Buffer it into a WAV in the local proxy — easy, and **discards the streaming behaviour that is
  the entire reason to be on an H100**.
- Play it as it arrives via Web Audio + AudioWorklet — more work, preserves the headline.

If TTFA is the story, the second is not optional.

**Decided: build both, selected by config.** The paths diverge in the proxy (buffer-then-serve
`audio/wav` vs. pipe through unbuffered) and in the client (an `<audio>` element vs. an AudioWorklet
with a ring buffer doing s16le→f32). Cost is asymmetric — buffered is trivial, streaming is the real
work — so "both" is in practice *the streaming path plus a cheap fallback*. Two things that buys
beyond hedging:

- **A safety net during development.** The demo stays usable while the worklet is still being made
  to behave.
- **A demo affordance.** Toggling the two side by side *is* a demonstration of what streaming buys.
  The flag becomes part of the showcase rather than an implementation detail.

Both modes can share one disk cache: even while streaming, the proxy can tee to disk, so replay of
an already-generated clip is a buffered read either way. **Generation streams; replay is instant.**

---

## 7. Decisions

Settled 2026-08-31:

| Axis | Resolution |
|---|---|
| **Warm mode** | Session-warm, not always-on. `scaledown_window = 5 min`. **Provisional** — set against an unmeasured warmup (§8) |
| **Weights** | On a `modal.Volume`, not baked into the image |
| **Playback** | **Both**, config-selectable — streaming AudioWorklet *and* buffered WAV (§6) |
| **Audience** | Local, single user. Unchanged from original scope |
| **GPU** | H100 to start. Now a config value rather than an image property (§3.1), so low-stakes; revisit only if `min_containers` is ever wanted |

**Still open:**

1. **CFG: discrete presets (1.0 / 4.0) or free slider?** §3.2. Correctly blocked on the cfg
   fall-off measurement in §8 — this is the decision the spike exists to inform.

### Sporadic play makes cold start worse, not better

The demo is a site to be poked at irregularly, not a guided walkthrough. That inverts the usual
amortisation. A guided session pays one cold start and spreads it across twenty minutes; irregular
use means anyone returning after a gap longer than `scaledown_window` pays it **again**. Cold start
is therefore experienced repeatedly — and at ~20× the cost of the generation it precedes, it is the
single interaction most likely to misrepresent a model sold on latency.

This is why the 5-minute window is provisional: it is currently set against an unmeasured warmup. If
warmup lands near 60 s, a six-minute gap costs a minute of waiting for a three-second clip.

Implication for the UI: **be honest about waking up.** "Cold start 45 s → then 38 ms" is both truer
and more interesting than a spinner.

## 8. Unknowns requiring measurement

- **Warmup duration for 53 graphs.** Sets the cold-start budget, and therefore decisions 3 and 4.
- **RTF / TTFA on non-H100 parts.** Unpublished.
- **End-to-end viability.** Nothing here has been run. Every claim in §3 is read from source; no
  claim about *performance* has been observed.

## 9. Licence posture

Code Apache-2.0; **weights research and non-commercial only**. This has more teeth on Modal than it
did locally: an unauthenticated public `.modal.run` endpoint serving these weights is a materially
different act from running them on a laptop. `requires_proxy_auth=True` is posture, not just
hygiene.

---

## Provenance

Findings in §1, §3, §4 are read directly from `github.com/breezeblue-ai/breeze-tts` (shallow clone,
2026-08-31) and the HF `config.json` / file manifest. Findings in §5, §6 are from Modal's own docs
(pricing, cold-start, memory-snapshot, webhooks, proxy-auth, model-weights guides) as of the same
date. Nothing has been executed.

**Repo convention note:** this repo documents `docs/briefs/` as the home for Intents
("design briefs, proposals, target-state sketches"), whose authoring bar is *dated, with the plan
entity it feeds*. Filed in `_tkr_kit/` as directed; no plan entity exists yet to cite.
