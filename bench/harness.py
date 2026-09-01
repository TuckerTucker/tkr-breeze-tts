"""Latency harness: first-audio time, real-time factor, cold versus warm.

Every performance number in the brief is read from someone else's H100 run.
This replaces them with numbers measured against *this* deployment, which is
the only kind the UI is allowed to display.

**Why not ``modal curl``.** It authenticates with local API credentials rather
than proxy headers, and its own help says API-based authentication adds latency
and that the command is for experimentation and debugging. It is a fine smoke
test before the gateway exists and a false instrument afterwards: using it here
would report Modal's auth round-trip as the model's time-to-first-audio. The
harness therefore speaks HTTP directly, carrying the ``Modal-Key`` /
``Modal-Secret`` pair itself.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import time
from collections.abc import Iterator, Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Final, Protocol

import structlog

log = structlog.get_logger(__name__)

REPO_ROOT: Final[Path] = Path(__file__).resolve().parents[1]
ENV_PATH: Final[Path] = REPO_ROOT / ".env"
FINDINGS_DIR: Final[Path] = Path(__file__).resolve().parent / "findings"
RESULTS_PATH: Final[Path] = FINDINGS_DIR / "latency.json"

SPEECH_PATH: Final[str] = "/v1/audio/speech"
HEALTH_PATH: Final[str] = "/health"

# The vendor emits mono s16le: two bytes per sample, one channel.
BYTES_PER_SAMPLE: Final[int] = 2
DEFAULT_SAMPLE_RATE: Final[int] = 24_000

WARMUP_LINE: Final[re.Pattern[str]] = re.compile(r"fast warmup:\s*([0-9.]+)\s*ms")
BUSY_RETRY_DELAY_S: Final[float] = 2.0
BUSY_MAX_RETRIES: Final[int] = 5

# A "warm" sample slower than this took cold-start time and is not a warm
# sample. Warm first-audio is measured in hundreds of milliseconds; a cold one
# is measured in minutes. Averaging the two describes neither.
COLD_CONTAMINATION_MS: Final[float] = 10_000.0

# A "cold" sample faster than this did not pay a cold start. Container startup
# plus a 7.7GB load plus 53 graph captures cannot complete in under a second,
# so a sub-second cold sample means the request reached a container that was
# still draining rather than one that had gone. Recording it would put a
# 373ms figure behind the UI's "cold start, about …" copy, which is precisely
# the dishonesty the wake state exists to avoid.
COLD_FLOOR_MS: Final[float] = 5_000.0

DEFAULT_TEXT: Final[str] = (
    "It is good to hear your voice again after all this time."
)
DEFAULT_INSTRUCTION: Final[str] = "Speak clearly and naturally."


class HarnessError(RuntimeError):
    """A condition that makes further measurement meaningless."""


class AuthError(HarnessError):
    """The endpoint rejected the proxy token pair."""


@dataclass(frozen=True)
class SpeechRequest:
    """One synthesis request, as multipart form fields.

    Attributes:
        text: The line to speak.
        instruction: Natural-language voice description.
        cfg_scale: Instruction-following strength. 1.0 and 4.0 are the values
            captured in ``configs/fast.json``.
        seed: Held constant so a difference between samples is attributable to
            the condition rather than to a different draw.
    """

    text: str = DEFAULT_TEXT
    instruction: str = DEFAULT_INSTRUCTION
    cfg_scale: float = 1.0
    seed: int = 42

    def as_form(self) -> dict[str, str]:
        """Render as the multipart fields the vendor route expects."""
        return {
            "text": self.text,
            "instruction": self.instruction,
            "cfg_scale": str(self.cfg_scale),
            "seed": str(self.seed),
        }


@dataclass
class Sample:
    """One measured request.

    Attributes:
        request_class: ``cold`` or ``warm``. Never merged — a cold start is
            three stacked costs and averaging it with a warm request describes
            neither.
        ttfa_ms: Send to first received PCM byte. Measured at the client
            because the value under test is end to end.
        wall_ms: Send to last byte.
        audio_bytes: Total PCM received.
        sample_rate: Taken from the upstream ``X-Sample-Rate`` header.
        duration_s: `audio_bytes / 2 / sample_rate`, derived exactly.
        rtf: `wall_ms / 1000 / duration_s`.
        cfg_scale: The condition this sample was taken under.
        seed: The condition this sample was taken under.
        ok: False when the sample must be discarded rather than reported.
        discard_reason: Why, when `ok` is false.
    """

    request_class: str
    ttfa_ms: float | None = None
    wall_ms: float | None = None
    audio_bytes: int = 0
    sample_rate: int = DEFAULT_SAMPLE_RATE
    duration_s: float | None = None
    rtf: float | None = None
    cfg_scale: float = 1.0
    seed: int = 42
    text_chars: int = 0
    ok: bool = True
    discard_reason: str | None = None


def audio_duration_s(audio_bytes: int, sample_rate: int = DEFAULT_SAMPLE_RATE) -> float:
    """Derive audio duration from a byte count.

    Mono s16le, so exactly two bytes per sample. Derived rather than estimated:
    the real-time factor is a ratio, and an estimated denominator would make
    every RTF in the results file an estimate too.

    Args:
        audio_bytes: Total PCM bytes received.
        sample_rate: Frames per second, from the upstream header.

    Returns:
        Duration in seconds.

    Raises:
        ValueError: If `sample_rate` is not positive.
    """
    if sample_rate <= 0:
        raise ValueError(f"sample_rate must be positive, got {sample_rate}")
    return audio_bytes / BYTES_PER_SAMPLE / sample_rate


class StreamResponse(Protocol):
    """The part of an HTTP streaming response the harness reads."""

    @property
    def status_code(self) -> int:
        """HTTP status."""

    @property
    def headers(self) -> Mapping[str, str]:
        """Response headers, including ``X-Sample-Rate``."""

    def iter_bytes(self) -> Iterator[bytes]:
        """Yield body chunks as they arrive."""

    def read(self) -> bytes:
        """Buffer the whole body. httpx requires this before `.text` on a
        streaming response, and this protocol mirrors httpx rather than
        inventing a friendlier shape — a seam the real library does not
        implement is a seam only the test double can satisfy."""

    @property
    def text(self) -> str:
        """The buffered body, for error reporting."""


class Transport(Protocol):
    """How the harness reaches the endpoint.

    Injected so the timing logic can be tested without a GPU, a network, or a
    deployed service — which is the only way these assertions can run in CI.
    """

    def stream(
        self, url: str, *, headers: Mapping[str, str], data: Mapping[str, str]
    ) -> Any:
        """Open a streaming POST as a context manager yielding a
        `StreamResponse`."""

    def get(self, url: str, *, headers: Mapping[str, str]) -> Any:
        """Issue a plain GET, returning something with `status_code`."""


class HttpxTransport:
    """The real transport. Speaks HTTP directly, never through ``modal curl``."""

    def __init__(self, timeout_s: float = 900.0) -> None:
        import httpx

        # follow_redirects: Modal answers 303 while a container is still
        # starting. httpx does not follow redirects by default, so without this
        # the cold request — the one measurement exists to capture — is
        # discarded as a non-200 and the cold start lands on the *next* request
        # instead, contaminating a warm sample with a 90-second outlier.
        self._client = httpx.Client(timeout=timeout_s, follow_redirects=True)

    def stream(
        self, url: str, *, headers: Mapping[str, str], data: Mapping[str, str]
    ) -> Any:
        return self._client.stream("POST", url, headers=dict(headers), data=dict(data))

    def get(self, url: str, *, headers: Mapping[str, str]) -> Any:
        return self._client.get(url, headers=dict(headers))

    def close(self) -> None:
        """Release the underlying connection pool."""
        self._client.close()


def load_env(path: Path = ENV_PATH) -> dict[str, str]:
    """Read the repo-root ``.env`` into a mapping.

    One file at the root, not one per capability: the gateway and this harness
    authenticate to the same endpoint, and a second copy of a credential is a
    second thing to leak and to rotate.

    Args:
        path: The dotenv file to read.

    Returns:
        The parsed values, with the process environment taking precedence.
    """
    values: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    for key in ("MODAL_ENDPOINT_URL", "MODAL_KEY", "MODAL_SECRET"):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


@dataclass
class Credentials:
    """The proxy auth pair and the endpoint it opens.

    Attributes:
        endpoint: Base URL of the deployed web endpoint.
        key: ``Modal-Key`` header value.
        secret: ``Modal-Secret`` header value.
    """

    endpoint: str
    key: str
    secret: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Credentials:
        """Build from a mapping, validating the token prefixes.

        Args:
            env: Mapping to read. Defaults to the repo-root ``.env`` merged
                with the process environment.

        Returns:
            Validated credentials.

        Raises:
            HarnessError: If a value is absent or is an API token rather than
                a proxy token pair.
        """
        source = load_env() if env is None else env
        endpoint = (source.get("MODAL_ENDPOINT_URL") or "").rstrip("/")
        key = source.get("MODAL_KEY") or ""
        secret = source.get("MODAL_SECRET") or ""
        missing = [
            name
            for name, value in (
                ("MODAL_ENDPOINT_URL", endpoint),
                ("MODAL_KEY", key),
                ("MODAL_SECRET", secret),
            )
            if not value
        ]
        if missing:
            raise HarnessError(
                f"missing {', '.join(missing)} in {ENV_PATH}. "
                "Create a proxy token pair with: "
                "modal workspace proxy-tokens create --json"
            )
        if key.startswith("ak-") or secret.startswith("as-"):
            raise HarnessError(
                "MODAL_KEY/MODAL_SECRET carry the ak-/as- prefixes of a workspace "
                "API token, which authenticates to nothing on a proxy-auth "
                "endpoint. Create a proxy token pair instead: "
                "modal workspace proxy-tokens create --json"
            )
        return cls(endpoint=endpoint, key=key, secret=secret)

    @property
    def headers(self) -> dict[str, str]:
        """The two headers every request carries."""
        return {"Modal-Key": self.key, "Modal-Secret": self.secret}


class LatencyHarness:
    """Measures one endpoint, one request at a time."""

    def __init__(
        self,
        credentials: Credentials,
        transport: Transport,
        *,
        clock: Any = time.perf_counter,
        sleep: Any = time.sleep,
    ) -> None:
        """Initialise the harness.

        Args:
            credentials: Endpoint and proxy token pair.
            transport: Injected HTTP transport.
            clock: Monotonic clock returning seconds. Injected for tests.
            sleep: Blocking sleep. Injected so busy-retry is testable without
                real waiting.
        """
        self._credentials = credentials
        self._transport = transport
        self._clock = clock
        self._sleep = sleep

    def measure(
        self, request: SpeechRequest, *, request_class: str = "warm"
    ) -> Sample:
        """Issue one request and time it.

        Args:
            request: The synthesis request.
            request_class: ``cold`` or ``warm``. The caller establishes which;
                the harness records it rather than guessing.

        Returns:
            A `Sample`. A 409 is retried a bounded number of times before being
            discarded, because contention measures the lock, not the model.

        Raises:
            AuthError: On 401/403 — no amount of retrying fixes a wrong token.
        """
        url = f"{self._credentials.endpoint}{SPEECH_PATH}"
        sample = Sample(
            request_class=request_class,
            cfg_scale=request.cfg_scale,
            seed=request.seed,
            text_chars=len(request.text),
        )

        for attempt in range(BUSY_MAX_RETRIES + 1):
            started = self._clock()
            first_byte_at: float | None = None
            received = 0
            sample_rate = DEFAULT_SAMPLE_RATE

            with self._transport.stream(
                url, headers=self._credentials.headers, data=request.as_form()
            ) as response:
                if response.status_code in (401, 403):
                    raise AuthError(
                        f"endpoint rejected the proxy token pair ({response.status_code}). "
                        "Check MODAL_KEY/MODAL_SECRET, or rotate them with: "
                        "modal workspace proxy-tokens create --json"
                    )
                if response.status_code == 409:
                    if attempt < BUSY_MAX_RETRIES:
                        log.info("harness.busy_retry", attempt=attempt + 1)
                        self._sleep(BUSY_RETRY_DELAY_S)
                        continue
                    sample.ok = False
                    sample.discard_reason = (
                        "upstream busy (409) after retries; contention is not latency"
                    )
                    return sample
                if response.status_code != 200:
                    response.read()
                    sample.ok = False
                    sample.discard_reason = (
                        f"upstream returned {response.status_code}: "
                        f"{response.text[:200]}"
                    )
                    return sample

                header_rate = response.headers.get("X-Sample-Rate")
                if header_rate:
                    sample_rate = int(header_rate)

                try:
                    for chunk in response.iter_bytes():
                        if not chunk:
                            continue
                        if first_byte_at is None:
                            first_byte_at = self._clock()
                        received += len(chunk)
                except Exception as exc:  # noqa: BLE001 — recorded, not raised
                    sample.ok = False
                    sample.discard_reason = f"stream aborted: {exc}"
                    return sample

            finished = self._clock()

            if first_byte_at is None or received == 0:
                sample.ok = False
                sample.discard_reason = "no audio received"
                return sample

            sample.sample_rate = sample_rate
            sample.audio_bytes = received
            sample.ttfa_ms = (first_byte_at - started) * 1000.0
            sample.wall_ms = (finished - started) * 1000.0
            sample.duration_s = audio_duration_s(received, sample_rate)
            sample.rtf = (sample.wall_ms / 1000.0) / sample.duration_s
            return sample

        sample.ok = False
        sample.discard_reason = "exhausted busy retries"
        return sample

    def health(self) -> int:
        """GET the vendor health route.

        Returns:
            The HTTP status. 503 means the container is loading; on Modal that
            should not happen, because the load is lifted into ``enter()``.
        """
        response = self._transport.get(
            f"{self._credentials.endpoint}{HEALTH_PATH}",
            headers=self._credentials.headers,
        )
        return int(response.status_code)


def scrape_warmup_ms(logs: str) -> float | None:
    """Pull the vendor's warmup figure out of container logs.

    Args:
        logs: Text from ``modal app logs``.

    Returns:
        The most recent warmup duration in milliseconds, or ``None`` when the
        line is absent — which must read as "not measured", never as zero.
    """
    matches = WARMUP_LINE.findall(logs)
    return float(matches[-1]) if matches else None


def fetch_app_logs(app_name: str = "breeze-tts", lines: int = 500) -> str:
    """Read recent container logs through the Modal CLI.

    ``modal app logs`` is where the vendor's ``fast warmup:`` line surfaces.
    This is a log read, not a request path — the prohibition on ``modal curl``
    is about measuring latency through Modal's API auth, which this does not do.

    Args:
        app_name: The deployed app.
        lines: How many recent lines to ask for.

    Returns:
        The log text, or an empty string if the CLI is unavailable.
    """
    try:
        result = subprocess.run(
            ["modal", "app", "logs", app_name],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning("harness.logs_unavailable", error=str(exc))
        return ""
    return "\n".join((result.stdout or "").splitlines()[-lines:])


def stop_app(app_name: str = "breeze-tts") -> bool:
    """Force the next request to be a cold start, without breaking the app.

    Deliberately **not** ``modal app stop``. That stops the whole *deployment*:
    the web endpoint goes invalid and every subsequent request returns
    ``404 modal-http: invalid function call``, so the harness measures nothing
    and leaves the service down. ``modal container stop`` terminates the
    running container while the deployment stays up, which is the actual thing
    wanted here — the next request finds no warm container and cold-starts.

    Idling past ``scaledown_window`` has the same effect but takes as long as
    the window and is not deterministic.

    Args:
        app_name: The deployed app whose containers should be terminated.

    Returns:
        Whether at least one container was terminated, or none was running.
        Either way the next request is cold.
    """
    try:
        listed = subprocess.run(
            ["modal", "container", "list", "--json"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if listed.returncode != 0:
            log.warning("harness.container_list_failed", stderr=listed.stderr[:200])
            return False

        containers = json.loads(listed.stdout or "[]")
        targets = [
            entry.get("Container ID") or entry.get("container_id") or entry.get("id")
            for entry in containers
            if app_name in json.dumps(entry)
        ]
        targets = [target for target in targets if target]

        if not targets:
            # Nothing running: the next request is already a cold start.
            log.info("harness.no_warm_container", app=app_name)
            return True

        for target in targets:
            subprocess.run(
                # --yes for the same reason as everywhere else in this file:
                # the CLI prompts for confirmation and aborts in a
                # non-interactive shell. Without it the stop silently does
                # nothing, the drain-wait times out, and the "cold" request
                # reaches the container that was never terminated.
                ["modal", "container", "stop", "--yes", target],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
        log.info("harness.containers_stopped", count=len(targets))

        # Termination is asynchronous. Issuing the cold request immediately
        # routes it to a container that is still draining, which measures a
        # warm request and labels it cold.
        for _ in range(60):
            time.sleep(2)
            still = subprocess.run(
                ["modal", "container", "list", "--json"],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            remaining = [
                entry
                for entry in json.loads(still.stdout or "[]")
                if app_name in json.dumps(entry)
            ]
            if not remaining:
                log.info("harness.containers_drained")
                return True
        log.warning("harness.containers_still_running")
        return False
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        log.warning("harness.stop_failed", error=str(exc))
        return False


@dataclass
class Results:
    """The written record of one measurement run.

    Attributes:
        samples: Every sample taken, discarded ones included, so a reader can
            see what was thrown away and why.
        warmup_ms: Scraped from the vendor's log line on the cold run.
        app_name: The deployed app measured.
    """

    samples: list[Sample] = field(default_factory=list)
    warmup_ms: float | None = None
    app_name: str = "breeze-tts"

    def of_class(self, request_class: str) -> list[Sample]:
        """Return the usable samples of one class.

        Args:
            request_class: ``cold`` or ``warm``.

        Returns:
            Samples that were not discarded. Classes are never merged.
        """
        return [
            s for s in self.samples if s.ok and s.request_class == request_class
        ]

    def summary(self) -> dict[str, Any]:
        """Summarise, keeping cold and warm strictly apart.

        Returns:
            A JSON-ready mapping.
        """

        def _stats(samples: list[Sample]) -> dict[str, Any] | None:
            usable = [s for s in samples if s.ttfa_ms is not None]
            if not usable:
                return None
            ttfa = [s.ttfa_ms for s in usable if s.ttfa_ms is not None]
            rtf = [s.rtf for s in usable if s.rtf is not None]
            return {
                "n": len(usable),
                "ttfa_ms_median": round(statistics.median(ttfa), 2),
                "ttfa_ms_min": round(min(ttfa), 2),
                "ttfa_ms_max": round(max(ttfa), 2),
                "rtf_median": round(statistics.median(rtf), 4) if rtf else None,
            }

        return {
            "app": self.app_name,
            "warmup_ms": self.warmup_ms,
            "cold": _stats(self.of_class("cold")),
            "warm": _stats(self.of_class("warm")),
            "discarded": [
                {"class": s.request_class, "reason": s.discard_reason}
                for s in self.samples
                if not s.ok
            ],
        }


def write_results(results: Results, path: Path = RESULTS_PATH) -> Path:
    """Write results where the brief and the plan can cite them by path.

    Args:
        results: The run to record.
        path: Destination. Defaults to `RESULTS_PATH`.

    Returns:
        The path written.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "summary": results.summary(),
        "samples": [asdict(sample) for sample in results.samples],
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    log.info("harness.results_written", path=str(path))
    return path


