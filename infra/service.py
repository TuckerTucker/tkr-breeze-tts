"""The Modal serving class: enter-time load, then the vendor app unchanged.

The correctness crux is *where* the model loads. The vendor puts its load in
the FastAPI lifespan, which is right for ``uvicorn`` and wrong for Modal: Modal
treats a container as warm once ``@modal.enter()`` returns, so a load left in
the lifespan means Modal routes requests to a container whose ``/health`` still
answers 503. The load is therefore lifted into ``enter()``, and the vendor's
own lifespan call is made idempotent so the work is not done twice.

Two smaller bridges are needed for the vendor module to be importable at all:

* ``breeze_infer.api._settings`` is populated only inside the vendor's
  ``main()``. Serving the app without it raises
  ``RuntimeError('API settings are not initialized')`` from the lifespan.
* The vendor source is on ``PYTHONPATH`` via the image, not installed.

Nothing about request handling is modified. The 409 from the vendor's
process-wide ``_request_lock`` passes straight through for the gateway to type,
and there is deliberately no ``@modal.concurrent``: ``configs/fast.json``
declares ``concurrency: 1``, and one input per container is the correct
posture rather than a limitation to work around.
"""

from __future__ import annotations

import io
import re
import sys
import time
from contextlib import redirect_stdout
from typing import Any, Final

import modal

from infra.config import APP_NAME, MODEL_DIR, MODEL_MOUNT_PATH, SERVICE_CONFIG
from infra.image import image
from infra.weights import require_checkpoint, volume

app: Final[modal.App] = modal.App(APP_NAME)

# The line the vendor prints at the end of warmup: `fast warmup: 12345.67 ms`.
WARMUP_LINE = re.compile(r"fast warmup:\s*([0-9.]+)\s*ms")


class _Tee(io.TextIOBase):
    """A stdout proxy that forwards writes and keeps a copy.

    The vendor reports warmup duration by printing it. That line must still
    reach the container log — ``bench`` scrapes it through ``modal app logs``
    to decompose cold start — while also being readable here, so it is teed
    rather than captured.
    """

    def __init__(self, downstream: Any) -> None:
        self._downstream = downstream
        self._buffer: list[str] = []

    def write(self, text: str) -> int:
        self._buffer.append(text)
        self._downstream.write(text)
        return len(text)

    def flush(self) -> None:
        self._downstream.flush()

    @property
    def text(self) -> str:
        """Everything written through this proxy."""
        return "".join(self._buffer)


@app.cls(
    image=image,
    gpu=SERVICE_CONFIG.gpu_spec,
    volumes={MODEL_MOUNT_PATH: volume},
    scaledown_window=SERVICE_CONFIG.scaledown_window_s,
    min_containers=SERVICE_CONFIG.min_containers,
    timeout=SERVICE_CONFIG.timeout_s,
)
class BreezeService:
    """Serves the vendor FastAPI app from a fully warmed container."""

    warmup_ms: float | None = None
    load_ms: float | None = None

    @modal.enter()
    def load(self) -> None:
        """Load weights and capture the CUDA graphs before serving anything.

        Raises:
            CheckpointIncomplete: If the Volume holds no usable checkpoint. The
                container then never reports warm, so no request is routed to
                it — a clearer failure than a container that answers 503
                forever.
        """
        report = require_checkpoint(MODEL_DIR)
        print(
            f"checkpoint verified: {report.total_bytes} bytes at {MODEL_DIR}",
            flush=True,
        )

        import breeze_infer.api as vendor_api

        settings = vendor_api.ApiSettings(
            model=report.root,
            fast_all=SERVICE_CONFIG.fast.all,
            fast_text_encoder=SERVICE_CONFIG.fast.text_encoder,
            fast_backbone_prefill=SERVICE_CONFIG.fast.backbone_prefill,
            fast_backbone_decode=SERVICE_CONFIG.fast.backbone_decode,
            fast_depth_decoder=SERVICE_CONFIG.fast.depth_decoder,
            fast_codec=SERVICE_CONFIG.fast.codec,
        )
        vendor_api._settings = settings

        # The vendor's lifespan will call `_load_app` again when the ASGI
        # server starts. Make that call a no-op rather than a second 7.7 GB
        # load and a second 53-graph capture. `_lifespan` resolves the global
        # by name at call time, so replacing the module attribute is enough.
        original_load_app = vendor_api._load_app

        def load_once(target_app: Any, target_settings: Any) -> None:
            if hasattr(target_app.state, "runtime"):
                print("vendor lifespan: already loaded in enter()", flush=True)
                return
            original_load_app(target_app, target_settings)

        vendor_api._load_app = load_once

        tee = _Tee(sys.stdout)
        started = time.perf_counter()
        with redirect_stdout(tee):
            original_load_app(vendor_api.app, settings)
        self.load_ms = (time.perf_counter() - started) * 1000.0

        match = WARMUP_LINE.search(tee.text)
        self.warmup_ms = float(match.group(1)) if match else None

        print(
            "breeze service ready "
            f"load_ms={self.load_ms:.1f} "
            f"warmup_ms={self.warmup_ms if self.warmup_ms is not None else 'n/a'} "
            f"gpu={SERVICE_CONFIG.gpu_spec} "
            f"fast_enabled={SERVICE_CONFIG.fast.enabled}",
            flush=True,
        )

    @modal.asgi_app(requires_proxy_auth=SERVICE_CONFIG.requires_proxy_auth)
    def serve(self) -> Any:
        """Return the vendor FastAPI app with its routes unchanged.

        Returns:
            ``breeze_infer.api.app`` — ``GET /health`` and
            ``POST /v1/audio/speech``, the latter still a ``StreamingResponse``
            of raw PCM carrying ``X-Sample-Rate`` and ``X-Sample-Format``.
        """
        import breeze_infer.api as vendor_api

        return vendor_api.app
