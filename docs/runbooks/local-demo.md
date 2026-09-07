# Operate the local demo

**Trigger:** Provision, deploy, measure, or start the single-operator demo.
**Rehearsal:** 2026-09-01 — deployment/browser evidence is recorded in the codemap; local build,
typecheck, and tests are re-run whenever this procedure changes.

## 0. Guided path

```bash
npm run setup
```

**Expected observable:** sections 1, 2, 3 and 5 run in order with each completed step reported
and skipped; the walkthrough asks before deploying, before deploying transcription, and before
measuring (section 4); `.env` is written owner-only with the credential and the deployed URLs
resolved through the Modal SDK. `npm run setup -- --no-start` stops before starting the gateway.
A stopped run names its remedy and resumes on the next invocation.

## 1. Prepare credentials

```bash
modal workspace proxy-tokens create --json
cp .env.example .env
```

Put the deployed synthesis URL in `MODAL_ENDPOINT_URL` and the `wk-`/`ws-` pair in `MODAL_KEY`
and `MODAL_SECRET`. `MODAL_ASR_URL` is optional.

**Expected observable:** the gateway accepts the configuration. An `ak-`/`as-` API token is
rejected at startup with the proxy-token creation command as its remedy.

## 2. Provision and deploy synthesis

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python modal huggingface_hub structlog
modal run infra/weights.py
modal deploy infra/service.py
```

**Expected observable:** the checkpoint verification reports at least 7.6 GB, the image build
reports a 69-graph warmup profile, and the deploy prints the synthesis endpoint URL.

## 3. Optionally provision recognition

```bash
modal run infra/asr_weights.py
modal deploy infra/asr.py
```

**Expected observable:** the recognition model verifies at least 3.0 GB and deploy prints the
ASR endpoint URL. If this step is omitted, reference staging remains available and the transcript
is entered manually.

## 4. Refresh deployment measurements

```bash
.venv/bin/python -m bench.harness --warm-runs 5
.venv/bin/python -m bench.cfg_probe --repeats 5
.venv/bin/python -m bench.reference_probe
```

**Expected observable:** the three JSON files in `bench/findings/` receive a new `measured_at`.
Reject or explain any cold sample that did not actually cross a scale-to-zero boundary; do not
publish it as cold latency.

## 5. Build and run locally

```bash
npm run install:all
npm run build
npm --prefix gateway start
```

Open `http://127.0.0.1:8787`.

**Expected observable:** the gateway logs one local listening URL, reports whether proxy auth is
enforced without waking the GPU, and serves the built UI. Voices and Speak appear in primary
navigation; Scripts remains capability-gated.

The startup line now also names `mode` and `stateRoot`. Locally that reads `mode: local` with
the resolved `.cache` directory — the same information the hosted container uses to make a
Volume that failed to mount visible immediately rather than as a library that forgot every
voice.

Hosting added two optional variables and changed nothing here. `GATEWAY_HOST` defaults to
`127.0.0.1`, so the local gateway stays loopback-only exactly as before, and it refuses any
value that is not a literal address. `GATEWAY_PASSWORD_HASH` unset means no gate is registered
at all — not an open gate, no gate — which is what keeps this procedure byte-for-byte true.
`docs/runbooks/hosted-demo.md` is where those are set deliberately.

## 6. Verify before changing deployment posture

```bash
npm run check
npm run build
```

`npm run check` is typecheck, lint, both TypeScript suites and the Python suite in one command.
It exists because a gate nobody runs is not a gate; the individual scripts (`npm test`,
`npm run test:python`, `npm run typecheck`, `npm run lint`) still work on their own.

**Expected observable:** every suite passes, the UI lint gate reports no errors and no unused
exports, both TypeScript projects typecheck, and Vite emits a production bundle.
