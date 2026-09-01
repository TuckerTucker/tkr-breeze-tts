"""The recognition model's place on the weights Volume, and its one-off fill.

This module **imports** the Volume rather than defining one. Multiple Volumes
are supported and would work, but one Volume keeps setup to one place and
splitting them would buy independence nothing here wants — the two models are
provisioned together and read by containers that never write. What separating
this module does buy is territory: ``weights.py`` belongs to the slice that
shipped it, and the recognition model's completeness check belongs beside the
recognition model.

The check earns its place for the same reason the Breeze one does. A partial
CTranslate2 conversion is not a loud failure: ``model.bin`` truncated mid-write
loads far enough to raise from inside the runtime, and the message names an
offset in a binary rather than an interrupted download.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import modal

from infra.asr_image import asr_image
from infra.config import (
    ASR_APP_NAME,
    ASR_MODEL_DIR,
    ASR_MODEL_REPO,
    MODEL_MOUNT_PATH,
)
from infra.weights import volume

# Every file `WhisperModel` opens, named individually so a partial fill is
# reported as the specific thing that is absent. Verified against the repo's
# file listing rather than assumed: this conversion ships a vocabulary.json,
# where older ones shipped vocabulary.txt.
ASR_REQUIRED_FILES: Final[tuple[str, ...]] = (
    "config.json",
    "model.bin",
    "preprocessor_config.json",
    "tokenizer.json",
    "vocabulary.json",
)

# model.bin alone is 3.087 GB; anything much under this is an interrupted
# download that `snapshot_download` will happily leave in place.
ASR_MIN_TOTAL_BYTES: Final[int] = 3_000_000_000

app: Final[modal.App] = modal.App(f"{ASR_APP_NAME}-weights")


class AsrModelIncomplete(RuntimeError):
    """Raised when the Volume does not hold a usable recognition model."""


@dataclass(frozen=True)
class AsrModelReport:
    """The result of inspecting the recognition model directory.

    Attributes:
        root: The directory inspected.
        missing: Required files that are absent, in `ASR_REQUIRED_FILES` order.
        total_bytes: Sum of the sizes of the required files that are present.
    """

    root: Path
    missing: tuple[str, ...]
    total_bytes: int

    @property
    def complete(self) -> bool:
        """Whether every required file is present and the size is plausible."""
        return not self.missing and self.total_bytes >= ASR_MIN_TOTAL_BYTES


def inspect_asr_model(root: Path | str) -> AsrModelReport:
    """Inspect a recognition model directory without loading anything.

    Args:
        root: Directory that should contain the CTranslate2 conversion.

    Returns:
        An `AsrModelReport` naming whatever is absent.
    """
    base = Path(root)
    missing: list[str] = []
    total = 0
    for name in ASR_REQUIRED_FILES:
        path = base / name
        if not path.is_file():
            missing.append(name)
            continue
        total += path.stat().st_size
    return AsrModelReport(root=base, missing=tuple(missing), total_bytes=total)


def require_asr_model(root: Path | str) -> AsrModelReport:
    """Assert that `root` holds a complete recognition model.

    Args:
        root: Directory that should contain the CTranslate2 conversion.

    Returns:
        The passing `AsrModelReport`.

    Raises:
        AsrModelIncomplete: With the absent files named, and the one command
            that fixes it.
    """
    report = inspect_asr_model(root)
    if report.complete:
        return report

    if "model.bin" in report.missing:
        detail = "the 3 GB model.bin is absent, so nothing was downloaded. "
    elif report.total_bytes < ASR_MIN_TOTAL_BYTES:
        detail = (
            "model.bin is present but short, which is an interrupted download "
            "rather than a conversion problem. "
        )
    else:
        detail = ""

    raise AsrModelIncomplete(
        f"recognition model at {report.root} is incomplete. {detail}"
        f"missing: {', '.join(report.missing) or '(none)'}; "
        f"total size {report.total_bytes} bytes "
        f"(expected at least {ASR_MIN_TOTAL_BYTES}). "
        f"Fill it with: modal run infra/asr_weights.py::fill"
    )


@app.function(
    image=asr_image,
    volumes={MODEL_MOUNT_PATH: volume},
    timeout=60 * 60,
    # No GPU: this only moves bytes.
)
def fill(force: bool = False) -> dict[str, object]:
    """Download the recognition model onto the Volume. Safe to re-run.

    ``snapshot_download`` skips files already present, so an interrupted
    download resumes rather than duplicating work.

    Args:
        force: Re-download even when the model already verifies.

    Returns:
        A summary carrying the resolved path and total bytes.
    """
    from huggingface_hub import snapshot_download

    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")

    existing = inspect_asr_model(ASR_MODEL_DIR)
    if existing.complete and not force:
        print(f"recognition model already complete at {ASR_MODEL_DIR}", flush=True)
        return {
            "path": ASR_MODEL_DIR,
            "skipped": True,
            "total_bytes": existing.total_bytes,
        }

    snapshot_download(
        repo_id=ASR_MODEL_REPO,
        local_dir=ASR_MODEL_DIR,
        # No README or .gitattributes: this is a runtime directory, not a clone.
        allow_patterns=["*.json", "*.bin"],
    )
    volume.commit()

    report = require_asr_model(ASR_MODEL_DIR)
    print(
        f"recognition model filled at {ASR_MODEL_DIR}: {report.total_bytes} bytes",
        flush=True,
    )
    return {
        "path": ASR_MODEL_DIR,
        "skipped": False,
        "total_bytes": report.total_bytes,
    }


@app.function(image=asr_image, volumes={MODEL_MOUNT_PATH: volume}, timeout=300)
def verify() -> dict[str, object]:
    """Report on the Volume's recognition model without downloading anything.

    Returns:
        The report as a plain mapping, so ``modal run`` prints something
        legible rather than a repr.
    """
    report = inspect_asr_model(ASR_MODEL_DIR)
    return {
        "path": str(report.root),
        "complete": report.complete,
        "missing": list(report.missing),
        "total_bytes": report.total_bytes,
    }


@app.local_entrypoint()
def main(force: bool = False) -> None:
    """Fill the recognition model, then report what landed.

    Args:
        force: Re-download even when the model already verifies.
    """
    result = fill.remote(force=force)
    print(result)
