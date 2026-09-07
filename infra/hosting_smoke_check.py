"""Build-time validation for the gateway hosting image.

Runs as the final build step so an image missing something the gateway needs
fails ``modal deploy`` naming what is absent, rather than producing an image
that builds cleanly and degrades silently at runtime.

Every check here is one the container cannot recover from and would not report
loudly on its own:

* **ffmpeg** — the gateway degrades to WAV-only uploads and writes one warning
  into a log nobody reads, so reference capture stops working with no visible
  cause.
* **The UI** — ``index.html`` absent means the console is a 404, and the
  same-origin arrangement the credential posture rests on has nothing to serve.
* **``pcm-processor.js``** — served untransformed and deliberately not bundled,
  so a build that dropped it fails only at first playback.
* **The findings** — absent, the UI says "not yet measured" for figures that
  are measured, which is the one thing the wake state exists to avoid.

Run as a script inside the image.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

GATEWAY_ROOT = Path("/opt/breeze-gateway")
UI_DIR = Path("/opt/breeze-ui")
FINDINGS_DIR = Path("/opt/breeze-findings")


def _run(command: list[str]) -> str:
    """Execute a command, returning its first line of output.

    Args:
        command: Argv to run.

    Returns:
        The first line written to stdout.

    Raises:
        RuntimeError: When the binary is missing or exits non-zero.
    """
    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError(f"{command[0]} is not runnable in this image: {error}") from error
    return completed.stdout.strip().splitlines()[0] if completed.stdout.strip() else ""


def check_node() -> str:
    """Assert Node runs and satisfies the gateway's declared engine range.

    Returns:
        The reported version.

    Raises:
        RuntimeError: When Node is absent or older than the manifest requires.
    """
    version = _run(["node", "--version"]).lstrip("v")
    major = int(version.split(".")[0])
    manifest = json.loads((GATEWAY_ROOT / "package.json").read_text())
    required = manifest.get("engines", {}).get("node", ">=20.11")
    minimum = int(required.lstrip(">=^~").split(".")[0])
    if major < minimum:
        raise RuntimeError(
            f"node {version} is below the gateway's engines requirement {required}"
        )
    return version


def check_ffmpeg() -> str:
    """Assert ffmpeg is present and executable.

    Returns:
        The reported version line.

    Raises:
        RuntimeError: When ffmpeg is missing.
    """
    return _run(["ffmpeg", "-version"])


def check_entrypoint() -> None:
    """Assert the compiled gateway entry point is where hosting.py will run it.

    Added after a deployment that built cleanly, passed every other check here,
    and then crash-looped on `Cannot find module '/opt/breeze-gateway/dist/
    index.js'`. The compiler had emitted to `dist/src/index.js`, because the
    repo tsconfig sets `rootDir "."` for local development. A check that
    verifies the UI and the findings but not the thing that actually runs is a
    check with a hole in the middle of it.

    Raises:
        RuntimeError: When the entry point is absent.
    """
    entry = GATEWAY_ROOT / "dist" / "index.js"
    if not entry.is_file():
        emitted = sorted(str(p) for p in (GATEWAY_ROOT / "dist").rglob("index.js"))
        raise RuntimeError(
            f"{entry} is missing — the container would crash-loop on MODULE_NOT_FOUND "
            f"before the gateway ever started. index.js was emitted at: {emitted or 'nowhere'}"
        )


def check_ui() -> None:
    """Assert the built UI arrived intact.

    Raises:
        RuntimeError: When index.html or the worklet is missing.
    """
    index = UI_DIR / "index.html"
    if not index.is_file():
        raise RuntimeError(
            f"{index} is missing — build the UI before deploying: npm --prefix ui run build"
        )
    worklet = UI_DIR / "pcm-processor.js"
    if not worklet.is_file():
        raise RuntimeError(
            f"{worklet} is missing. It is served untransformed from ui/public/ and is "
            "deliberately not bundled, so its absence surfaces only at first playback."
        )


def check_findings() -> int:
    """Assert the recorded measurements arrived and parse.

    Returns:
        How many findings were found.

    Raises:
        RuntimeError: When the latency finding is absent or malformed.
    """
    latency = FINDINGS_DIR / "latency.json"
    if not latency.is_file():
        raise RuntimeError(
            f"{latency} is missing — the UI would render 'not yet measured' for a "
            "figure that has in fact been measured."
        )
    try:
        json.loads(latency.read_text())
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{latency} does not parse: {error}") from error
    return len(list(FINDINGS_DIR.glob("*.json")))


def main() -> None:
    """Run every check, reporting what was verified."""
    node = check_node()
    ffmpeg = check_ffmpeg()
    check_entrypoint()
    check_ui()
    findings = check_findings()
    print(
        f"hosting image ok: node {node}, {ffmpeg}, entry point present, "
        f"UI present, {findings} finding(s)"
    )


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(f"hosting image check failed: {error}", file=sys.stderr)
        sys.exit(1)
