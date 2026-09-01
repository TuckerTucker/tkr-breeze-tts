"""The Modal image carrying faster-whisper.

Two decisions live here and nowhere else.

**CTranslate2 needs cuDNN 9, and it is not torch's.** faster-whisper does not
depend on torch at all — CTranslate2 is its own runtime — so nothing in the
dependency graph drags CUDA libraries in the way the Breeze image gets them
free from ``torch``. They are installed explicitly and put on
``LD_LIBRARY_PATH``; without that, ``ctranslate2`` imports cleanly and then
raises ``Library libcudnn_ops.so.9 is not found`` at first transcription, on a
GPU container, which is an expensive place to learn it.

**The model is a CTranslate2 conversion, not a Whisper checkpoint.** It comes
from ``Systran/faster-whisper-large-v3`` as a 3.1 GB ``model.bin`` plus its
tokenizer, and lives on the Volume for the same reason the Breeze weights do:
baking it in would make every image rebuild a 3 GB re-download.

This image shares nothing with ``infra.image`` — no vendor clone, no
FlashAttention, no torch. They share a Volume and a proxy token pair.
"""

from __future__ import annotations

from typing import Final

import modal

from infra.config import MODEL_MOUNT_PATH

PYTHON_VERSION: Final[str] = "3.12"

# Pinned, restated here so an upstream release cannot change this image without
# the pin changing too. `asr_smoke_check.py` asserts these same versions at
# build time.
ASR_REQUIREMENTS: Final[tuple[str, ...]] = (
    "faster-whisper==1.2.1",
    # faster-whisper allows <5,>=4.0; pinning exactly keeps the cuDNN
    # requirement below from drifting under a resolver upgrade.
    "ctranslate2==4.8.2",
    "huggingface_hub[hf_xet]>=0.26",
    "structlog>=24.1",
    "fastapi>=0.115",
    "uvicorn>=0.30",
    "python-multipart>=0.0.18",
)

# CTranslate2 4.5+ links against cuDNN 9. Installed from the wheels rather than
# apt so the version is a pin here rather than whatever the base image carries.
CUDA_REQUIREMENTS: Final[tuple[str, ...]] = (
    "nvidia-cublas-cu12",
    "nvidia-cudnn-cu12>=9.1,<10",
)

# Where those wheels put their shared objects. CTranslate2 dlopens them by
# soname at first use, so they have to be on the loader path of the process,
# not merely installed.
NVIDIA_LIB_PATH: Final[str] = (
    "/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:"
    "/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib"
)


def build_asr_image() -> modal.Image:
    """Construct the recognition image.

    Layer order follows `infra.image`: the heavy pinned dependencies sit below
    the local files, so editing the smoke check or the service rebuilds only
    the cheap layers above them.

    Returns:
        A `modal.Image` in which `faster_whisper` imports and CTranslate2 can
        find its CUDA libraries.
    """
    return (
        modal.Image.debian_slim(python_version=PYTHON_VERSION)
        # libgomp for CTranslate2's OpenMP runtime; ffmpeg is not needed —
        # faster-whisper decodes through the bundled PyAV — but the gateway
        # sends conforming WAV either way.
        .apt_install("libgomp1", "ca-certificates")
        .pip_install(*CUDA_REQUIREMENTS)
        .pip_install(*ASR_REQUIREMENTS)
        .env(
            {
                "PYTHONUNBUFFERED": "1",
                "LD_LIBRARY_PATH": NVIDIA_LIB_PATH,
                "TOKENIZERS_PARALLELISM": "false",
                "HF_HOME": f"{MODEL_MOUNT_PATH}/.hf",
            }
        )
        .add_local_file(
            __file__.replace("asr_image.py", "asr_smoke_check.py"),
            "/opt/breeze-asr/asr_smoke_check.py",
            copy=True,
        )
        # The final build step, so a missing CUDA library or a version drift
        # fails the build rather than the first transcription.
        .run_commands("python /opt/breeze-asr/asr_smoke_check.py")
        # As in `infra.image`: Modal stopped auto-mounting local packages in
        # 1.0, and without this the entrypoint arrives with its siblings absent.
        # Declared last so it never invalidates a build layer.
        .add_local_python_source("infra")
    )


asr_image: Final[modal.Image] = build_asr_image()
