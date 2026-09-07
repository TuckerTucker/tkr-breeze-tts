"""The Modal image carrying the Node gateway.

This image has nothing to do with inference. It carries no CUDA, no torch and
no vendor clone — it exists so the gateway that already runs on the operator's
Mac can run in a container instead, unmodified. What it must supply is
everything the gateway expects to find on that Mac: a Node runtime, ffmpeg, the
built UI, and the recorded findings.

**ffmpeg is not optional here.** Absent it, the gateway starts in its degraded
WAV-only mode and says so in one log line nobody reads in a container, so
reference capture would simply stop working with no visible cause. It is
asserted at build time instead.

**The in-image paths below are this module's published contract.**
``infra/hosting.py`` points ``UI_DIST_DIR`` and ``BENCH_FINDINGS_DIR`` at
exactly these, rather than each module assuming where the other put things.
They are absolute because ``gateway/src/config.ts`` resolves a relative store
path against a ``REPO_ROOT`` derived from its own module location, which inside
a container is not a layout anyone should have to reason about.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

import modal

# Debian bookworm ships Node 18; the gateway declares engines >=20.11, so Node
# comes from NodeSource rather than from apt's default.
NODE_MAJOR: Final[str] = "20"

#: Where the gateway's own source and dependencies live in the image.
GATEWAY_ROOT: Final[str] = "/opt/breeze-gateway"

#: Built UI assets. `infra/hosting.py` sets UI_DIST_DIR to this.
UI_DIR: Final[str] = "/opt/breeze-ui"

#: Recorded bench findings. `infra/hosting.py` sets BENCH_FINDINGS_DIR to this.
FINDINGS_DIR: Final[str] = "/opt/breeze-findings"

#: Where the state Volume is mounted. The four store directories sit beneath it.
STATE_MOUNT_PATH: Final[str] = "/state"

#: Python packages the CONTAINER's entrypoint needs, which is a different set
#: from anything the gateway needs.
#:
#: This image runs no Python of its own — but Modal imports `infra/hosting.py`
#: inside the container to find the decorated function, and that module imports
#: `infra.config`, which imports structlog at module scope. Miss this and the
#: image builds cleanly, the smoke check passes, every test passes, and the
#: container then crash-loops on `ModuleNotFoundError` before the gateway is
#: ever spawned. Kept in sync with infra/config.py by test_hosting_image.py.
ENTRYPOINT_REQUIREMENTS: Final[tuple[str, ...]] = ("structlog>=24.1",)

_REPO_ROOT: Final[Path] = Path(__file__).resolve().parent.parent


def build_hosting_image() -> modal.Image:
    """Construct the image the hosted gateway runs in.

    Layer order follows `infra/image.py`: the locked npm install sits below the
    source copy, so editing a route rebuilds only the cheap layer.

    Returns:
        A `modal.Image` in which `node dist/index.js` starts a gateway with
        ffmpeg, the built UI and the recorded findings all present.
    """
    return (
        modal.Image.debian_slim()
        .apt_install("ca-certificates", "curl", "ffmpeg", "gnupg")
        .pip_install(*ENTRYPOINT_REQUIREMENTS)
        .run_commands(
            # NodeSource, because apt's node is 18 and the gateway needs >=20.11.
            "curl -fsSL https://deb.nodesource.com/setup_"
            f"{NODE_MAJOR}.x | bash -",
            "apt-get install -y nodejs",
        )
        # Manifests first, so a source edit does not reinstall the dependency
        # tree. `npm ci` rather than `npm install`: the hosted runtime must be
        # the pinned dependency set, not whatever resolves on build day.
        .add_local_file(
            _REPO_ROOT / "gateway" / "package.json",
            f"{GATEWAY_ROOT}/package.json",
            copy=True,
        )
        .add_local_file(
            _REPO_ROOT / "gateway" / "package-lock.json",
            f"{GATEWAY_ROOT}/package-lock.json",
            copy=True,
        )
        # The full tree first, because TypeScript is a devDependency and the
        # gateway ships as compiled JavaScript rather than being transpiled at
        # boot. Pruned back to production deps after the build, so the shipped
        # image carries the compiler no longer.
        .run_commands(f"cd {GATEWAY_ROOT} && npm ci")
        .add_local_dir(
            _REPO_ROOT / "gateway" / "src",
            f"{GATEWAY_ROOT}/src",
            copy=True,
        )
        .add_local_file(
            _REPO_ROOT / "gateway" / "tsconfig.json",
            f"{GATEWAY_ROOT}/tsconfig.json",
            copy=True,
        )
        .run_commands(
            # Not `npm run build`. The repo tsconfig sets rootDir "." and
            # includes test/**, so its output lands at dist/src/index.js and
            # mirrors a test/ directory this image does not copy. The entry
            # point's path is this image's contract with hosting.py, so it is
            # pinned here rather than inherited from a config tuned for local
            # development. Declarations and source maps are dropped: nothing in
            # the container consumes them.
            f"cd {GATEWAY_ROOT} && npx tsc -p tsconfig.json"
            " --rootDir src --outDir dist --declaration false --sourceMap false",
            f"cd {GATEWAY_ROOT} && npm prune --omit=dev",
        )
        # The UI is served from the gateway's own origin, which is the property
        # the whole credential posture rests on.
        .add_local_dir(_REPO_ROOT / "ui" / "dist", UI_DIR, copy=True)
        # Read through GET /api/health. Without these the UI renders "not yet
        # measured" for figures that are, in fact, measured.
        .add_local_dir(_REPO_ROOT / "bench" / "findings", FINDINGS_DIR, copy=True)
        .add_local_file(
            Path(__file__).with_name("hosting_smoke_check.py"),
            "/opt/breeze-smoke/hosting_smoke_check.py",
            copy=True,
        )
        .env(
            {
                "NODE_ENV": "production",
                "UI_DIST_DIR": UI_DIR,
                "BENCH_FINDINGS_DIR": FINDINGS_DIR,
            }
        )
        # The final build step, so a missing ffmpeg or a UI that was never built
        # fails `modal deploy` rather than the first visitor.
        .run_commands("python /opt/breeze-smoke/hosting_smoke_check.py")
        .add_local_python_source("infra")
    )
