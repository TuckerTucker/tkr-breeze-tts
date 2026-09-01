"""Latency harness: derivation, classification, discards, and the results file."""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from bench.harness import (
    AuthError,
    Credentials,
    HarnessError,
    LatencyHarness,
    Results,
    Sample,
    SpeechRequest,
    audio_duration_s,
    load_env,
    run,
    scrape_warmup_ms,
    write_results,
)
from bench.tests.conftest import FakeResponse, FakeTransport


def test_duration_derivation_is_exact_against_a_known_byte_count() -> None:
    # Mono s16le at 24kHz: 48000 bytes per second, exactly.
    assert audio_duration_s(48_000, 24_000) == 1.0
    assert audio_duration_s(24_000, 24_000) == 0.5
    assert audio_duration_s(0, 24_000) == 0.0
    # One second of a 10-second clip should not be an estimate.
    assert audio_duration_s(480_000, 24_000) == 10.0


def test_duration_rejects_a_nonsense_sample_rate() -> None:
    with pytest.raises(ValueError):
        audio_duration_s(48_000, 0)


def test_first_audio_is_timed_to_the_first_byte_not_the_last(
    credentials: Credentials, clock
) -> None:
    response = FakeResponse(
        headers={"X-Sample-Rate": "24000", "X-Sample-Format": "s16le"},
        chunks=(b"\x00" * 4800, b"\x00" * 4800, b"\x00" * 4800),
        tick_s=0.1,
        clock=clock,
    )
    harness = LatencyHarness(
        credentials, FakeTransport([response]), clock=clock, sleep=lambda _: None
    )
    sample = harness.measure(SpeechRequest())

    assert sample.ok
    # First chunk arrives after one 0.1s tick; the last after three.
    assert sample.ttfa_ms == pytest.approx(100.0)
    assert sample.wall_ms == pytest.approx(300.0)
    assert sample.audio_bytes == 14_400
    assert sample.duration_s == pytest.approx(0.3)
    assert sample.rtf == pytest.approx(1.0)


def test_the_sample_rate_comes_from_the_upstream_header(
    credentials: Credentials, clock
) -> None:
    response = FakeResponse(
        headers={"X-Sample-Rate": "16000"},
        chunks=(b"\x00" * 32_000,),
        tick_s=0.5,
        clock=clock,
    )
    harness = LatencyHarness(credentials, FakeTransport([response]), clock=clock)
    sample = harness.measure(SpeechRequest())
    assert sample.sample_rate == 16_000
    assert sample.duration_s == pytest.approx(1.0)


def test_every_request_carries_the_proxy_headers(
    credentials: Credentials, clock
) -> None:
    transport = FakeTransport(
        [FakeResponse(chunks=(b"\x00" * 480,), tick_s=0.01, clock=clock)]
    )
    LatencyHarness(credentials, transport, clock=clock).measure(SpeechRequest())

    url, headers, data = transport.calls[0]
    assert url.endswith("/v1/audio/speech")
    assert headers["Modal-Key"] == "wk-testkey"
    assert headers["Modal-Secret"] == "ws-testsecret"
    assert data["cfg_scale"] == "1.0"
    assert data["seed"] == "42"


def test_a_forced_409_is_retried_then_discarded_rather_than_recorded(
    credentials: Credentials, clock
) -> None:
    # 409 measures contention, not speed. It must never enter the sample set.
    busy = [FakeResponse(status_code=409) for _ in range(6)]
    slept: list[float] = []
    harness = LatencyHarness(
        credentials, FakeTransport(busy), clock=clock, sleep=slept.append
    )
    sample = harness.measure(SpeechRequest())

    assert not sample.ok
    assert "409" in (sample.discard_reason or "")
    assert sample.ttfa_ms is None
    assert len(slept) == 5


def test_a_409_that_clears_yields_a_real_sample(
    credentials: Credentials, clock
) -> None:
    harness = LatencyHarness(
        credentials,
        FakeTransport(
            [
                FakeResponse(status_code=409),
                FakeResponse(chunks=(b"\x00" * 4800,), tick_s=0.05, clock=clock),
            ]
        ),
        clock=clock,
        sleep=lambda _: None,
    )
    sample = harness.measure(SpeechRequest())
    assert sample.ok
    assert sample.ttfa_ms == pytest.approx(50.0)


