# Breeze TTS 2 — a demo you can hear

A local demo of [BreezeBlue/Breeze-TTS-2](https://huggingface.co/BreezeBlue/Breeze-TTS-2),
a 3B open-weight bilingual (EN/ZH) TTS model. GPU inference runs serverless on
Modal; a local gateway holds the credential and absorbs the audio-format chores;
a browser UI plays 24 kHz PCM **as it arrives**, so the model's latency claim is
demonstrated rather than described.

The design brief, with every constraint cited to vendor source, is
[`_tkr_kit/breeze-tts-2-modal-brief.md`](_tkr_kit/breeze-tts-2-modal-brief.md).

## Shape

```
browser ──► gateway (localhost) ──► Modal ──► GPU
   │             │                    proxy auth at the edge
   │             ├─ holds Modal-Key / Modal-Secret; the browser never sees them
   │             ├─ stages, transcribes and trims reference recordings once
   │             ├─ tees generated PCM to disk while streaming
   │             └─ serves the UI, so CORS never arises
   └─ AudioWorklet plays s16le PCM as it arrives
```

| Directory | What lives there |
|---|---|
| `infra/` | The Modal image, weights Volume, serving class, and deployment config |
| `bench/` | The measurement harness and the cfg fall-off probe; findings land in `bench/findings/` |
| `gateway/` | The local Node service: credential custody, transports, clip cache, voice library, script runner |
| `ui/` | The browser surface: Voices, Speak, and Scripts workspaces; staged reference trimming; streaming playback; wake state; history |

## Getting it running

### 1. Credentials

The service sets `requires_proxy_auth`, which closes the endpoint to everyone
including you until a token pair exists. The pair is CLI-scriptable, not a
dashboard errand:

```bash
modal workspace proxy-tokens create --json     # → a wk-/ws- pair
cp .env.example .env                           # then fill in the three values
```

`MODAL_KEY`/`MODAL_SECRET` must carry the `wk-`/`ws-` prefixes. An `ak-`/`as-`
*API* token authenticates to nothing here; both the gateway and the bench refuse
it at startup rather than letting it surface as a 401 at your first synthesis.

### 2. Deploy the GPU service

```bash
uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python modal huggingface_hub structlog
modal run   infra/weights.py       # one-off: fills the Volume with 7.7 GB of weights
modal deploy infra/service.py      # prints the endpoint URL → MODAL_ENDPOINT_URL
```

Transcription is a **separate app**, so that reference audio can be transcribed
rather than typed. It is optional — without it, intake still works and you type
the transcript yourself:

```bash
modal run   infra/asr_weights.py   # one-off: 3.1 GB onto the *same* Volume
modal deploy infra/asr.py          # prints the endpoint URL → MODAL_ASR_URL
```

Separate because the two want opposite postures. Synthesis is interactive and
holds a 10-minute warm window on an H100; transcription fires once at the start
of a sitting, so it takes an L4 and a 2-minute window — a long one would idle a
GPU through the whole session it is not wanted for. Both read the same proxy
token pair, which is workspace-wide.

GPU type, warm window and auth are one configuration surface in
`infra/config.py`, overridable by environment:

```bash
BREEZE_GPU=L40S BREEZE_SCALEDOWN_WINDOW_S=600 modal deploy infra/service.py
```

Changing the GPU needs **no image rebuild** — FlashAttention comes from a
prebuilt multi-arch wheel rather than the vendor's Hopper-pinned source build.

### 3. Measure, before believing anything

Every latency figure the UI displays is read from `bench/findings/`. Until these
run, the UI says so — it shows "not yet measured" rather than quoting someone
else's H100 benchmark, and it offers the conservative CFG presets rather than a
slider whose behaviour is unverified.

```bash
python -m bench.harness --warm-runs 5   # → bench/findings/latency.json
python -m bench.cfg_probe --repeats 5   # → bench/findings/cfg-falloff.json
python -m bench.reference_probe         # → bench/findings/reference-ceiling.json
```

### 4. Run the demo

```bash
npm --prefix ui install && npm --prefix ui run build
npm --prefix gateway install && npm --prefix gateway start
# → http://127.0.0.1:8787
```

The gateway serves the built UI from its own origin. For UI development,
`npm --prefix ui run dev` proxies `/api` to the gateway instead.

## Tests

```bash
PYTHONPATH=. .venv/bin/python -m pytest infra/tests bench/tests   # 134
npm --prefix gateway test                                          # 171
npm --prefix ui test                                               # 182
```

None of them need a GPU, a network, or a deployed service: the Modal SDK is only
constructed, and every HTTP boundary is injected. The reference-intake tests do
use the real `ffmpeg`, because a container-detection test against a made-up
header would pass while the real thing failed.

## Things worth knowing

**Cold start is the interaction most likely to misrepresent this model.** At
roughly twenty times the cost of the generation it precedes, and paid again
after every gap longer than the scaledown window, hiding it behind a spinner
turns "serverless is waking" into "the model is slow". So it is a named state
carrying its measured duration and the warm figure that follows it.

**Readiness is inferred from idle time, never polled.** `GET /health` on a
scaled-to-zero container *starts* one — polling it to find out whether a cold
start is due would cause the cold start it was checking for, and keep an H100
resident while you read the screen.

**Clips and voices have separate lifetimes on purpose.** Clips are exhaust and
get evicted oldest-first at a size limit. A voice owns its own copy of the
audio, so it survives eviction of the clip it came from. The model has no
saved-voice primitive — no embedding, no voice id — so a voice can only persist
as reference audio plus its exact transcript, and that store is entirely local.

**One request per script cue is forced, not chosen.** The model supports
multi-turn dialogue with a per-turn `speaker_id`, but `breeze_infer/api.py`
exposes only `text`, `instruction`, `cfg_scale`, `ref_audio`, `ref_text` and
`seed`, and `templates.py` hardcodes speaker `S0`. Cues are cached on
text + voice + instruction + cfg + seed, so correcting one line in a forty-line
script costs one GPU request rather than forty. Common voice, delivery, CFG, and
seed behavior live at the script level; explicit cue overrides stay independent.

**Drift is reported, never corrected.** Where a cue came from a timed VTT, the
generated duration is shown against its slot with the difference. There is no
time-stretch and no pitch correction anywhere in this codebase: the three honest
responses are reroll, shorten, or accept.

## Licence posture

The inference code is Apache-2.0. **The weights are BreezeBlue Research &
Non-Commercial.** An unauthenticated public `.modal.run` endpoint serving them
is a materially different act from running them on a laptop, which is why
`requires_proxy_auth` defaults on and the gateway checks at startup that an
unauthenticated request to the endpoint is actually refused.
