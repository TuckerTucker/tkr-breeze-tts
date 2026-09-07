# Operate the hosted demo

**Trigger:** Hand the demo to someone as a link rather than as a repository and a Mac.
**Rehearsal:** 2026-09-06 — deployed and verified end to end. The sequence below was executed
against Modal, all five post-deploy checks passed, and both proxy unknowns were measured
(`bench/findings/hosting.json`). Two build defects surfaced on the way and are fixed: the image
lacked `structlog`, which `infra/config.py` imports, so the container crash-looped before the
gateway started; and `tsc` emitted to `dist/src/index.js` because the repo tsconfig sets
`rootDir "."`, so `node dist/index.js` was not found. The build-time check now verifies the
entry point, which is what would have caught the second one.

> **Read this before handing out the link.** The hosted demo is **one shared password over one
> shared workspace**. Everyone with the link sees the same voices, the same clips and the same
> history. Anything anyone uploads is audible to everyone else who has the link — and this
> product's whole function is to clone a voice from exactly such a recording. There are no
> accounts and no per-person scoping; that is a deliberate boundary, not an omission.
> `.claude/rules/compliance-triage.md` records the data-handling position and the two open
> retention findings.

## 0. Prerequisites

The synthesis app is deployed and reachable, a `wk-`/`ws-` proxy pair exists, and
`docs/runbooks/local-demo.md` has been followed at least once. Hosting adds a third Modal app
beside synthesis and recognition; it does not replace either, and it does not change them.

## 1. Choose a password and hash it

```bash
node -e "import('@node-rs/argon2').then(a=>a.hash(process.argv[1]).then(console.log))" 'your password here'
```

**Expected observable:** a PHC string beginning `$argon2id$`.

Only the hash is ever deployed. The plaintext exists in your head and belongs in no file, no
image layer, and no environment variable. The gateway refuses at startup anything that is not
an Argon2id hash, so a plaintext pasted here fails immediately rather than at a visitor's
first login — where it would present as "the password is wrong" and send you to check the one
thing that is not broken.

## 2. Create the Secret

```bash
modal secret create breeze-tts-gateway \
  MODAL_ENDPOINT_URL=https://…modal.run \
  MODAL_KEY=wk-… \
  MODAL_SECRET=ws-… \
  GATEWAY_PASSWORD_HASH='$argon2id$…'
```

`MODAL_ASR_URL` is optional and follows the same shape.

**Expected observable:** `modal secret list` shows `breeze-tts-gateway`.

Quote the hash in single quotes. It contains `$` and an unquoted shell will eat parts of it,
producing a hash that is well-formed enough to deploy and impossible to log into.

## 3. Build the UI and deploy

```bash
npm run deploy:hosted
```

That is `npm run build` followed by `modal deploy infra/hosting.py`. The UI must be built
first: the image copies `ui/dist` in, and the build-time check fails the deploy if it is
missing rather than shipping an image whose console is a 404.

**Expected observable:** the image build ends with `hosting image ok: node 20.x, ffmpeg …, UI
present, N finding(s)`, and the deploy prints the app's URL.

## 4. Verify before handing the link to anyone

```bash
BREEZE_DEMO_PASSWORD='your password here' .venv/bin/python -m infra.hosting_deploy_check https://…modal.run
```

**Expected observable:** five `ok` lines. Observed 2026-09-06: all five.

The check asserts an API route is refused without a session; the UI shell **is** served without
one; the login exchange sets a cookie; an API route is then served; and no served byte carries
the proxy pair or a `.modal.run` URL.

The shell being served is the deliberate exemption, not a hole. The password field is part of
the React bundle, so refusing the shell would mean the gate never renders. The shell carries no
credential and no upstream URL, and every route behind it is refused, so an unauthenticated
visitor can load the console frame and complete nothing in it.

If the credential check ever fails, treat the deployment as compromised: rotate the proxy pair
with `modal workspace proxy-tokens create --json`, redeploy, and only then work out how it
escaped.

## 5. Rotate the password

```bash
modal secret create --force breeze-tts-gateway MODAL_ENDPOINT_URL=… GATEWAY_PASSWORD_HASH='$argon2id$…' …
modal deploy infra/hosting.py
```

**Expected observable:** the old password stops working and every existing session ends.

Rotation is a redeploy. There is no revocation list and no session migration, which is the
honest shape of a one-password system: changing the password is how you remove someone's
access, and it removes everyone's at once.

