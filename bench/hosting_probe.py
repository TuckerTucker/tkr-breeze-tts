"""What Modal's web proxy does to the hosted gateway's two edges.

The hosted deployment carries exactly two empirical unknowns, and neither can be
answered by a unit test because both are properties of the proxy sitting in
front of the container. Both are measured here, against a real deployment,
deliberately invoked — never as part of ``npm test``.

**Streaming is the one that decides whether hosting is worth doing.** This demo
exists so the latency claim is *heard* rather than asserted: locally the gateway
delivers a first byte in 17 ms against a 176 ms total. If Modal's proxy buffers a
``web_server`` response, the hosted demo silently becomes the buffered transport
— no error, no log line, nothing failing — and the whole point evaporates while
everything still appears to work. A first-byte time that tracks the total is a
buffering proxy. The remedy already exists and is configuration:
``GATEWAY_TRANSPORT=buffered`` for the hosted deployment, said plainly in the UI.
A demo honest about being slower is worth more than one quietly slower.

**Upload size is the second.** ``MAX_AUDIO_UPLOAD_BYTES`` is 512 MiB, chosen so a
long reference is uploaded once. Whether the proxy passes a body that large is
unknown. Truncation is the worse outcome of the two, because it presents as a
corrupt reference rather than as a refusal, so the probe distinguishes them and
the finding says which.

Run against a deployment::

    BREEZE_DEMO_PASSWORD='…' .venv/bin/python -m bench.hosting_probe https://…modal.run
"""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Final

import httpx
import structlog

log = structlog.get_logger()

FINDINGS_DIR: Final[Path] = Path(__file__).resolve().parent / "findings"
RESULTS_PATH: Final[Path] = FINDINGS_DIR / "hosting.json"

#: A first-byte time above this fraction of the total says the proxy buffered.
#: Locally the ratio is 17/176 ≈ 0.10; anything approaching 1.0 means the whole
#: response was assembled before the first byte moved.
BUFFERING_RATIO: Final[float] = 0.5


@dataclass(frozen=True)
class StreamingResult:
    """What the proxy did to a streaming response.

    Attributes:
        first_byte_ms: Time from request to the first audio byte.
        total_ms: Time from request to the last.
        bytes_received: How much audio arrived.
        streams: False when first-byte tracks total, i.e. the proxy buffered.
        warm: Whether a warmup request preceded this one. A cold sample cannot
            answer the buffering question at all — the GPU's ~150s start
            dominates the first byte, so the ratio reads 0.98 and looks exactly
            like a buffering proxy. The first run of this probe made precisely
            that mistake, which is why the flag is recorded rather than assumed.
        note: The reading, in words, for whoever reads the finding.
    """

    first_byte_ms: float
    total_ms: float
    bytes_received: int
    streams: bool
    warm: bool
    note: str


@dataclass(frozen=True)
class UploadResult:
    """Where the proxy stops accepting a request body.

    Attributes:
        attempted_bytes: The body size offered.
        accepted: Whether the gateway saw the whole body.
        failure_mode: ``"accepted"``, ``"refused"`` or ``"truncated"``.
        status: The status observed, when there was one.
        note: What this means for MAX_AUDIO_UPLOAD_BYTES.
    """

    attempted_bytes: int
    accepted: bool
    failure_mode: str
    status: int | None
    note: str


#: The vendor has no voice primitive, so a request with no saved voice is a
#: described one — and the gateway requires a delivery instruction for it.
#: A fresh hosted Volume has an empty voice library, which is exactly the state
#: this probe runs in, so the default has to carry one.
DEFAULT_INSTRUCTION: Final[str] = "A calm, measured narrator with a warm tone."


