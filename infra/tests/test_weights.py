"""Checkpoint completeness verification, run against a synthetic tree."""

from __future__ import annotations

from pathlib import Path

import pytest

from infra.weights import (
    MIN_TOTAL_BYTES,
    REQUIRED_FILES,
    CheckpointIncomplete,
    inspect_checkpoint,
    require_checkpoint,
)


def _make_checkpoint(root: Path, *, omit: tuple[str, ...] = ()) -> Path:
    """Write a checkpoint tree whose required files clear the size floor.

    The files are sparse: verification reads `st_size`, so allocating 7 GB of
    real blocks would only make the test slow.
    """
    size = MIN_TOTAL_BYTES // len(REQUIRED_FILES) + 1
    for name in REQUIRED_FILES:
        if name in omit:
            continue
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as handle:
            handle.truncate(size)
    return root


def test_a_complete_checkpoint_verifies(tmp_path: Path) -> None:
    report = require_checkpoint(_make_checkpoint(tmp_path))
    assert report.complete
    assert report.missing == ()
    assert report.total_bytes >= MIN_TOTAL_BYTES


def test_a_missing_audio_tokenizer_is_named_as_such(tmp_path: Path) -> None:
    _make_checkpoint(tmp_path, omit=("audio_tokenizer/model.safetensors",))
    with pytest.raises(CheckpointIncomplete) as excinfo:
        require_checkpoint(tmp_path)
    message = str(excinfo.value)
    assert "audio_tokenizer" in message
    # The point of the special-case: say it is provisioning, not a code fault.
    assert "provisioning" in message
    assert "modal run infra/weights.py::fill" in message


def test_a_missing_shard_is_named(tmp_path: Path) -> None:
    _make_checkpoint(tmp_path, omit=("model-00002-of-00002.safetensors",))
    with pytest.raises(CheckpointIncomplete) as excinfo:
        require_checkpoint(tmp_path)
    assert "model-00002-of-00002.safetensors" in str(excinfo.value)


def test_an_empty_directory_reports_every_required_file(tmp_path: Path) -> None:
    report = inspect_checkpoint(tmp_path)
    assert not report.complete
    assert report.missing == REQUIRED_FILES


def test_a_truncated_download_fails_the_size_floor(tmp_path: Path) -> None:
    for name in REQUIRED_FILES:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"stub")
    report = inspect_checkpoint(tmp_path)
    assert report.missing == ()
    assert not report.complete
    with pytest.raises(CheckpointIncomplete) as excinfo:
        require_checkpoint(tmp_path)
    assert str(MIN_TOTAL_BYTES) in str(excinfo.value)


def test_inspection_never_raises_on_a_path_that_does_not_exist(tmp_path: Path) -> None:
    report = inspect_checkpoint(tmp_path / "nope")
    assert not report.complete
    assert report.total_bytes == 0
