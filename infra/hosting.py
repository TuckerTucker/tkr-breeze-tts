"""The gateway hosting app.

The third Modal app, and the only one without a GPU. It runs the Node gateway
that already serves the local demo, unmodified, so the demo can be handed over
as a link rather than as a repository and a Mac.

**The gateway is the unit that gets hosted** because it is what serves the UI,
and that same-origin arrangement is what keeps the Modal credential off the
client. The browser talks to this app; this app talks to the synthesis and
recognition apps with a proxy pair the browser never sees.

**Nothing in the Node process learns about Modal.** The Volume is mounted where
the store environment variables already point, so persistence is configuration
rather than new code.

Deploy with::

    modal deploy infra/hosting.py

Decoration-time posture lives in `infra/config.py` with the other two services,
honouring the standing rule that no module carries its own decorator arguments.
"""

from __future__ import annotations

import os
import subprocess
from typing import Final

import modal

from infra.config import HostingConfig, hosting_config_from_env
from infra.hosting_image import (
    FINDINGS_DIR,
    GATEWAY_ROOT,
    STATE_MOUNT_PATH,
    UI_DIR,
    build_hosting_image,
)

APP_NAME: Final[str] = "breeze-tts-gateway"

#: Holds the four stores the gateway already writes to disk. Deliberately not
#: the weights Volume: weights are a 7.7 GB read-mostly fill and gateway state
#: is small and written constantly, so sharing one would make every clip write
#: contend with a checkpoint.
STATE_VOLUME_NAME: Final[str] = "breeze-tts-hosted-state"

#: The proxy pair the gateway attaches server-side, and the Argon2id password
#: hash the gate verifies against. Only the hash is ever deployed.
SECRET_NAME: Final[str] = "breeze-tts-gateway"

_config: Final[HostingConfig] = hosting_config_from_env()

app = modal.App(APP_NAME)
state_volume = modal.Volume.from_name(STATE_VOLUME_NAME, create_if_missing=True)

#: Every store path is absolute. `gateway/src/config.ts` resolves a relative
#: store path against a REPO_ROOT derived from its own module location, which
#: inside a container is not a layout anyone should have to reason about.
STORE_ENV: Final[dict[str, str]] = {
    "CLIP_CACHE_DIR": f"{STATE_MOUNT_PATH}/clips",
    "VOICE_STORE_DIR": f"{STATE_MOUNT_PATH}/voices",
    "SCRIPT_STORE_DIR": f"{STATE_MOUNT_PATH}/scripts",
    "REFERENCE_STORE_DIR": f"{STATE_MOUNT_PATH}/references",
    # Into the image, not the Volume: these ship with the build and are not state.
    "UI_DIST_DIR": UI_DIR,
    "BENCH_FINDINGS_DIR": FINDINGS_DIR,
    # Modal's proxy cannot reach a loopback-only listener. This is the one value
    # that makes hosting work at all, and the local default stays 127.0.0.1.
    "GATEWAY_HOST": "0.0.0.0",
    "GATEWAY_PORT": str(_config.port),
}


@app.function(
    image=build_hosting_image(),
    volumes={STATE_MOUNT_PATH: state_volume},
    secrets=[modal.Secret.from_name(SECRET_NAME)],
    max_containers=_config.max_containers,
    min_containers=_config.min_containers,
    timeout=_config.timeout_s,
)
# High by design. The "no @modal.concurrent" invariant is about the GPU apps,
# where the vendor holds a process-wide lock; carrying it here would let one
# 15-minute streaming synthesis block every asset load and every other visitor,
# and the demo would present as hung rather than as busy.
@modal.concurrent(max_inputs=_config.max_concurrent_inputs)
@modal.web_server(
    port=_config.port,
    startup_timeout=_config.startup_timeout_s,
    # Deliberately off, and the only endpoint in this project for which that is
    # true: proxy auth here would demand a wk-/ws- pair in the browser, which is
    # exactly what the gateway exists to prevent. The password gate protects it.
    requires_proxy_auth=_config.requires_proxy_auth,
)
def gateway() -> None:
    """Start the Node gateway and let Modal wait for its port.

    The process is spawned rather than awaited: `modal.web_server` polls the
    port and marks the container ready once it answers, which is later than the
    process starts because each of the four stores loads its directory into
    memory before `listen()`.

    No `volume.commit()` call belongs here. Writes commit in the background, and
    a commit issued from a Python process that does not own them would be
    theatre. The window that leaves is stated in the runbook rather than papered
    over: a voice saved seconds before a container is replaced can be lost.
    """
    # STORE_ENV last, so it wins. The container environment carries the Secret
    # — the proxy pair and the password hash — and those must reach the child,
    # but a Secret must not be able to move a store off the mount it was
    # declared against.
    subprocess.Popen(
        ["node", "dist/index.js"],
        cwd=GATEWAY_ROOT,
        env={**os.environ, **STORE_ENV},
    )