## 6. What a restart does

The two halves are opposite, and this is the pair people get wrong:

| | Survives a restart? | Why |
|---|---|---|
| Saved voices, clips, scripts, references | **Yes** | Written to a mounted `modal.Volume` and read back at startup. |
| Every session | **No** | The session store is an in-memory `Map` by deliberate choice; it dies with the process. |

So a restart signs everyone out and forgets nothing. Visitors re-enter the password and find
their voices where they left them.

**One caveat, stated rather than glossed.** Volume writes commit in the background, so a write
is durable at the next commit and not the moment the gateway answers `200`. A voice saved
seconds before a container is replaced can be lost. With `min_containers=1` a restart is rare,
which makes this narrow — and also makes it the kind of thing that fails exactly once, in
front of someone, long after anyone would think to look for it.

## 7. Read or clear the state Volume

```bash
modal volume ls breeze-tts-hosted-state /
modal volume get breeze-tts-hosted-state /voices ./recovered-voices
modal volume rm -r breeze-tts-hosted-state /voices
```

**Expected observable:** four directories — `clips`, `voices`, `scripts`, `references`.

Clearing `voices` and `scripts` is currently the only bound on either. Both are recorded as open
retention findings in `_tkr_kit/config/retention.yaml`: clips evict oldest-first at 2 GiB and
references expire after 24 hours, but nothing evicts a voice or a script. In a shared workspace
behind a password that gets handed around, nobody's restraint bounds them. Until a mechanism
exists, periodically clearing them by hand is the mechanism.

## 7a. Measured proxy behaviour

Run once after a deploy, and again after any change to the image or the transport:

```bash
BREEZE_DEMO_PASSWORD='…' PYTHONPATH=. .venv/bin/python -m bench.hosting_probe https://…modal.run
```

**Measured 2026-09-06.** Modal's web proxy **streams** — warm, first byte at 592 ms of a
3768 ms response, ratio 0.16. The hosted demo delivers the streaming the local one does, so
`GATEWAY_TRANSPORT` stays on `streaming`. The proxy also passes a full 512 MiB body intact,
so `MAX_AUDIO_UPLOAD_BYTES` needs no change on its account.

**Read the `warm` flag before believing any streaming number.** A cold container spends about
150 s starting the GPU, which makes first-byte track total at a ratio of 0.98 — identical to
what a buffering proxy looks like. The probe warms with a discarded request first and records
which state it measured; a sample marked cold never reports `streams: true`.

The upload probe writes a large staged reference and the streaming probe writes clips. Clear
them afterwards (§7) so the demo starts clean for real visitors.

## 8. Cost shape

`min_containers=1` keeps one **CPU** container resident so the first visitor does not wait for a
container start. What that costs is headroom rather than money.

Modal bills a minimum of 0.125 cores at $0.0000131/core/sec, plus memory at
$0.00000222/GiB/sec. A resident container at that floor:

| RAM | Per hour | Per month (730 h) |
|---|---|---|
| 128 MiB | $0.0069 | **$5.03** |
| 256 MiB | $0.0079 | **$5.76** |
| 512 MiB | $0.0099 | $7.22 |

A Node process serving a small UI sits in the 128–256 MiB band, so call it **$5–6 a month**.
The Starter plan includes **$30/month in credits**, so on the free tier this produces no bill of
its own — it is about 19% of the allowance.

**The number to watch is what it leaves for the GPU,** which shares those credits. At roughly
$3.96/hr warm, $30 buys about **7.6 hours** of H100. The resident gateway takes about $5.76 of
them, so it costs you roughly **87 minutes of H100 time a month**.

That makes it a real trade rather than a free win:

- **Handing the link out regularly?** Keep it. Sparing every first visitor a container start is
  worth 19% of the credits.
- **Link sitting idle for weeks?** `BREEZE_HOSTING_MIN_CONTAINERS=0` before deploying. The first
  visitor then waits a few seconds for the container instead, and you keep the headroom.
  (`max_containers` is *not* adjustable the same way — it is 1 for correctness, because two
  replicas over one Volume would diverge.)

`modal app stop breeze-tts-gateway` when you are done handing the link out entirely.

## What this does not do

- **No accounts.** One password, one workspace, no per-person scoping of any store.
- **No live updates.** Two people in the demo at once see each other's work on refresh, not as
  it happens.
- **No breach response.** If the link and password reach people you did not choose, rotate
  (§5) and clear the Volume (§7).