def measure_streaming(
    client: httpx.Client, base: str, text: str, voice_id: str | None,
    instruction: str = DEFAULT_INSTRUCTION, warm: bool = True,
) -> StreamingResult:
    """Time the first audio byte against the whole response.

    Args:
        client: An authenticated client, carrying the session cookie.
        base: The deployment's base URL.
        text: A line long enough that generation takes meaningfully longer than
            the first chunk — a two-word line would not separate the two times.
        voice_id: A saved voice to speak with, when the workspace has one.

    Returns:
        The measured times and the reading drawn from them.
    """
    # JSON, not form-encoding: gateway/src/index.ts readSpeechFields accepts
    # multipart (what the browser sends, because a reference is a file) or JSON
    # (so the route is reachable from a shell). Nothing parses urlencoded.
    body: dict[str, object] = {
        "text": text,
        "instruction": instruction,
        "cfgScale": 1.0,
        "seed": 1,
    }
    if voice_id:
        body["voiceId"] = voice_id

    started = time.perf_counter()
    first_byte_at: float | None = None
    received = 0

    with client.stream("POST", f"{base}/api/speech", json=body) as response:
        if response.status_code >= 400:
            response.read()
            raise RuntimeError(
                f"the gateway refused the probe request with {response.status_code}: "
                f"{response.text[:300]}"
            )
        for chunk in response.iter_bytes():
            if not chunk:
                continue
            if first_byte_at is None:
                first_byte_at = time.perf_counter()
            received += len(chunk)
    finished = time.perf_counter()

    first_byte_ms = ((first_byte_at or finished) - started) * 1000
    total_ms = (finished - started) * 1000
    ratio = first_byte_ms / total_ms if total_ms > 0 else 1.0
    streams = ratio < BUFFERING_RATIO

    note = (
        f"first byte at {first_byte_ms:.0f}ms of a {total_ms:.0f}ms response "
        f"(ratio {ratio:.2f}, {'warm' if warm else 'COLD — not a valid reading'}). "
        + (
            "The proxy streams; the hosted demo delivers the latency the local one does."
            if streams
            else "The proxy BUFFERED. The hosted demo is effectively on the buffered "
            "transport. Set GATEWAY_TRANSPORT=buffered for the hosted deployment and "
            "say so in the UI rather than shipping a quietly slower demo."
        )
    )
    return StreamingResult(
        first_byte_ms=round(first_byte_ms, 1),
        total_ms=round(total_ms, 1),
        bytes_received=received,
        streams=streams and warm,
        warm=warm,
        note=note,
    )


def _silent_wav(total_bytes: int) -> bytes:
    """Build a valid mono 24 kHz s16le WAV of roughly `total_bytes`.

    Args:
        total_bytes: Target size including the 44-byte header.

    Returns:
        A parseable WAV carrying silence.
    """
    import struct

    rate, channels, bits = 24_000, 1, 16
    data_bytes = max(0, total_bytes - 44) & ~1
    byte_rate = rate * channels * bits // 8
    header = (
        b"RIFF" + struct.pack("<I", 36 + data_bytes) + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, channels, rate, byte_rate, channels * bits // 8, bits)
        + b"data" + struct.pack("<I", data_bytes)
    )
    return header + b"\0" * data_bytes


def measure_upload_ceiling(client: httpx.Client, base: str, size_bytes: int) -> UploadResult:
    """Offer a body of `size_bytes` and record what came back.

    Truncation and refusal are distinguished deliberately: a refusal names a
    real number at the boundary, while a truncated body presents to a visitor as
    a corrupt reference and is the worse of the two.

    Args:
        client: An authenticated client.
        base: The deployment's base URL.
        size_bytes: How large a body to offer.

    Returns:
        What the proxy did with it.
    """
    # A real WAV, not a block of zeros. Zeros are not a recognised audio file,
    # so the gateway rejects them on content before size is ever in question —
    # and the first run of this probe misread that semantic 400 as a proxy
    # limit. Silence in a valid container tests the thing being asked about.
    payload = _silent_wav(size_bytes)
    try:
        response = client.post(
            f"{base}/api/reference",
            files={"audio": ("probe.wav", payload, "audio/wav")},
            timeout=600,
        )
    except httpx.HTTPError as error:
        return UploadResult(
            attempted_bytes=size_bytes,
            accepted=False,
            failure_mode="refused",
            status=None,
            note=(
                f"the transport failed before a status arrived ({type(error).__name__}). "
                "Treat this as a refusal at or below this size and lower "
                "MAX_AUDIO_UPLOAD_BYTES to match, so an oversized upload is refused "
                "with a real number instead of stalling."
            ),
        )

    if response.status_code < 400:
        return UploadResult(
            attempted_bytes=size_bytes,
            accepted=True,
            failure_mode="accepted",
            status=response.status_code,
            note="the proxy passed a body of this size intact.",
        )

    body = response.text[:400]
    truncated = "unexpected end" in body.lower() or "truncat" in body.lower()

    # A typed refusal from the GATEWAY means the whole body crossed the proxy and
    # was then judged on its merits — which answers the proxy question in the
    # affirmative, not the negative. Only a transport failure, a 413 from the
    # edge, or evidence of truncation says the proxy imposed a ceiling.
    gateway_semantic = '"type":"reference"' in body or '"type":"validation"' in body
    if gateway_semantic and not truncated:
        return UploadResult(
            attempted_bytes=size_bytes,
            accepted=True,
            failure_mode="accepted",
            status=response.status_code,
            note=(
                f"the proxy PASSED a body of this size: the gateway received it whole and "
                f"refused it on its own content rules (status {response.status_code}: {body}). "
                "MAX_AUDIO_UPLOAD_BYTES needs no change on the proxy's account. Note the "
                "gateway's own reference-duration ceiling still applies and is much smaller."
            ),
        )

    return UploadResult(
        attempted_bytes=size_bytes,
        accepted=False,
        failure_mode="truncated" if truncated else "refused",
        status=response.status_code,
        note=(
            f"status {response.status_code}: {body}. "
            + (
                "TRUNCATION, which is the worse outcome — it reaches a visitor as a "
                "corrupt reference rather than as a refusal. Lower "
                "MAX_AUDIO_UPLOAD_BYTES below this size."
                if truncated
                else "A refusal at the edge rather than from the gateway. Lower "
                "MAX_AUDIO_UPLOAD_BYTES to match so the boundary names a real number."
            )
        ),
    )


