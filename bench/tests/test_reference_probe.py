"""The reference-duration probe: its arithmetic, its walk, and its finding.

No GPU, no network, no deployed service. The transport and the log reader are
both injected, which is the only way these assertions can run in CI.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

from bench.harness import DEFAULT_SAMPLE_RATE, Credentials, LatencyHarness
from bench.reference_probe import (
    PROBE_TEXT,
    SEED_UTTERANCE,
    Rung,
    await_graph_miss,
    Walk,
    branch_mode_for,
    build_finding,
    build_reference,
    find_graph_miss,
    probe_reference_ceiling,
    reference_duration_s,
    wav_from_pcm,
    write_finding,
)
from bench.tests.conftest import FakeResponse, FakeTransport

# One second of silence at the model's own rate.
ONE_SECOND = b"\0" * (DEFAULT_SAMPLE_RATE * 2)

REFUSAL_LOG = """
Capturing CUDA graph for backbone decode...
  File "/opt/breeze-infer/models/backbone_graph.py", line 91, in __call__
    raise RuntimeError(
RuntimeError: backbone prefill CUDA graph (1, 1024) was not declared in the warmup profile
   POST /v1/audio/speech -> 200 OK  (duration: 3.1 s, execution: 0.9 s)
"""

TEXT_ENCODER_LOG = """
RuntimeError: text encoder CUDA graph (2, 640) was not declared in the warmup profile
"""


# ── Arithmetic ───────────────────────────────────────────────────────────────


def test_duration_is_derived_exactly_rather_than_estimated() -> None:
    assert reference_duration_s(ONE_SECOND) == 1.0
    assert reference_duration_s(ONE_SECOND * 4) == 4.0
    assert reference_duration_s(b"") == 0.0


def test_the_wav_header_declares_the_length_it_actually_carries() -> None:
    # A header that lies about its length plays, and it lies — the vendor reads
    # through soundfile, which trusts the declared size.
    wav = wav_from_pcm(ONE_SECOND)
    assert wav[:4] == b"RIFF"
    assert wav[8:12] == b"WAVE"
    (riff_size,) = struct.unpack("<I", wav[4:8])
    (data_size,) = struct.unpack("<I", wav[40:44])
    assert data_size == len(ONE_SECOND)
    assert riff_size == 36 + len(ONE_SECOND)
    assert len(wav) == 44 + len(ONE_SECOND)


def test_the_header_carries_the_models_own_rate_not_a_hardcoded_one() -> None:
    # A wrong rate does not fail — it plays at the wrong speed, and a reference
    # at the wrong speed is a voice the clone will faithfully reproduce.
    (rate,) = struct.unpack("<I", wav_from_pcm(ONE_SECOND, 16_000)[24:28])
    assert rate == 16_000
    (rate,) = struct.unpack("<I", wav_from_pcm(ONE_SECOND)[24:28])
    assert rate == DEFAULT_SAMPLE_RATE


def test_a_reference_and_its_transcript_grow_together() -> None:
    # The vendor requires the transcript to be exact, so they cannot be varied
    # independently. Building them from one repeat count is what keeps the pair
    # true at every rung.
    wav, transcript = build_reference(ONE_SECOND, 3)
    assert reference_duration_s(wav[44:]) == 3.0
    assert transcript.count(SEED_UTTERANCE) == 3


def test_the_branch_mode_names_are_the_vendors_own() -> None:
    # warmup_profile.py maps cfg to a binary mode; anything but exactly 1.0 is
    # dual-branch, and there is nothing keyed on the cfg number itself.
    assert branch_mode_for(1.0) == "no_cfg"
    assert branch_mode_for(2.5) == "single_cfg"
    assert branch_mode_for(4.0) == "single_cfg"


# ── Reading the refusal ──────────────────────────────────────────────────────


def test_the_refusing_stage_is_read_from_the_log_not_inferred() -> None:
    # Which stage refused decides the remedy: the backbone means the audio is
    # too long, the text encoder means the transcript is. Guessing between them
    # would send the operator to trim the wrong thing.
    miss = find_graph_miss(REFUSAL_LOG)
    assert miss is not None
    assert miss["stage"] == "backbone prefill CUDA graph"
    assert (miss["batch"], miss["length"]) == (1, 1024)
    assert "was not declared in the warmup profile" in miss["verbatim"]


def test_a_text_encoder_refusal_is_told_apart_from_a_backbone_one() -> None:
    miss = find_graph_miss(TEXT_ENCODER_LOG)
    assert miss is not None
    assert miss["stage"] == "text encoder CUDA graph"
    assert (miss["batch"], miss["length"]) == (2, 640)


def test_logs_without_a_refusal_read_as_no_refusal_rather_than_a_guess() -> None:
    assert find_graph_miss("breeze service ready load_ms=1.0\n") is None
    assert find_graph_miss("") is None


# ── The walk ─────────────────────────────────────────────────────────────────


def _harness(responses: list[FakeResponse], credentials: Credentials) -> tuple[
    LatencyHarness, FakeTransport
]:
    transport = FakeTransport(responses=responses)
    return LatencyHarness(credentials, transport, sleep=lambda _seconds: None), transport


class ScriptedLogs:
    """A log reader that returns each scripted body in turn, then repeats.

    Modal delivers logs behind the response, so a probe that reads once gets
    the *previous* request's error. Scripting the reads is the only way to
    assert the wait rather than trust it.
    """

    def __init__(self, *bodies: str) -> None:
        self.bodies = list(bodies)
        self.reads = 0
        self.windows: list[str | None] = []

    def __call__(self, _app_name: str, since: str | None = None) -> str:
        self.windows.append(since)
        body = self.bodies[min(self.reads, len(self.bodies) - 1)]
        self.reads += 1
        return body


def _probe(harness: LatencyHarness, **kwargs: object) -> list[Walk]:
    """Run a walk with the real sleep replaced, so tests take no wall time."""
    kwargs.setdefault("read_logs", lambda _name, since=None: "")
    return probe_reference_ceiling(
        harness, sleep=lambda _seconds: None, **kwargs  # type: ignore[arg-type]
    )


def _ok(chunks: list[bytes] | None = None) -> FakeResponse:
    return FakeResponse(chunks=chunks or [b"\0" * 4800])


def _refused() -> FakeResponse:
    # What a frozen-graph miss looks like from the client: a 200, then nothing.
    return FakeResponse(chunks=[])


def test_the_walk_stops_at_the_first_refusal(credentials: Credentials) -> None:
    # Past the ceiling every longer reference fails too, so continuing would
    # spend GPU requests to learn nothing already known.
    harness, transport = _harness([_ok(), _ok(), _refused()], credentials)
    walks = _probe(
        harness,
        pcm=ONE_SECOND,
        repeats=(1, 2, 4, 8, 16),
        cfg_scales=(1.0,),
        read_logs=lambda _name, since=None: REFUSAL_LOG,
    )
    assert len(walks) == 1
    assert [rung.repeats for rung in walks[0].rungs] == [1, 2, 4]
    assert [rung.served for rung in walks[0].rungs] == [True, True, False]


def test_the_ceiling_is_the_last_length_that_served(credentials: Credentials) -> None:
    harness, _ = _harness([_ok(), _ok(), _refused()], credentials)
    walk = _probe(
        harness,
        pcm=ONE_SECOND,
        repeats=(1, 2, 4),
        cfg_scales=(1.0,),
        read_logs=lambda _name, since=None: REFUSAL_LOG,
    )[0]
    # Not the refused length, and not a midpoint between them: the only figure
    # safe to offer is one that was observed to work.
    assert walk.longest_served_s == 2.0
    assert walk.first_refused_s == 4.0
    assert walk.summary()["ceiling_s"] == 2.0


def test_a_refusal_carries_the_graph_shape_that_caused_it(
    credentials: Credentials,
) -> None:
    # Empty at the baseline read, then the refusal lands: the shape is waited
    # for rather than sampled.
    harness, _ = _harness([_refused()], credentials)
    walk = _probe(
        harness,
        pcm=ONE_SECOND,
        repeats=(1,),
        cfg_scales=(1.0,),
        read_logs=ScriptedLogs("", "", REFUSAL_LOG),
    )[0]
    assert walk.rungs[0].graph is not None
    assert walk.rungs[0].graph["stage"] == "backbone prefill CUDA graph"
    assert walk.rungs[0].graph["batch"] == 1


def test_a_stale_error_already_in_the_log_is_never_attributed(
    credentials: Credentials,
) -> None:
    # The defect this closes. Modal's log delivery lags the response, and the
    # response carries nothing — so reading at the moment the stream ends
    # returns the *previous* rung's error. Live, a 35.2s reference was recorded
    # as `(1, 320)` when its real refusal was `(2, 608)`, which also mislabelled
    # the branch batch. A shape attributed to the wrong request is worse than
    # no shape at all, so an unconfirmed refusal stays unattributed.
    harness, _ = _harness([_refused()], credentials)
    walk = _probe(
        harness,
        pcm=ONE_SECOND,
        repeats=(1,),
        cfg_scales=(1.0,),
        read_logs=lambda _name, since=None: "",  # nothing lands in this request's window
    )[0]
    assert walk.rungs[0].served is False
    assert walk.rungs[0].graph is None
    assert "unattributed rather than guessed" in (walk.rungs[0].reason or "")


def test_the_window_is_bounded_by_time_not_by_counting() -> None:
    # Counting misses cannot work: a vendor traceback is around a hundred lines,
    # so a new error pushes an older one out of any fixed tail and the count
    # stays put. Observed live — `modal app logs` unbounded reported 4 errors
    # while `--since 1h` reported 6. Every read therefore asks for a window
    # covering only this request.
    logs = ScriptedLogs("", REFUSAL_LOG)
    miss = await_graph_miss(
        logs, "app", request_started=0.0, sleep=lambda _s: None, clock=lambda: 7.0
    )
    assert miss is not None
    assert miss["stage"] == "backbone prefill CUDA graph"
    # Rounded up with a margin, so clock skew cannot exclude the entry.
    assert logs.windows == ["9s", "9s"]


def test_the_wait_gives_up_rather_than_blocking_forever() -> None:
    logs = ScriptedLogs("")
    assert (
        await_graph_miss(
            logs, "app", request_started=0.0, attempts=3,
            sleep=lambda _s: None, clock=lambda: 1.0,
        )
        is None
    )
    assert logs.reads == 3


def test_each_branch_mode_is_walked_separately(credentials: Credentials) -> None:
    # backbone_prefill is keyed on branch_batch_size exactly as the text
    # encoder is, so a single figure would be wrong for one of the two modes.
    harness, _ = _harness([_ok()], credentials)
    walks = _probe(
        harness,
        pcm=ONE_SECOND,
        repeats=(1,),
        cfg_scales=(1.0, 4.0),
        read_logs=lambda _name, since=None: "",
    )
    assert [walk.branch_mode for walk in walks] == ["no_cfg", "single_cfg"]


def test_every_request_carries_both_halves_of_the_pair(
    credentials: Credentials,
) -> None:
    # The vendor enforces both-or-neither, and sending half would measure that
    # rejection rather than a graph shape.
    harness, transport = _harness([_ok()], credentials)
    _probe(
        harness,
        pcm=ONE_SECOND,
        repeats=(2,),
        cfg_scales=(1.0,),
        read_logs=lambda _name, since=None: "",
    )
    _url, _headers, data = transport.calls[0]
    files = transport.file_parts[0]
    assert files is not None and "ref_audio" in files
    assert data["ref_text"].count(SEED_UTTERANCE) == 2
    # The line asked for stays tiny and constant: a long one would put the text
    # encoder's own ceiling in front of the backbone's.
    assert data["text"] == PROBE_TEXT


def test_a_busy_upstream_is_retried_rather_than_recorded_as_a_ceiling(
    credentials: Credentials,
) -> None:
    # Contention is not a wall. Recording a 409 as a refusal would report a
    # ceiling one rung below the real one, permanently.
    harness, _ = _harness([FakeResponse(status_code=409), _ok()], credentials)
    walk = _probe(
        harness,
        pcm=ONE_SECOND,
        repeats=(1,),
        cfg_scales=(1.0,),
        read_logs=lambda _name, since=None: "",
    )[0]
    assert walk.rungs[0].served is True


# ── The finding ──────────────────────────────────────────────────────────────


def _walk(mode: str, cfg: float, served: list[float], refused: float | None) -> Walk:
    walk = Walk(cfg_scale=cfg, branch_mode=mode)
    for duration in served:
        walk.rungs.append(
            Rung(
                repeats=int(duration),
                cfg_scale=cfg,
                duration_s=duration,
                transcript_chars=10,
                served=True,
            )
        )
    if refused is not None:
        walk.rungs.append(
            Rung(
                repeats=int(refused),
                cfg_scale=cfg,
                duration_s=refused,
                transcript_chars=10,
                served=False,
                graph={
                    "stage": "backbone prefill CUDA graph",
                    "batch": 1,
                    "length": 1024,
                    "verbatim": "…",
                },
            )
        )
    return walk


def test_the_finding_records_a_ceiling_per_mode_never_one_number() -> None:
    finding = build_finding(
        [
            _walk("no_cfg", 1.0, [1.0, 2.0], 4.0),
            _walk("single_cfg", 4.0, [1.0], 2.0),
        ],
        seed_duration_s=1.0,
    )
    assert finding["ceiling_by_branch_mode"] == {"no_cfg": 2.0, "single_cfg": 1.0}


def test_the_offered_maximum_is_the_smaller_of_the_two_modes() -> None:
    # The operator chooses a window before they choose a cfg, so offering the
    # larger figure would offer one that fails in the other mode.
    finding = build_finding(
        [
            _walk("no_cfg", 1.0, [1.0, 2.0, 8.0], 16.0),
            _walk("single_cfg", 4.0, [1.0, 2.0], 4.0),
        ],
        seed_duration_s=1.0,
    )
    assert finding["max_reference_seconds"] == 2.0


def test_a_walk_that_never_refused_is_a_floor_not_a_ceiling() -> None:
    # Reporting "measured" here would let the UI offer a maximum nobody
    # observed a failure above.
    finding = build_finding([_walk("no_cfg", 1.0, [1.0, 2.0], None)], seed_duration_s=1.0)
    assert finding["verdict"] == "unmeasured"
    assert "floor, not a ceiling" in finding["rationale"]


def test_a_mode_that_hit_the_wall_and_one_that_did_not_are_told_apart() -> None:
    # Without this the two figures are the same number with different meanings:
    # one is the longest that works, the other is only the longest tried.
    finding = build_finding(
        [
            _walk("no_cfg", 1.0, [1.0, 2.0], 4.0),
            _walk("single_cfg", 4.0, [1.0, 2.0, 8.0], None),
        ],
        seed_duration_s=1.0,
    )
    assert finding["verdict"] == "partial"
    assert finding["bounded_by_refusal"] == {"no_cfg": True, "single_cfg": False}
    assert "single_cfg" in finding["rationale"]
    # Still safe to act on: the smallest across modes is one that was observed
    # to work in both.
    assert finding["max_reference_seconds"] == 2.0


def test_the_finding_names_the_stage_that_refused() -> None:
    finding = build_finding([_walk("no_cfg", 1.0, [1.0], 2.0)], seed_duration_s=1.0)
    assert finding["verdict"] == "measured"
    assert finding["refusing_stages"] == ["backbone prefill CUDA graph"]
    assert "backbone prefill CUDA graph" in finding["rationale"]


def test_the_finding_says_the_wall_is_hard_rather_than_slow() -> None:
    # Everything downstream must know this is not a limit worth approaching.
    finding = build_finding([_walk("no_cfg", 1.0, [1.0], 2.0)], seed_duration_s=1.0)
    assert "no audio" in finding["rationale"] or "no audio" in finding["mechanism"]
    assert "hard failure" in finding["mechanism"]


def test_the_finding_is_written_where_the_gateway_reads_findings(
    tmp_path: Path,
) -> None:
    path = write_finding({"schema_version": 1}, tmp_path / "reference-ceiling.json")
    assert json.loads(path.read_text())["schema_version"] == 1
    # The name the gateway's findings reader resolves.
    assert path.name == "reference-ceiling.json"
