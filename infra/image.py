"""The Modal image carrying the vendor Breeze runtime.

Two decisions live here and nowhere else.

**FlashAttention is mandatory, not optional.** The shipped ``config.json`` sets
``text_encoder_config.preferred_attn_implementation = "flash_attention_2"``,
and ``models/breeze.py`` reads that value directly when constructing the text
encoder. The ``attn_implementation="eager"`` that ``breeze_infer/api.py`` passes
reaches only the backbone — it never overrides the text encoder. So flash-attn
is required on every path, including the one advertised as eager.

**It comes from a prebuilt wheel, not a source build.** The vendor's
``docker/build.sh`` compiles FlashAttention with ``FLASH_ATTN_CUDA_ARCHS=90``,
which bakes Hopper into the image and would make GPU type an image property.
The official wheel is multi-arch and matches this stack exactly, so GPU type
stays a configuration value. The cost is a pinned interpreter: cp312 is the
only Python published for torch 2.9.
"""

from __future__ import annotations

from typing import Final

import modal

from infra.config import MODEL_MOUNT_PATH

PYTHON_VERSION: Final[str] = "3.12"

VENDOR_REPO: Final[str] = "https://github.com/breezeblue-ai/breeze-tts.git"
# Pinned. An unpinned clone would make every image rebuild a silent upgrade of
# the code the measurements in `bench/findings` were taken against.
VENDOR_COMMIT: Final[str] = "ca632ce6c4d05f7985da4eab29b1a5d445b43f7b"
VENDOR_ROOT: Final[str] = "/opt/breeze-infer"

FLASH_ATTN_WHEEL: Final[str] = (
    "https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.3/"
    "flash_attn-2.8.3%2Bcu12torch2.9cxx11abiTRUE-cp312-cp312-linux_x86_64.whl"
)

# The vendor's requirements.txt pins, restated so an upstream edit cannot
# change this image without the pin changing here too. `smoke_check.py`
# asserts these same versions at build time.
VENDOR_REQUIREMENTS: Final[tuple[str, ...]] = (
    "torch==2.9.1",
    "torchaudio==2.9.1",
    "qwen-tts==0.1.1",
    "transformers==4.57.3",
    "numpy>=2.0",
    "soundfile>=0.13",
    "fastapi>=0.115",
    "uvicorn>=0.30",
    "python-multipart>=0.0.18",
)

SERVICE_REQUIREMENTS: Final[tuple[str, ...]] = (
    "huggingface_hub[hf_xet]>=0.26",
    "structlog>=24.1",
)


def build_image() -> modal.Image:
    """Construct the runtime image.

    Layer order is chosen for cache reuse: the 2.5 GB of pinned dependencies
    and the 250 MB FlashAttention wheel sit below the vendor clone, so bumping
    `VENDOR_COMMIT` rebuilds only the cheap layers above them.

    Returns:
        A `modal.Image` in which the vendor runtime imports and runs, with no
        GPU-architecture assumption baked in.
    """
    return (
        modal.Image.debian_slim(python_version=PYTHON_VERSION)
        .apt_install("git", "ffmpeg", "libsndfile1", "sox", "ca-certificates")
        .pip_install(*VENDOR_REQUIREMENTS)
        # By URL, not by name: `pip install flash-attn` would fall back to a
        # source build, which is the arch lock this image exists to avoid.
        .pip_install(FLASH_ATTN_WHEEL)
        .pip_install(*SERVICE_REQUIREMENTS)
        .run_commands(
            f"git clone --filter=blob:none {VENDOR_REPO} {VENDOR_ROOT}",
            f"cd {VENDOR_ROOT} && git checkout --quiet {VENDOR_COMMIT}",
        )
        .env(
            {
                "PYTHONPATH": VENDOR_ROOT,
                "PYTHONUNBUFFERED": "1",
                "BREEZE_VENDOR_ROOT": VENDOR_ROOT,
                "TOKENIZERS_PARALLELISM": "false",
                "HF_HOME": f"{MODEL_MOUNT_PATH}/.hf",
            }
        )
        .add_local_file(
            __file__.replace("image.py", "smoke_check.py"),
            "/opt/breeze-smoke/smoke_check.py",
            copy=True,
        )
        # The final build step, so an ABI or version mismatch fails the build
        # rather than the first inference.
        .run_commands("python /opt/breeze-smoke/smoke_check.py")
    )


image: Final[modal.Image] = build_image()
