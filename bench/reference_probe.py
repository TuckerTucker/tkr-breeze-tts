"""Where the frozen graphs stop accepting reference audio.

`configs/fast.json` captures `backbone_prefill` at the *same 24 shapes* as the
text encoder, keyed on `branch_batch_size` × `sequence_length`. That sequence
carries the reference audio's frames as well as its text, so reference duration
has a hard ceiling and nobody has measured where it is. A trim control offering
sixty seconds against a twelve-second wall is exactly the kind of claim this
project refuses to ship, so the UI reads its maximum from here.

**The wall is a hard failure, not a slowdown.** With `freeze_after_warmup` an
uncaptured shape *raises* inside the graph cache; the connection aborts and no
audio arrives. That is why this walks upward and records the last duration that
served, rather than timing a curve.

**The reference and its transcript grow together, because they must.** The
vendor requires the transcript to be exact, so a longer reference always
carries a longer transcript — which means two ceilings are in play at once, the
text encoder's and the backbone's. Which one binds is not assumed here: the
RuntimeError names the stage that refused, and that message is captured
verbatim from the container log rather than paraphrased. The gateway cannot see
it — upstream answers 200, streams nothing, and closes — so it is read through
``modal app logs``, which is a log read and not a request path.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Final

import structlog

from bench.harness import (
    BYTES_PER_SAMPLE,
    DEFAULT_SAMPLE_RATE,
    FINDINGS_DIR,
    AuthError,
    Credentials,
    HttpxTransport,
    LatencyHarness,
    Sample,
    SpeechRequest,
    fetch_app_logs,
    load_env,
)

log = structlog.get_logger(__name__)

FINDING_PATH: Final[Path] = FINDINGS_DIR / "reference-ceiling.json"

# The sentence the probe builds every reference from. Short, so a repeat count
# maps cleanly onto a duration, and ordinary enough that the model has no
# trouble with it — an unintelligible reference would risk measuring the
# vendor's tolerance for noise rather than a graph shape.
SEED_UTTERANCE: Final[str] = "It is good to hear your voice again, after all this time."

# The line each probe request asks for. Deliberately tiny and constant: the
# quantity under test is the reference, and a long line would put the text
# encoder's own ceiling in the way of the backbone's.
PROBE_TEXT: Final[str] = "Hello there."
PROBE_INSTRUCTION: Final[str] = "Speak clearly and naturally."

# Both branch modes. `warmup_profile.py` maps cfg to a binary mode — exactly
# 1.0 is a single branch, anything else dual — and `backbone_prefill` is keyed
# on branch_batch_size, so one figure would be wrong for one of the two.
PROBE_CFG_SCALES: Final[tuple[float, ...]] = (1.0, 4.0)

# Repeat counts, growing fast enough to find the wall in a handful of requests
# and finely enough that the answer is not "somewhere between 8 and 32".
DEFAULT_REPEATS: Final[tuple[int, ...]] = (1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32)

# The vendor's message when a shape was never captured. The stage name in it is
# the whole point: it says whether the text encoder or the backbone refused.
# How long to wait for a refusal to surface in the container log, and how
# often to look. Modal's delivery lags the response by a second or two.
LOG_POLL_ATTEMPTS: Final[int] = 10
LOG_POLL_DELAY_S: Final[float] = 2.0

GRAPH_MISS: Final[re.Pattern[str]] = re.compile(
    r"RuntimeError:\s*(?P<stage>.+?CUDA graph)\s*\((?P<batch>\d+),\s*(?P<length>\d+)\)"
    r"\s*was not declared in the warmup profile"
)


class ProbeError(RuntimeError):
    """Raised when the probe cannot run at all."""


def wav_from_pcm(pcm: bytes, sample_rate: int = DEFAULT_SAMPLE_RATE) -> bytes:
    """Frame raw mono s16le PCM as a WAV.

    The vendor reads reference audio through ``soundfile``, which does not
    decode a bare PCM stream. Framing happens here rather than at generation
    time for the same reason the gateway frames at read: one on-disk format,
    one place that knows the header.

    Args:
        pcm: Raw little-endian 16-bit mono samples.
        sample_rate: The rate the samples were produced at.

    Returns:
        A complete RIFF/WAVE payload.
    """
    byte_rate = sample_rate * BYTES_PER_SAMPLE
    header = b"".join(
        (
            b"RIFF",
            struct.pack("<I", 36 + len(pcm)),
            b"WAVEfmt ",
            struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, byte_rate, 2, 16),
            b"data",
            struct.pack("<I", len(pcm)),
        )
    )
    return header + pcm


def reference_duration_s(pcm: bytes, sample_rate: int = DEFAULT_SAMPLE_RATE) -> float:
    """Duration of raw PCM, derived exactly rather than estimated.

    Args:
        pcm: Raw little-endian 16-bit mono samples.
        sample_rate: The rate the samples were produced at.

    Returns:
        Seconds.
    """
    return len(pcm) / BYTES_PER_SAMPLE / sample_rate


@dataclass
class Rung:
    """One step of the walk.

    Attributes:
        repeats: How many times the seed utterance was concatenated.
        cfg_scale: The guidance scale, which selects the branch mode.
        duration_s: The reference's exact duration.
        transcript_chars: Length of the transcript that accompanied it.
        served: Whether audio came back.
        reason: Why it did not, when it did not.
        graph: The uncaptured shape, as the container reported it.
        ttfa_ms: First-audio time, when it served.
    """

    repeats: int
    cfg_scale: float
    duration_s: float
    transcript_chars: int
    served: bool = False
    reason: str | None = None
    graph: dict[str, Any] | None = None
    ttfa_ms: float | None = None


@dataclass
class Walk:
    """One branch mode's walk from short to refused.

    Attributes:
        cfg_scale: The guidance scale this walk held.
        branch_mode: ``no_cfg`` or ``single_cfg``, the vendor's own names.
        rungs: Every step attempted, in order.
    """

    cfg_scale: float
    branch_mode: str
    rungs: list[Rung] = field(default_factory=list)

    @property
    def longest_served_s(self) -> float | None:
        """The longest reference that produced audio, or None if none did."""
        served = [rung.duration_s for rung in self.rungs if rung.served]
        return max(served) if served else None

    @property
    def first_refused_s(self) -> float | None:
        """The shortest reference that was refused, or None if none was."""
        refused = [rung.duration_s for rung in self.rungs if not rung.served]
        return min(refused) if refused else None

    def summary(self) -> dict[str, Any]:
        """Render the walk for the finding.

        Returns:
            The two figures a consumer needs, plus every rung behind them.
        """
        return {
            "cfg_scale": self.cfg_scale,
            "branch_mode": self.branch_mode,
            "longest_served_s": self.longest_served_s,
            "first_refused_s": self.first_refused_s,
            # Named so nobody reads the ceiling as an approachable target: the
            # last figure that *worked* is the only safe one to offer.
            "ceiling_s": self.longest_served_s,
            "rungs": [asdict(rung) for rung in self.rungs],
        }


def branch_mode_for(cfg_scale: float) -> str:
    """The vendor's name for the branch mode a cfg value selects.

    Args:
        cfg_scale: The guidance scale.

    Returns:
        ``no_cfg`` for exactly 1.0, ``single_cfg`` otherwise.
    """
    return "no_cfg" if cfg_scale == 1.0 else "single_cfg"


def find_graph_misses(logs: str) -> list[dict[str, Any]]:
    """Pull every uncaptured-shape error out of container logs, in order.

    The stage name is what makes this worth reading rather than inferring: it
    says whether the text encoder refused the transcript or the backbone
    refused the audio, and those have different remedies.

    Args:
        logs: Recent container log text.

    Returns:
        One entry per error, oldest first.
    """
    return [
        {
            "stage": match.group("stage").strip(),
            "batch": int(match.group("batch")),
            "length": int(match.group("length")),
            "verbatim": match.group(0),
        }
        for match in GRAPH_MISS.finditer(logs)
    ]


def find_graph_miss(logs: str) -> dict[str, Any] | None:
    """The most recent uncaptured-shape error, or None.

    Args:
        logs: Recent container log text.

    Returns:
        The newest entry, or None when no such error is present.
    """
    misses = find_graph_misses(logs)
    return misses[-1] if misses else None


def await_graph_miss(
    read_logs: Any,
    app_name: str,
    *,
    request_started: float,
    attempts: int = LOG_POLL_ATTEMPTS,
    delay_s: float = LOG_POLL_DELAY_S,
    sleep: Any = time.sleep,
    clock: Any = time.monotonic,
) -> dict[str, Any] | None:
    """Wait for this request's refusal to reach the container log.

    Two things make the naive read wrong, and both were observed live.

    Modal delivers logs behind the response, and the response carries nothing —
    upstream answers 200, streams no audio, and closes. Reading at the moment
    the stream ends therefore returns the *previous* request's error: a 35.2s
    reference was recorded as ``(1, 320)`` when its real refusal was
    ``(2, 608)``, which mislabelled the branch batch as well as the length.

    Counting misses and waiting for the count to rise does not fix it either. A
    vendor traceback is around a hundred lines, so a new error pushes an older
    one out of any fixed tail and the count stays put. The window is therefore
    bounded by *time* — only entries since this request was issued — which
    makes "this request's error" definitional rather than inferred. The walk is
    serial, so nothing else can be writing into that window.

    Returning None is a real outcome: an unattributed refusal is honest, and a
    stale shape attributed to the wrong request is not.

    Args:
        read_logs: Injected log reader taking ``(app_name, since=...)``.
        app_name: The deployed app.
        request_started: Monotonic timestamp from just before the request.
        attempts: How many times to look.
        delay_s: Seconds between looks.
        sleep: Injected sleep, so the wait is testable without real time.
        clock: Injected monotonic clock.

    Returns:
        The refusal this request caused, or None if none arrived in time.
    """
    for attempt in range(attempts):
        # Recomputed each pass so the window keeps covering the request, and
        # rounded up with a margin for clock skew between here and Modal.
        elapsed = int(clock() - request_started) + 2
        misses = find_graph_misses(read_logs(app_name, since=f"{elapsed}s"))
        if misses:
            return misses[-1]
        if attempt < attempts - 1:
            sleep(delay_s)
    return None


def build_reference(pcm: bytes, repeats: int) -> tuple[bytes, str]:
    """Build a reference of a given length, with the transcript that matches it.

    Concatenation rather than silence padding: silence would hold the
    transcript constant and isolate the audio dimension neatly, but the vendor
    may trim it, and a ceiling measured against audio the model discards is a
    ceiling nobody can use. Repeating real speech keeps the pair honest and
    measures the coupling an operator actually meets — a longer reference
    always carries a longer transcript, because the transcript must be exact.

    Args:
        pcm: One utterance of raw PCM.
        repeats: How many times to repeat it.

    Returns:
        The WAV payload and its exact transcript.
    """
    return (
        wav_from_pcm(pcm * repeats),
        " ".join([SEED_UTTERANCE] * repeats),
    )


def capture_seed_utterance(harness: LatencyHarness) -> bytes:
    """Generate the audio every reference is built from.

    Taken from the service under test rather than shipped as a fixture: the
    reference then carries this model's own sample rate and character, and the
    transcript is exact by construction because it is the line that was asked
    for.

    Args:
        harness: The measuring client.

    Returns:
        Raw PCM for one utterance.

    Raises:
        ProbeError: If the seed generation itself fails, since every rung
            depends on it.
    """
    sample = harness.measure(
        SpeechRequest(
            text=SEED_UTTERANCE,
            instruction=PROBE_INSTRUCTION,
            cfg_scale=1.0,
        ),
        request_class="warm",
    )
    if not sample.ok or not sample.audio_bytes:
        raise ProbeError(
            "could not generate the seed utterance every reference is built "
            f"from: {sample.discard_reason or 'no audio'}"
        )
    # `measure` counts bytes rather than keeping them, so the audio is fetched
    # once more now that the endpoint is known to work. One extra generation,
    # and it keeps the timing path in `measure` free of a buffer it never wants.
    return _fetch_pcm(harness, SEED_UTTERANCE)


def _fetch_pcm(harness: LatencyHarness, text: str) -> bytes:
    """Generate one utterance and keep its bytes.

    Args:
        harness: The measuring client, for its credentials and transport.
        text: The line to speak.

    Returns:
        Raw PCM.

    Raises:
        ProbeError: On any non-200, with the status named.
    """
    credentials = harness._credentials  # noqa: SLF001 — same package, one seam
    transport = harness._transport  # noqa: SLF001
    request = SpeechRequest(text=text, instruction=PROBE_INSTRUCTION, cfg_scale=1.0)
    chunks: list[bytes] = []
    with transport.stream(
        f"{credentials.endpoint}/v1/audio/speech",
        headers=credentials.headers,
        data=request.as_form(),
        files=request.as_files(),
    ) as response:
        if response.status_code != 200:
            response.read()
            raise ProbeError(
                f"seed generation returned {response.status_code}: {response.text[:200]}"
            )
        for chunk in response.iter_bytes():
            if chunk:
                chunks.append(chunk)
    pcm = b"".join(chunks)
    if not pcm:
        raise ProbeError("seed generation returned no audio")
    return pcm


def probe_reference_ceiling(
    harness: LatencyHarness,
    *,
    pcm: bytes,
    repeats: tuple[int, ...] = DEFAULT_REPEATS,
    cfg_scales: tuple[float, ...] = PROBE_CFG_SCALES,
    app_name: str = "breeze-tts",
    read_logs: Any = fetch_app_logs,
    sleep: Any = time.sleep,
) -> list[Walk]:
    """Walk reference duration upward in each branch mode until it is refused.

    Stops a walk at its first refusal. Past the ceiling every longer reference
    fails too, so continuing would spend GPU requests to learn nothing — and
    the figure the UI needs is the last one that *served*.

    Args:
        harness: The measuring client.
        pcm: One utterance of raw PCM, repeated to make each reference.
        repeats: The ladder to climb.
        cfg_scales: One value per branch mode.
        app_name: The deployed app whose logs carry the refusal.
        read_logs: Injected log reader, so this is testable without the CLI.
        sleep: Injected sleep, so waiting for a log line is testable.

    Returns:
        One `Walk` per branch mode.
    """
    walks: list[Walk] = []
    for cfg_scale in cfg_scales:
        walk = Walk(cfg_scale=cfg_scale, branch_mode=branch_mode_for(cfg_scale))
        for count in repeats:
            wav, transcript = build_reference(pcm, count)
            rung = Rung(
                repeats=count,
                cfg_scale=cfg_scale,
                duration_s=round(reference_duration_s(pcm) * count, 3),
                transcript_chars=len(transcript),
            )
            request_started = time.monotonic()
            sample = harness.measure(
                SpeechRequest(
                    text=PROBE_TEXT,
                    instruction=PROBE_INSTRUCTION,
                    cfg_scale=cfg_scale,
                    ref_audio=wav,
                    ref_text=transcript,
                ),
                request_class="warm",
            )
            _record(
                rung,
                sample,
                app_name=app_name,
                read_logs=read_logs,
                request_started=request_started,
                sleep=sleep,
            )
            walk.rungs.append(rung)
            log.info(
                "reference_probe.rung",
                cfg_scale=cfg_scale,
                duration_s=rung.duration_s,
                served=rung.served,
                graph=(rung.graph or {}).get("verbatim"),
            )
            if not rung.served:
                break
        walks.append(walk)
    return walks


def _record(
    rung: Rung,
    sample: Sample,
    *,
    app_name: str,
    read_logs: Any,
    request_started: float,
    sleep: Any,
) -> None:
    """Fill a rung in from the sample the harness produced.

    A refusal is read from the container log, not from the response: upstream
    answers 200, streams nothing, and closes, so the only thing that crosses
    the wire is a truncated body. The log is *waited for* rather than sampled,
    because delivery lags and a shape read too early belongs to the previous
    request.

    Args:
        rung: The rung to fill in.
        sample: What the harness observed.
        app_name: The deployed app whose logs carry the refusal.
        read_logs: Injected log reader.
        request_started: Monotonic timestamp from just before the request.
        sleep: Injected sleep.
    """
    if sample.ok:
        rung.served = True
        rung.ttfa_ms = sample.ttfa_ms
        return

    rung.served = False
    rung.reason = sample.discard_reason
    rung.graph = await_graph_miss(
        read_logs, app_name, request_started=request_started, sleep=sleep
    )
    if rung.graph is None:
        rung.reason = (
            f"{rung.reason}; no matching graph error reached the container log, "
            "so the refusing stage is unattributed rather than guessed"
        )


def build_finding(walks: list[Walk], *, seed_duration_s: float) -> dict[str, Any]:
    """Assemble the recorded finding the gateway and UI read.

    Args:
        walks: One walk per branch mode.
        seed_duration_s: Length of the utterance every reference was built from.

    Returns:
        A JSON-ready finding.
    """
    by_mode = {walk.branch_mode: walk.longest_served_s for walk in walks}
    measured = [value for value in by_mode.values() if value is not None]
    stages = sorted(
        {
            rung.graph["stage"]
            for walk in walks
            for rung in walk.rungs
            if rung.graph
        }
    )

    # A mode is only *measured* if it actually hit the wall. A walk that ran out
    # of ladder produced a figure that is a floor — the longest reference tried
    # — and calling that a ceiling would invite the UI to offer a maximum
    # nobody has seen fail above.
    bounded = {
        walk.branch_mode: walk.first_refused_s is not None for walk in walks
    }
    unbounded = sorted(mode for mode, hit in bounded.items() if not hit)

    if not measured or not any(bounded.values()):
        verdict = "unmeasured"
        rationale = (
            "no reference length was refused within the ladder this run climbed, "
            "so the wall is above the longest reference tried rather than found. "
            "The maximum recorded here is a floor, not a ceiling: extend "
            "--repeats and run again to find it."
        )
    elif unbounded:
        verdict = "partial"
        rationale = (
            "the wall was found in "
            + ", ".join(sorted(mode for mode, hit in bounded.items() if hit))
            + " but not in "
            + ", ".join(unbounded)
            + ", whose figure is the longest reference tried rather than the "
            "longest that works. The offered maximum stays the smallest across "
            "modes, so it is safe either way. "
            + (
                f"The stage that refused was: {', '.join(stages)}."
                if stages
                else ""
            )
        )
    else:
        verdict = "measured"
        rationale = (
            "reference duration was walked upward in each branch mode until the "
            "frozen graph cache raised. The figure recorded per mode is the "
            "longest reference that actually served — the first refusal is one "
            "rung above it and produced no audio at all, so nothing should treat "
            "this as a limit worth approaching. "
            + (
                f"The stage that refused was: {', '.join(stages)}."
                if stages
                else "The refusing stage could not be read from the container log."
            )
        )

    return {
        "schema_version": 1,
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "verdict": verdict,
        "rationale": rationale,
        # The actionable half, and deliberately the *minimum* across modes: the
        # UI does not know which cfg the operator will land on when they choose
        # a window, so offering the larger figure would offer one that fails in
        # the other mode.
        "max_reference_seconds": min(measured) if measured else None,
        "ceiling_by_branch_mode": by_mode,
        # Per mode: did the walk actually reach a refusal, or merely run out of
        # ladder? Without this a floor and a ceiling are the same number.
        "bounded_by_refusal": bounded,
        "refusing_stages": stages,
        "seed_utterance": {
            "text": SEED_UTTERANCE,
            "duration_s": round(seed_duration_s, 3),
        },
        "mechanism": (
            "configs/fast.json captures backbone_prefill at the same 24 shapes as "
            "the text encoder, keyed branch_batch_size x sequence_length. The "
            "sequence carries the reference audio's frames as well as its text, "
            "and the transcript must be exact — so a longer reference pushes on "
            "two frozen stages at once. freeze_after_warmup makes an uncaptured "
            "shape raise rather than fall back, so this is a hard failure that "
            "produces no audio, not a slower path."
        ),
        "walks": [walk.summary() for walk in walks],
    }


def write_finding(finding: dict[str, Any], path: Path = FINDING_PATH) -> Path:
    """Write the finding where the gateway's findings reader resolves it.

    Args:
        finding: The assembled finding.
        path: Destination.

    Returns:
        The path written.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(finding, indent=2) + "\n", encoding="utf-8")
    log.info("reference_probe.written", path=str(path))
    return path


