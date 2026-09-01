"""Modal deployment surface for the Breeze-TTS-2 demo.

The package is named ``infra`` rather than ``modal`` on purpose: a local
package called ``modal`` shadows the Modal SDK on ``sys.path``, so
``modal deploy infra/service.py`` would import this directory instead of the
SDK it needs.

Modules:
    config: GPU, warm window, auth and fast-path posture as one surface.
    image: The container image, with FlashAttention from a prebuilt wheel.
    weights: The 7.7 GB checkpoint Volume and its one-off fill.
    service: The serving class — enter-time load, vendor ASGI app unchanged.
"""

from __future__ import annotations

__all__ = ["config", "image", "service", "weights"]
