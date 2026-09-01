"""Build-time import validation for the Breeze runtime image.

Adapted from the vendor's ``docker/smoke_check.py``. It runs as the final
build step so a cxx11-ABI or version mismatch fails ``modal deploy`` naming the
failing import, rather than producing an image that builds cleanly and raises
at first inference — which on a GPU container is an expensive place to learn.

Run as a script inside the image; it takes the vendor source root from
``BREEZE_VENDOR_ROOT`` (default ``/opt/breeze-infer``).
"""

from __future__ import annotations

import importlib.metadata
import os
import sys
from pathlib import Path

VENDOR_ROOT = Path(os.environ.get("BREEZE_VENDOR_ROOT", "/opt/breeze-infer"))
sys.path.insert(0, str(VENDOR_ROOT))

# Exact pins the image promises. `flash-attn` is the one that matters most:
# its wheel is built against a specific torch and cxx11abi, and a mismatch is
# an ImportError at module load rather than anything the resolver catches.
EXPECTED_VERSIONS: dict[str, str] = {
    "torch": "2.9.1",
    "torchaudio": "2.9.1",
    "transformers": "4.57.3",
    "qwen-tts": "0.1.1",
    "flash-attn": "2.8.3",
}


def main() -> None:
    """Import every runtime dependency and assert its pinned version.

    Raises:
        RuntimeError: On a version mismatch or a missing vendor module.
    """
    import flash_attn  # noqa: F401  — the ABI-sensitive import
    import qwen_tts  # noqa: F401
    import torch
    import transformers  # noqa: F401

    from breeze_infer.templates import get_template  # noqa: F401
    from models.fast_streaming import FastStreamingConfig
    from models.warmup_profile import load_warmup_profile

    observed = {
        name: importlib.metadata.version(name) for name in EXPECTED_VERSIONS
    }
    for name, expected in EXPECTED_VERSIONS.items():
        # flash-attn reports `2.8.3+cu12torch2.9cxx11abiTRUE`; compare the base.
        actual = observed[name].split("+")[0]
        if actual != expected:
            raise RuntimeError(
                f"{name}: expected {expected}, got {observed[name]}"
            )

    config = FastStreamingConfig(fast_all=True)
    if not config.fast_all:
        raise RuntimeError("fast runtime configuration is unavailable")

    profile = load_warmup_profile(VENDOR_ROOT / "configs" / "fast.json")
    if not profile:
        raise RuntimeError("warmup profile did not load")

    print(
        "breeze image smoke check passed:",
        observed,
        f"torch_cuda_available={torch.cuda.is_available()}",
        flush=True,
    )


if __name__ == "__main__":
    main()