def run(
    *,
    repeats: tuple[int, ...] = DEFAULT_REPEATS,
    cfg_scales: tuple[float, ...] = PROBE_CFG_SCALES,
    app_name: str = "breeze-tts",
) -> dict[str, Any]:
    """Run the probe end to end against the deployed endpoint.

    Args:
        repeats: The ladder to climb.
        cfg_scales: One value per branch mode.
        app_name: The deployed app whose logs carry a refusal.

    Returns:
        The finding.

    Raises:
        ProbeError: If the environment is unusable or the seed cannot be made.
    """
    env = load_env()
    credentials = Credentials.from_env(env)
    transport = HttpxTransport()
    try:
        harness = LatencyHarness(credentials, transport)
        pcm = capture_seed_utterance(harness)
        log.info(
            "reference_probe.seed",
            duration_s=round(reference_duration_s(pcm), 3),
            bytes=len(pcm),
        )
        walks = probe_reference_ceiling(
            harness,
            pcm=pcm,
            repeats=repeats,
            cfg_scales=cfg_scales,
            app_name=app_name,
        )
    finally:
        transport.close()

    finding = build_finding(walks, seed_duration_s=reference_duration_s(pcm))
    write_finding(finding)
    return finding


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point.

    Args:
        argv: Arguments, or None to read ``sys.argv``.

    Returns:
        A process exit code.
    """
    parser = argparse.ArgumentParser(
        description="Measure the longest reference audio the frozen graphs serve."
    )
    parser.add_argument(
        "--repeats",
        type=int,
        nargs="+",
        default=list(DEFAULT_REPEATS),
        help="Repeat counts to climb, shortest first.",
    )
    parser.add_argument(
        "--cfg-scales",
        type=float,
        nargs="+",
        default=list(PROBE_CFG_SCALES),
        help="One value per branch mode; 1.0 is single-branch, anything else dual.",
    )
    parser.add_argument(
        "--app-name",
        default="breeze-tts",
        help="Deployed app whose logs carry the refusal.",
    )
    args = parser.parse_args(argv)

    try:
        finding = run(
            repeats=tuple(args.repeats),
            cfg_scales=tuple(args.cfg_scales),
            app_name=args.app_name,
        )
    except AuthError as exc:
        print(f"auth failed: {exc}")
        return 2
    except ProbeError as exc:
        print(f"probe could not run: {exc}")
        return 1

    print(json.dumps(finding["ceiling_by_branch_mode"], indent=2))
    print(f"max_reference_seconds: {finding['max_reference_seconds']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
