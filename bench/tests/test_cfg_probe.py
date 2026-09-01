"""The fall-off verdict: derived from samples, never asserted."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bench.cfg_probe import (
    CAPTURED_CFG_SCALES,
    CAPTURED_TOKEN_CEILING,
    COLD_SAMPLE_THRESHOLD_MS,
    LONG_TEXT,
    SHORT_TEXT,
    UNCAPTURED_CFG_SCALES,
    Condition,
    build_finding,
    classify,
    probe_cfg,
    probe_token_ceiling,
    write_finding,
)
from bench.harness import Credentials, LatencyHarness, Sample
from bench.tests.conftest import FakeResponse, FakeTransport


def _condition(
    cfg_scale: float, captured: bool, ttfa: list[float]
) -> Condition:
    return Condition(
        label=f"cfg={cfg_scale}",
        cfg_scale=cfg_scale,
        captured=captured,
        text_chars=len(SHORT_TEXT),
        samples=[Sample(request_class="warm", ttfa_ms=value) for value in ttfa],
    )


def test_a_clear_fall_off_selects_presets() -> None:
    verdict, rationale = classify(
        [_condition(1.0, True, [38, 39, 40]), _condition(4.0, True, [41, 42, 43])],
        [_condition(2.5, False, [310, 320, 330])],
    )
    assert verdict == "presets"
    assert "slider" in rationale


def test_no_fall_off_selects_a_slider() -> None:
    verdict, rationale = classify(
        [_condition(1.0, True, [38, 40, 42]), _condition(4.0, True, [39, 41, 43])],
        [_condition(2.5, False, [39, 41, 40])],
    )
    assert verdict == "slider"
    assert "survives" in rationale


def test_insufficient_separation_is_reported_as_inconclusive() -> None:
    # A 2x median with overlapping distributions is not evidence for either
    # control, and resolving it in one direction would be inventing a result.
    verdict, rationale = classify(
        [_condition(1.0, True, [38, 200])],
        [_condition(2.5, False, [40, 300])],
    )
    assert verdict == "inconclusive"
    assert "conservative" in rationale


def test_too_few_samples_is_inconclusive_not_a_verdict() -> None:
    verdict, rationale = classify(
        [_condition(1.0, True, [38])], [_condition(2.5, False, [300])]
    )
    assert verdict == "inconclusive"
    assert "too few" in rationale


def test_a_cold_sample_mid_run_is_excluded_from_the_comparison() -> None:
    # A cold start is tens of seconds against a millisecond effect; one in the
    # set would swamp it entirely.
    condition = _condition(1.0, True, [38, 39, COLD_SAMPLE_THRESHOLD_MS + 1_000])
    assert condition.warm_ttfa_ms == [38, 39]
    assert condition.stats()["n"] == 2


def test_discarded_samples_never_reach_the_comparison() -> None:
    condition = _condition(1.0, True, [38, 39])
    condition.samples.append(
        Sample(request_class="warm", ok=False, discard_reason="busy")
    )
    assert condition.warm_ttfa_ms == [38, 39]


def test_the_probe_varies_only_cfg_scale(credentials: Credentials, clock) -> None:
    transport = FakeTransport(
        [FakeResponse(chunks=(b"\x00" * 4800,), tick_s=0.04, clock=clock)]
    )
    conditions = probe_cfg(
        LatencyHarness(credentials, transport, clock=clock), repeats=2
    )

    assert [c.cfg_scale for c in conditions] == [
        *CAPTURED_CFG_SCALES,
        *UNCAPTURED_CFG_SCALES,
    ]
    texts = {data["text"] for _, _, data in transport.calls}
    seeds = {data["seed"] for _, _, data in transport.calls}
    cfgs = {data["cfg_scale"] for _, _, data in transport.calls}
    assert len(texts) == 1 and len(seeds) == 1
    assert cfgs == {"1.0", "4.0", "2.5"}


def test_the_token_probe_compares_against_the_captured_ceiling(
    credentials: Credentials, clock
) -> None:
    transport = FakeTransport(
        [FakeResponse(chunks=(b"\x00" * 4800,), tick_s=0.04, clock=clock)]
    )
    result = probe_token_ceiling(
        LatencyHarness(credentials, transport, clock=clock), repeats=2
    )
    assert result["captured_max_tokens"] == CAPTURED_TOKEN_CEILING
    assert result["short"]["text_chars"] == len(SHORT_TEXT)
    assert result["long"]["text_chars"] == len(LONG_TEXT)
    assert len(LONG_TEXT) > 2_000  # comfortably past 512 tokens


def test_the_finding_names_the_control_the_ui_should_render() -> None:
    finding = build_finding(
        [
            _condition(1.0, True, [38, 39, 40]),
            _condition(4.0, True, [41, 42, 43]),
            _condition(2.5, False, [310, 320, 330]),
        ],
        {"captured_max_tokens": CAPTURED_TOKEN_CEILING, "falls_off": True},
    )
    assert finding["verdict"] == "presets"
    assert finding["cfg_control"] == {
        "kind": "presets",
        "values": [1.0, 4.0],
        "default": 1.0,
    }
    assert finding["captured_cfg_scales"] == [1.0, 4.0]


def test_a_slider_verdict_produces_a_slider_control() -> None:
    finding = build_finding(
        [
            _condition(1.0, True, [38, 40, 42]),
            _condition(4.0, True, [39, 41, 43]),
            _condition(2.5, False, [39, 41, 40]),
        ],
        {"falls_off": False},
    )
    assert finding["verdict"] == "slider"
    assert finding["cfg_control"]["kind"] == "slider"


def test_an_inconclusive_verdict_falls_back_to_presets() -> None:
    finding = build_finding(
        [_condition(1.0, True, [38])], {"falls_off": None}
    )
    assert finding["verdict"] == "inconclusive"
    assert finding["cfg_control"]["kind"] == "presets"


def test_the_finding_is_written_where_the_plan_can_cite_it(tmp_path: Path) -> None:
    target = tmp_path / "cfg-falloff.json"
    finding = build_finding(
        [_condition(1.0, True, [38, 39]), _condition(2.5, False, [300, 310])],
        {"falls_off": True},
    )
    assert write_finding(finding, target) == target
    written = json.loads(target.read_text())
    assert written["verdict"] == finding["verdict"]
    assert written["cfg_control"] == finding["cfg_control"]


def test_the_verdict_is_derived_from_samples_not_hardcoded() -> None:
    fast = build_finding(
        [_condition(1.0, True, [38, 39]), _condition(2.5, False, [39, 40])],
        {"falls_off": False},
    )
    slow = build_finding(
        [_condition(1.0, True, [38, 39]), _condition(2.5, False, [300, 310])],
        {"falls_off": True},
    )
    assert fast["verdict"] != slow["verdict"]