def test_auth_failure_aborts_with_the_remedy_named(
    credentials: Credentials, clock
) -> None:
    harness = LatencyHarness(
        credentials, FakeTransport([FakeResponse(status_code=403)]), clock=clock
    )
    with pytest.raises(AuthError) as excinfo:
        harness.measure(SpeechRequest())
    assert "proxy-tokens create" in str(excinfo.value)


def test_a_truncated_stream_is_discarded_not_reported_as_fast(
    credentials: Credentials, clock
) -> None:
    response = FakeResponse(
        chunks=(b"\x00" * 4800, b"\x00" * 4800),
        tick_s=0.05,
        clock=clock,
        raise_after=1,
    )
    harness = LatencyHarness(credentials, FakeTransport([response]), clock=clock)
    sample = harness.measure(SpeechRequest())
    assert not sample.ok
    assert "aborted" in (sample.discard_reason or "")


def test_an_empty_body_is_discarded(credentials: Credentials, clock) -> None:
    harness = LatencyHarness(
        credentials, FakeTransport([FakeResponse(chunks=())]), clock=clock
    )
    sample = harness.measure(SpeechRequest())
    assert not sample.ok
    assert "no audio" in (sample.discard_reason or "")


def test_cold_and_warm_samples_are_never_merged() -> None:
    results = Results(
        samples=[
            Sample(request_class="cold", ttfa_ms=45_000.0, rtf=90.0),
            Sample(request_class="warm", ttfa_ms=38.0, rtf=0.32),
            Sample(request_class="warm", ttfa_ms=41.0, rtf=0.33),
        ]
    )
    summary = results.summary()
    assert summary["cold"]["n"] == 1
    assert summary["warm"]["n"] == 2
    assert summary["warm"]["ttfa_ms_median"] == pytest.approx(39.5)
    # The cold figure must not contaminate the warm one.
    assert summary["warm"]["ttfa_ms_max"] < 100


def test_discarded_samples_are_reported_but_not_averaged() -> None:
    results = Results(
        samples=[
            Sample(request_class="warm", ttfa_ms=38.0, rtf=0.32),
            Sample(request_class="warm", ok=False, discard_reason="upstream busy"),
        ]
    )
    summary = results.summary()
    assert summary["warm"]["n"] == 1
    assert summary["discarded"] == [{"class": "warm", "reason": "upstream busy"}]


def test_warmup_is_scraped_from_the_vendor_log_line() -> None:
    logs = "starting\nfast warmup: 41234.50 ms\nready\n"
    assert scrape_warmup_ms(logs) == pytest.approx(41234.50)


def test_the_most_recent_warmup_line_wins() -> None:
    logs = "fast warmup: 1.0 ms\nrestart\nfast warmup: 2.0 ms\n"
    assert scrape_warmup_ms(logs) == pytest.approx(2.0)


def test_an_absent_warmup_line_reads_as_not_measured() -> None:
    assert scrape_warmup_ms("no graphs\n") is None


def test_the_results_file_is_written_at_a_stable_path(tmp_path: Path) -> None:
    target = tmp_path / "latency.json"
    written = write_results(
        Results(samples=[Sample(request_class="warm", ttfa_ms=38.0, rtf=0.32)]),
        target,
    )
    assert written == target
    payload = json.loads(target.read_text())
    assert payload["schema_version"] == 1
    assert payload["summary"]["warm"]["n"] == 1
    assert payload["samples"][0]["ttfa_ms"] == 38.0


def test_a_run_forces_cold_then_takes_warm_samples(
    credentials: Credentials, clock
) -> None:
    # The cold response ticks at a realistic cold-start duration: a sample
    # faster than COLD_FLOOR_MS is discarded as not having paid one.
    transport = FakeTransport(
        [
            FakeResponse(chunks=(b"\x00" * 4800,), tick_s=166.0, clock=clock),
            FakeResponse(chunks=(b"\x00" * 4800,), tick_s=0.15, clock=clock),
        ]
    )
    stopped: list[str] = []
    results = run(
        LatencyHarness(credentials, transport, clock=clock),
        warm_runs=3,
        app_name="breeze-tts",
        stopper=lambda name: (stopped.append(name), True)[1],
        log_reader=lambda name: "fast warmup: 41234.50 ms\n",
    )
    assert stopped == ["breeze-tts"]
    assert len(results.of_class("cold")) == 1
    assert results.of_class("cold")[0].ttfa_ms == pytest.approx(166_000.0)
    assert len(results.of_class("warm")) == 3
    assert results.warmup_ms == pytest.approx(41234.50)