def write_finding(payload: dict[str, Any], path: Path = RESULTS_PATH) -> None:
    """Record the measurement where the plan and the UI can cite it.

    Replace-on-write over a fixed filename, as the other three probes do, so
    re-running cannot grow the directory.

    Args:
        payload: The finding.
        path: Where to write it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    """Probe a deployment and record what it does.

    Args:
        argv: Command-line arguments.

    Returns:
        A process exit status.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("url", help="the hosted gateway's base URL")
    parser.add_argument(
        "--text",
        default=(
            "The quick brown fox jumps over the lazy dog, and then it does so "
            "again, because one short line would not separate a first byte from "
            "a last one."
        ),
        help="a line long enough for first-byte and total to differ",
    )
    parser.add_argument("--voice-id", default=None, help="a saved voice to speak with")
    parser.add_argument(
        "--upload-bytes",
        type=int,
        default=512 * 1024 * 1024,
        help="body size to offer; defaults to MAX_AUDIO_UPLOAD_BYTES",
    )
    parser.add_argument(
        "--skip-upload",
        action="store_true",
        help="measure streaming only; the upload probe moves real megabytes",
    )
    args = parser.parse_args(argv)

    base = args.url.rstrip("/")
    password = os.environ.get("BREEZE_DEMO_PASSWORD")
    if not password:
        print("BREEZE_DEMO_PASSWORD is not set; the gate would refuse every request.")
        return 2

    with httpx.Client(follow_redirects=True, timeout=900) as client:
        login = client.post(f"{base}/api/session", json={"password": password})
        if login.status_code != 204:
            print(f"login failed with {login.status_code}; nothing else can be measured.")
            return 1

        # One discarded request first. The buffering question is about the
        # proxy, and a cold sample answers a different question loudly: the
        # GPU's ~150s start dominates the first byte, the ratio reads 0.98, and
        # a streaming proxy is indistinguishable from a buffering one.
        print("warming the container (this request is discarded)...")
        try:
            measure_streaming(client, base, "Warming up.", args.voice_id, warm=False)
        except (httpx.HTTPError, RuntimeError) as error:
            print(f"warmup failed, so the measurement would be cold: {error}")
            return 1

        streaming = measure_streaming(client, base, args.text, args.voice_id)
        log.info("hosting_probe.streaming", **asdict(streaming))

        upload: UploadResult | None = None
        if not args.skip_upload:
            upload = measure_upload_ceiling(client, base, args.upload_bytes)
            log.info("hosting_probe.upload", **asdict(upload))

    write_finding(
        {
            "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "endpoint": "hosted gateway (URL withheld: it is the upstream this project never publishes)",
            "streaming": asdict(streaming),
            "upload": asdict(upload) if upload else None,
        }
    )
    print(f"wrote {RESULTS_PATH}")
    print(f"  streaming: {streaming.note}")
    if upload:
        print(f"  upload:    {upload.note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