def run(
    harness: LatencyHarness,
    *,
    warm_runs: int = 5,
    measure_cold: bool = True,
    app_name: str = "breeze-tts",
    request: SpeechRequest | None = None,
    stopper: Any = stop_app,
    log_reader: Any = fetch_app_logs,
) -> Results:
    """Take a cold sample, then a series of warm ones.

    Args:
        harness: The configured harness.
        warm_runs: How many warm samples to take after the container is up.
        measure_cold: Whether to force a cold start first.
        app_name: App to stop and read logs from.
        request: The request held constant across every sample.
        stopper: Injected ``modal app stop``.
        log_reader: Injected ``modal app logs``.

    Returns:
        The completed `Results`.
    """
    speech = request or SpeechRequest()
    results = Results(app_name=app_name)

    if measure_cold:
        if not stopper(app_name):
            log.warning("harness.cold_not_forced", app=app_name)
        cold = harness.measure(speech, request_class="cold")
        if cold.ok and cold.ttfa_ms is not None and cold.ttfa_ms < COLD_FLOOR_MS:
            cold.ok = False
            cold.discard_reason = (
                f"{cold.ttfa_ms:.0f}ms is far too fast to have paid a cold start; "
                "the request reached a container that had not finished draining"
            )
        results.samples.append(cold)
        results.warmup_ms = scrape_warmup_ms(log_reader(app_name))

    for _ in range(warm_runs):
        sample = harness.measure(speech, request_class="warm")
        if (
            sample.ok
            and sample.ttfa_ms is not None
            and sample.ttfa_ms > COLD_CONTAMINATION_MS
        ):
            sample.ok = False
            sample.discard_reason = (
                f"took {sample.ttfa_ms / 1000:.1f}s — cold-start time on a request "
                "classified warm; discarded rather than averaged into the warm set"
            )
        results.samples.append(sample)

    return results


def main(argv: list[str] | None = None) -> int:
    """CLI entry point.

    Args:
        argv: Argument vector. Defaults to `sys.argv[1:]`.

    Returns:
        A process exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--warm-runs", type=int, default=5)
    parser.add_argument("--no-cold", action="store_true", help="skip the cold sample")
    parser.add_argument("--app", default="breeze-tts")
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--cfg-scale", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=Path, default=RESULTS_PATH)
    args = parser.parse_args(argv)

    structlog.configure(
        processors=[structlog.processors.add_log_level, structlog.processors.JSONRenderer()]
    )

    try:
        credentials = Credentials.from_env()
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    transport = HttpxTransport()
    try:
        results = run(
            LatencyHarness(credentials, transport),
            warm_runs=args.warm_runs,
            measure_cold=not args.no_cold,
            app_name=args.app,
            request=SpeechRequest(
                text=args.text, cfg_scale=args.cfg_scale, seed=args.seed
            ),
        )
    except AuthError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3
    finally:
        transport.close()

    write_results(results, args.out)
    print(json.dumps(results.summary(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
