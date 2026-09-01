"""The experiment that closes the plan's one open decision.

``configs/fast.json`` captures CUDA graphs at two ``cfg_scale`` values, 1.0 and
4.0, with ``freeze_after_warmup: true``. Reading that file suggests every other
value falls off the fast path — but suggests is not measures, and the UI's CFG
control is either a continuous slider or a pair of presets depending on which
is true. This probe settles it with numbers.

The same ``freeze_after_warmup`` mechanism governs input length (8 graphs at
batch 1 up to 256 tokens, 16 at batch 2 up to 512, against an overall
``MAX_SEQ_LEN`` of 2048), so the length ceiling is probed in the same run.

Warm containers only. A cold start is tens of seconds against a fast-path
difference measured in milliseconds — one cold sample in the set would swamp
the effect entirely.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Final

import structlog

from bench.harness import (
    AuthError,
    Credentials,
    HarnessError,
    HttpxTransport,
    LatencyHarness,
    Sample,
    SpeechRequest,
)

log = structlog.get_logger(__name__)

FINDINGS_DIR: Final[Path] = Path(__file__).resolve().parent / "findings"
FINDING_PATH: Final[Path] = FINDINGS_DIR / "cfg-falloff.json"

# Read from configs/fast.json service.cfg_scales.
CAPTURED_CFG_SCALES: Final[tuple[float, ...]] = (1.0, 4.0)
UNCAPTURED_CFG_SCALES: Final[tuple[float, ...]] = (2.5,)

# Captured input-length ceiling: 512 tokens at branch_batch_size 2.
CAPTURED_TOKEN_CEILING: Final[int] = 512

# Anything slower than this is a cold start, not a cfg effect. The warm figure
# under test is tens of milliseconds; the cold one is tens of seconds. There is
# no ambiguous middle to worry about.
COLD_SAMPLE_THRESHOLD_MS: Final[float] = 5_000.0

# An uncaptured value must be at least this much slower before the difference
# is called real rather than noise.
FALLOFF_RATIO: Final[float] = 1.5

SHORT_TEXT: Final[str] = (
    "It is good to hear your voice again after all this time."
)
# Roughly 700 tokens — comfortably past the 512 captured ceiling and well
# inside the 2048 MAX_SEQ_LEN, so the request is legal but off the fast path.
LONG_TEXT: Final[str] = " ".join([SHORT_TEXT] * 48)


@dataclass
class Condition:
    """Repeated samples taken under one held-constant setting.

    Attributes:
        label: Human-readable name of the condition.
        cfg_scale: The value under test.
        captured: Whether `cfg_scale` is one Modal captured graphs for.
        text_chars: Length of the text used, so the length probe is legible.
        samples: Every sample, discarded ones included.
    """

    label: str
    cfg_scale: float
    captured: bool
    text_chars: int
    samples: list[Sample] = field(default_factory=list)

    @property
    def warm_ttfa_ms(self) -> list[float]:
        """First-audio times from warm, usable samples only."""
        return [
            sample.ttfa_ms
            for sample in self.samples
            if sample.ok
            and sample.ttfa_ms is not None
            and sample.ttfa_ms < COLD_SAMPLE_THRESHOLD_MS
        ]

    def stats(self) -> dict[str, Any]:
        """Summarise the warm samples.

        Returns:
            A JSON-ready mapping, with ``n`` zero when everything was
            discarded.
        """
        values = self.warm_ttfa_ms
        if not values:
            return {
                "label": self.label,
                "cfg_scale": self.cfg_scale,
                "captured": self.captured,
                "text_chars": self.text_chars,
                "n": 0,
            }
        return {
            "label": self.label,
            "cfg_scale": self.cfg_scale,
            "captured": self.captured,
            "text_chars": self.text_chars,
            "n": len(values),
            "ttfa_ms_median": round(statistics.median(values), 2),
            "ttfa_ms_min": round(min(values), 2),
            "ttfa_ms_max": round(max(values), 2),
        }


def classify(
    captured: list[Condition], uncaptured: list[Condition]
) -> tuple[str, str]:
    """Decide whether a continuous CFG slider preserves the latency claim.

    The verdict is derived from the samples, never asserted. Three outcomes,
    and "inconclusive" is a real one: too few samples, or a difference that
    does not clear the noise, is not evidence for either control.

    Args:
        captured: Conditions at `CAPTURED_CFG_SCALES`.
        uncaptured: Conditions at values Modal captured no graph for.

    Returns:
        A ``(verdict, rationale)`` pair, where verdict is ``slider``,
        ``presets`` or ``inconclusive``.
    """
    captured_values = [v for c in captured for v in c.warm_ttfa_ms]
    uncaptured_values = [v for c in uncaptured for v in c.warm_ttfa_ms]

    if len(captured_values) < 2 or len(uncaptured_values) < 2:
        return (
            "inconclusive",
            "too few warm samples to distinguish a real difference from noise; "
            f"captured n={len(captured_values)}, uncaptured n={len(uncaptured_values)}",
        )

    captured_median = statistics.median(captured_values)
    uncaptured_median = statistics.median(uncaptured_values)
    ratio = uncaptured_median / captured_median if captured_median else float("inf")

    # An effect cannot be resolved below the instrument's own noise. If the
    # captured condition — where nothing varied — already spreads by more than
    # the ratio we are looking for, this run cannot answer the question, and
    # saying so is the honest result.
    captured_spread = (
        max(captured_values) / min(captured_values) if min(captured_values) else float("inf")
    )
    if captured_spread >= FALLOFF_RATIO:
        return (
            "inconclusive",
            f"the captured condition alone spreads {captured_spread:.2f}x "
            f"({min(captured_values):.1f}-{max(captured_values):.1f}ms), which is "
            f"wider than the {FALLOFF_RATIO}x effect under test. The run is too "
            "noisy to resolve it — rerun on a quiet warm container. Defaulting "
            "to presets is the conservative reading.",
        )

    # Separation: every uncaptured sample slower than every captured one. This
    # is what turns "the medians differ" into "the distributions do not
    # overlap", which is the claim a UI decision should rest on.
    separated = min(uncaptured_values) > max(captured_values)

    if ratio >= FALLOFF_RATIO and separated:
        return (
            "presets",
            f"uncaptured cfg_scale is {ratio:.2f}x slower to first audio "
            f"({uncaptured_median:.1f}ms vs {captured_median:.1f}ms) with no overlap "
            "between the distributions. A continuous slider would silently "
            "contradict the latency claim at every value between the presets.",
        )
    if ratio < FALLOFF_RATIO and not separated:
        return (
            "slider",
            f"uncaptured cfg_scale is {ratio:.2f}x the captured first-audio time "
            f"({uncaptured_median:.1f}ms vs {captured_median:.1f}ms) and the "
            "distributions overlap. The fast path survives an uncaptured value, "
            "so a continuous control is honest.",
        )
    return (
        "inconclusive",
        f"ratio {ratio:.2f}x with "
        f"{'separated' if separated else 'overlapping'} distributions — the "
        "evidence does not clearly support either control. Defaulting to "
        "presets is the conservative reading.",
    )


def probe_cfg(
    harness: LatencyHarness,
    *,
    repeats: int = 5,
    seed: int = 42,
    text: str = SHORT_TEXT,
) -> list[Condition]:
    """Vary only `cfg_scale`, holding text, instruction and seed constant.

    Args:
        harness: A configured `LatencyHarness`.
        repeats: Samples per condition. Enough to distinguish a real
            difference from noise.
        seed: Held constant, so a difference is attributable to the condition.
        text: Held constant across every condition.

    Returns:
        One `Condition` per cfg value, in captured-then-uncaptured order.
    """
    conditions: list[Condition] = []
    for cfg_scale in (*CAPTURED_CFG_SCALES, *UNCAPTURED_CFG_SCALES):
        captured = cfg_scale in CAPTURED_CFG_SCALES
        condition = Condition(
            label=f"cfg={cfg_scale}{'' if captured else ' (uncaptured)'}",
            cfg_scale=cfg_scale,
            captured=captured,
            text_chars=len(text),
        )
        for _ in range(repeats):
            condition.samples.append(
                harness.measure(
                    SpeechRequest(text=text, cfg_scale=cfg_scale, seed=seed),
                    request_class="warm",
                )
            )
        conditions.append(condition)
        log.info("cfg_probe.condition_done", **condition.stats())
    return conditions


def probe_token_ceiling(
    harness: LatencyHarness, *, repeats: int = 3, seed: int = 42
) -> dict[str, Any]:
    """Compare a short input against one past the captured length ceiling.

    Args:
        harness: A configured `LatencyHarness`.
        repeats: Samples per length.
        seed: Held constant.

    Returns:
        A mapping carrying both conditions and whether the long one fell off.
    """
    short = Condition(
        label="short input", cfg_scale=1.0, captured=True, text_chars=len(SHORT_TEXT)
    )
    long = Condition(
        label=f"input past the {CAPTURED_TOKEN_CEILING}-token ceiling",
        cfg_scale=1.0,
        captured=False,
        text_chars=len(LONG_TEXT),
    )
    for condition, text in ((short, SHORT_TEXT), (long, LONG_TEXT)):
        for _ in range(repeats):
            condition.samples.append(
                harness.measure(
                    SpeechRequest(text=text, cfg_scale=1.0, seed=seed),
                    request_class="warm",
                )
            )

    verdict, rationale = classify([short], [long])
    return {
        "captured_max_tokens": CAPTURED_TOKEN_CEILING,
        "short": short.stats(),
        "long": long.stats(),
        "falls_off": verdict == "presets",
        "rationale": rationale,
    }


def build_finding(
    conditions: list[Condition], token_ceiling: dict[str, Any]
) -> dict[str, Any]:
    """Assemble the recorded finding the UI and the plan both read.

    `cfg_control` is the actionable half: `demo-ui` reads it directly and
    renders the control it names, so the UI is built against evidence rather
    than against a guess. When this file is absent the UI defaults to presets,
    which is the conservative reading.

    Args:
        conditions: Output of `probe_cfg`.
        token_ceiling: Output of `probe_token_ceiling`.

    Returns:
        A JSON-ready finding.
    """
    captured = [c for c in conditions if c.captured]
    uncaptured = [c for c in conditions if not c.captured]
    verdict, rationale = classify(captured, uncaptured)

    if verdict == "slider":
        control: dict[str, Any] = {
            "kind": "slider",
            "min": 1.0,
            "max": 4.0,
            "step": 0.5,
            "default": 1.0,
        }
    else:
        control = {
            "kind": "presets",
            "values": list(CAPTURED_CFG_SCALES),
            "default": 1.0,
        }

    return {
        "schema_version": 1,
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "verdict": verdict,
        "rationale": rationale,
        "cfg_control": control,
        "captured_cfg_scales": list(CAPTURED_CFG_SCALES),
        "conditions": [condition.stats() for condition in conditions],
        "token_ceiling": token_ceiling,
        "samples": [
            asdict(sample) for condition in conditions for sample in condition.samples
        ],
    }


def write_finding(finding: dict[str, Any], path: Path = FINDING_PATH) -> Path:
    """Write the finding where the plan's open decision can cite it by path.

    Args:
        finding: The assembled finding.
        path: Destination. Defaults to `FINDING_PATH`.

    Returns:
        The path written.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(finding, indent=2) + "\n", encoding="utf-8")
    log.info("cfg_probe.finding_written", path=str(path), verdict=finding["verdict"])
    return path


def main(argv: list[str] | None = None) -> int:
    """CLI entry point.

    Args:
        argv: Argument vector. Defaults to `sys.argv[1:]`.

    Returns:
        A process exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--skip-token-probe", action="store_true")
    parser.add_argument("--out", type=Path, default=FINDING_PATH)
    args = parser.parse_args(argv)

    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.JSONRenderer(),
        ]
    )

    try:
        credentials = Credentials.from_env()
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    transport = HttpxTransport()
    harness = LatencyHarness(credentials, transport)
    try:
        # One discarded request first, so the container is unambiguously warm
        # before any sample that counts is taken.
        harness.measure(SpeechRequest(text=SHORT_TEXT), request_class="cold")
        conditions = probe_cfg(harness, repeats=args.repeats, seed=args.seed)
        token_ceiling = (
            {"skipped": True}
            if args.skip_token_probe
            else probe_token_ceiling(harness, seed=args.seed)
        )
    except AuthError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3
    finally:
        transport.close()

    finding = build_finding(conditions, token_ceiling)
    write_finding(finding, args.out)
    print(json.dumps({k: v for k, v in finding.items() if k != "samples"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
