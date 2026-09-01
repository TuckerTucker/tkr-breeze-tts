"""Measurement: the instrumented client the rest of the plan builds against.

This capability exists to close decisions, not to ship a feature. Its output is
evidence — recorded in `bench/findings/` — that `demo-ui` and
`modal-inference` cite rather than assume.

Modules:
    harness: Time-to-first-audio, real-time factor, cold versus warm.
    cfg_probe: Whether an uncaptured `cfg_scale` leaves the CUDA-graph fast
        path, which decides the shape of the UI's CFG control.
"""

from __future__ import annotations

__all__ = ["cfg_probe", "harness"]
