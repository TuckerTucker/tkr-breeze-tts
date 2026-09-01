"""The weights Volume and its one-off fill.

The 7.7 GB checkpoint lives on a `modal.Volume`, not in the image. Baking it
in would make every image rebuild a 7.7 GB re-download, and Volume storage
falls inside Modal's free tier (1 TiB/month), so the Volume is both faster and
cheaper.

The completeness check earns its place: the vendor's ``load_runtime`` opens the
bundled ``audio_tokenizer`` deep inside the loader, and a missing one surfaces
as a ``FileNotFoundError`` that reads like a code bug rather than a
provisioning problem.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import modal

from infra.config import (
    APP_NAME,
    MODEL_DIR,
    MODEL_MOUNT_PATH,
    MODEL_REPO,
    VOLUME_NAME,
)
from infra.image import image

# Every file the vendor runtime opens, named individually so a partial fill is
# reported as the specific thing that is absent.
REQUIRED_FILES: Final[tuple[str, ...]] = (
    "config.json",
    "generation_config.json",
    "model-00001-of-00002.safetensors",
    "model-00002-of-00002.safetensors",
    "model.safetensors.index.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "audio_tokenizer/config.json",
    "audio_tokenizer/configuration.json",
    "audio_tokenizer/model.safetensors",
    "audio_tokenizer/preprocessor_config.json",
)

# The two shards plus the audio tokenizer are the bulk; anything much under
# this means an interrupted download that `snapshot_download` will happily
# leave in place.
MIN_TOTAL_BYTES: Final[int] = 7_000_000_000

volume: Final[modal.Volume] = modal.Volume.from_name(
    VOLUME_NAME, create_if_missing=True
)

app: Final[modal.App] = modal.App(f"{APP_NAME}-weights")


class CheckpointIncomplete(RuntimeError):
    """Raised when the Volume does not hold a usable checkpoint."""


@dataclass(frozen=True)
class CheckpointReport:
    """The result of inspecting a checkpoint directory.

    Attributes:
        root: The directory inspected.
        missing: Required files that are absent, in `REQUIRED_FILES` order.
        total_bytes: Sum of the sizes of the required files that are present.
    """

    root: Path
    missing: tuple[str, ...]
    total_bytes: int

    @property
    def complete(self) -> bool:
        """Whether every required file is present and the size is plausible."""
        return not self.missing and self.total_bytes >= MIN_TOTAL_BYTES


def inspect_checkpoint(root: Path | str) -> CheckpointReport:
    """Inspect a checkpoint directory without loading anything.

    Args:
        root: Directory that should contain the Breeze-TTS-2 checkpoint.

    Returns:
        A `CheckpointReport` naming whatever is absent.
    """
    base = Path(root)
    missing: list[str] = []
    total = 0
    for name in REQUIRED_FILES:
        path = base / name
        if not path.is_file():
            missing.append(name)
            continue
        total += path.stat().st_size
    return CheckpointReport(root=base, missing=tuple(missing), total_bytes=total)


def require_checkpoint(root: Path | str) -> CheckpointReport:
    """Assert that `root` holds a complete checkpoint.

    Args:
        root: Directory that should contain the checkpoint.

    Returns:
        The passing `CheckpointReport`.

    Raises:
        CheckpointIncomplete: With the absent files named. The bundled
            ``audio_tokenizer`` is called out separately because its absence is
            the failure most likely to be misread as a code fault.
    """
    report = inspect_checkpoint(root)
    if report.complete:
        return report

    if any(name.startswith("audio_tokenizer/") for name in report.missing):
        detail = (
            "the bundled audio_tokenizer/ directory is missing or partial. The "
            "vendor loader opens it directly and will raise a FileNotFoundError "
            "that does not read as a provisioning problem. "
        )
    else:
        detail = ""

    raise CheckpointIncomplete(
        f"checkpoint at {report.root} is incomplete. {detail}"
        f"missing: {', '.join(report.missing) or '(none)'}; "
        f"total size {report.total_bytes} bytes "
        f"(expected at least {MIN_TOTAL_BYTES}). "
        f"Fill it with: modal run infra/weights.py::fill"
    )


@app.function(
    image=image,
    volumes={MODEL_MOUNT_PATH: volume},
    timeout=60 * 60,
    # No GPU: this only moves bytes.
)
def fill(force: bool = False) -> dict[str, object]:
    """Download the checkpoint onto the Volume. Safe to re-run.

    ``snapshot_download`` skips files already present, so an interrupted
    download resumes rather than duplicating work. The model is ungated, so no
    token or licence acceptance is involved.

    Args:
        force: Re-download even when the checkpoint already verifies.

    Returns:
        A summary carrying the resolved path, file count and total bytes.
    """
    from huggingface_hub import snapshot_download

    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")

    existing = inspect_checkpoint(MODEL_DIR)
    if existing.complete and not force:
        print(f"checkpoint already complete at {MODEL_DIR}", flush=True)
        return {
            "path": MODEL_DIR,
            "skipped": True,
            "total_bytes": existing.total_bytes,
        }

    snapshot_download(
        repo_id=MODEL_REPO,
        local_dir=MODEL_DIR,
        allow_patterns=["*.json", "*.safetensors", "audio_tokenizer/*"],
    )
    volume.commit()

    report = require_checkpoint(MODEL_DIR)
    print(
        f"checkpoint filled at {MODEL_DIR}: {report.total_bytes} bytes",
        flush=True,
    )
    return {
        "path": MODEL_DIR,
        "skipped": False,
        "total_bytes": report.total_bytes,
    }


@app.function(image=image, volumes={MODEL_MOUNT_PATH: volume}, timeout=300)
def verify() -> dict[str, object]:
    """Report on the Volume's checkpoint without downloading anything.

    Returns:
        The report as a plain mapping, so ``modal run`` prints something
        legible rather than a repr.
    """
    report = inspect_checkpoint(MODEL_DIR)
    return {
        "path": str(report.root),
        "complete": report.complete,
        "missing": list(report.missing),
        "total_bytes": report.total_bytes,
    }


@app.local_entrypoint()
def main(force: bool = False) -> None:
    """Fill the Volume, then print the verification result.

    Args:
        force: Passed through to `fill`.
    """
    result = fill.remote(force=force)
    print(result)
    print(verify.remote())