def test_no_code_path_shells_out_to_modal_curl() -> None:
    # `modal curl` authenticates through local API credentials rather than
    # proxy headers, and would report Modal's auth round-trip as the model's
    # time-to-first-audio.
    for name in ("harness.py", "cfg_probe.py"):
        source = (Path(__file__).parent.parent / name).read_text()
        module = ast.parse(source)
        for node in ast.walk(module):
            if isinstance(node, ast.List):
                literals = [
                    element.value
                    for element in node.elts
                    if isinstance(element, ast.Constant)
                    and isinstance(element.value, str)
                ]
                assert not (
                    literals[:2] == ["modal", "curl"]
                ), f"{name} shells out to `modal curl`"


def test_credentials_reject_an_api_token_pair() -> None:
    with pytest.raises(HarnessError) as excinfo:
        Credentials.from_env(
            {
                "MODAL_ENDPOINT_URL": "https://example.modal.run",
                "MODAL_KEY": "ak-nope",
                "MODAL_SECRET": "as-nope",
            }
        )
    assert "API token" in str(excinfo.value)


def test_credentials_name_what_is_missing() -> None:
    with pytest.raises(HarnessError) as excinfo:
        Credentials.from_env({"MODAL_ENDPOINT_URL": "https://example.modal.run"})
    message = str(excinfo.value)
    assert "MODAL_KEY" in message and "MODAL_SECRET" in message


def test_dotenv_parsing_ignores_comments_and_strips_quotes(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# a comment\n\nMODAL_KEY=\"wk-quoted\"\nMODAL_SECRET='ws-quoted'\n"
    )
    values = load_env(env_file)
    assert values["MODAL_KEY"] == "wk-quoted"
    assert values["MODAL_SECRET"] == "ws-quoted"


def test_a_warm_sample_that_took_cold_time_is_discarded(
    credentials: Credentials, clock
) -> None:
    """A 90-second 'warm' sample is a cold start that was misclassified.

    Observed live: Modal answered 303 while the container was starting, the
    cold request was discarded as a non-200, and the cold start then landed on
    the first warm request — putting a 90569ms outlier in a set whose median
    was 156ms.
    """
    from bench.harness import COLD_CONTAMINATION_MS

    transport = FakeTransport(
        [FakeResponse(chunks=(b"\x00" * 4800,), tick_s=95.0, clock=clock)]
    )
    results = run(
        LatencyHarness(credentials, transport, clock=clock),
        warm_runs=1,
        measure_cold=False,
        stopper=lambda _name: True,
        log_reader=lambda _name: "",
    )
    assert results.of_class("warm") == []
    assert "cold-start time" in (results.samples[0].discard_reason or "")
    assert COLD_CONTAMINATION_MS == 10_000.0


def test_the_real_transport_follows_redirects() -> None:
    """Modal answers 303 while a container starts; not following it discards
    the cold sample the harness exists to take."""
    source = (Path(__file__).parent.parent / "harness.py").read_text()
    assert "follow_redirects=True" in source


def test_a_cold_sample_too_fast_to_be_cold_is_discarded(
    credentials: Credentials, clock
) -> None:
    """Observed live: `modal container stop` returns before the container is
    gone, so the 'cold' request reached a draining container and measured
    372ms. Recording that would put 'cold start, about 373ms' in the UI."""
    from bench.harness import COLD_FLOOR_MS

    transport = FakeTransport(
        [FakeResponse(chunks=(b"\x00" * 4800,), tick_s=0.37, clock=clock)]
    )
    results = run(
        LatencyHarness(credentials, transport, clock=clock),
        warm_runs=0,
        measure_cold=True,
        stopper=lambda _name: True,
        log_reader=lambda _name: "fast warmup: 154667.72 ms\n",
    )
    assert results.of_class("cold") == []
    assert "too fast" in (results.samples[0].discard_reason or "")
    # The scraped warmup figure survives — it came from the container log, not
    # from the discarded sample.
    assert results.warmup_ms == pytest.approx(154667.72)
    assert COLD_FLOOR_MS == 5_000.0
