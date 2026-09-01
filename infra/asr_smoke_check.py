"""Build-time validation for the recognition image.

Runs as the final build step, so a version drift or a missing CUDA library
fails ``modal deploy`` naming the cause, rather than producing an image that
builds cleanly and raises at first transcription — which on a GPU container is
an expensive place to learn it.

There is no GPU at build time, so this cannot run a model. What it can do is
prove that every import resolves, that the pinned versions are the ones
installed, and that the cuDNN and cuBLAS shared objects CTranslate2 dlopens by
soname are actually on the loader path. That last one is the failure this file
mainly exists for: `ctranslate2` imports perfectly well without them and then
raises ``Library libcudnn_ops.so.9 is not found`` only when a model is placed
on a device.

Run as a script inside the image.
"""

from __future__ import annotations

import ctypes
import importlib.metadata
import sys

# Exact pins the image promises.
EXPECTED_VERSIONS: dict[str, str] = {
    "faster-whisper": "1.2.1",
    "ctranslate2": "4.8.2",
}

# Sonames CTranslate2 loads at device time, not at import. Named individually
# so a partial CUDA install is reported as the specific library that is absent.
REQUIRED_LIBRARIES: tuple[str, ...] = (
    "libcudnn_ops.so.9",
    "libcudnn_cnn.so.9",
    "libcublas.so.12",
)


def check_versions() -> None:
    """Assert every pinned dependency is installed at its pinned version.

    Raises:
        RuntimeError: On a missing package or a version mismatch.
    """
    for name, expected in EXPECTED_VERSIONS.items():
        try:
            found = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError as exc:
            raise RuntimeError(f"{name} is not installed") from exc
        if found != expected:
            raise RuntimeError(
                f"{name} is {found}, but this image pins {expected}. "
                "Update the pin in infra/asr_image.py rather than letting the "
                "resolver choose."
            )
        print(f"  {name} {found}", flush=True)


def check_cuda_libraries() -> None:
    """Assert the CUDA shared objects are loadable by soname.

    Raises:
        RuntimeError: Naming the first library that cannot be opened, and the
            loader path it was looked for on.
    """
    for soname in REQUIRED_LIBRARIES:
        try:
            ctypes.CDLL(soname)
        except OSError as exc:
            raise RuntimeError(
                f"{soname} is not loadable: {exc}. CTranslate2 dlopens it when a "
                "model is placed on a device, so this would surface as a runtime "
                "failure on a GPU container. Check CUDA_REQUIREMENTS and "
                "NVIDIA_LIB_PATH in infra/asr_image.py."
            ) from exc
        print(f"  {soname} loadable", flush=True)


def main() -> None:
    """Import the runtime, check its pins, and check its CUDA linkage.

    Raises:
        RuntimeError: On any failed check, so the image build stops here.
    """
    print("asr smoke check:", flush=True)
    check_versions()

    # Imported after the version check so a mismatch is reported as a
    # mismatch rather than as whatever the wrong version fails to import.
    import ctranslate2  # noqa: F401
    from faster_whisper import WhisperModel  # noqa: F401

    check_cuda_libraries()
    print("asr smoke check passed", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — the message is the product here
        print(f"asr smoke check FAILED: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1) from exc
