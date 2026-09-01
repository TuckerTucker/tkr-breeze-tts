"""The recognition service: its posture, its completeness check, its pins.

No GPU and no network. The Modal objects are only constructed, the model
directory is a fixture on disk, and the response shape is asserted against a
stand-in for the runtime — the same discipline the synthesis tests keep.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from infra.asr_image import (
    ASR_REQUIREMENTS,
    CUDA_REQUIREMENTS,
    NVIDIA_LIB_PATH,
    PYTHON_VERSION,
)
from infra.asr_smoke_check import EXPECTED_VERSIONS, REQUIRED_LIBRARIES
from infra.asr_weights import (
    ASR_MIN_TOTAL_BYTES,
    ASR_REQUIRED_FILES,
    AsrModelIncomplete,
    inspect_asr_model,
    require_asr_model,
)
from infra.config import (
    ALLOWED_COMPUTE_TYPES,
    ASR_APP_NAME,
    ASR_MODEL_DIR,
    ASR_MODEL_REPO,
    AsrConfig,
    ConfigError,
    MODEL_MOUNT_PATH,
    VOLUME_NAME,
    asr_config_from_env,
)


# ── Posture ──────────────────────────────────────────────────────────────────


def test_the_defaults_are_a_once_per_sitting_workload_not_an_interactive_one() -> None:
    config = AsrConfig()
    # An L4, not the synthesis service's H100: transcription is not the latency
    # claim this demo makes, and an H100 for it is waste.
    assert config.gpu == "L4"
    # A short window, and deliberately the opposite of the 600s the synthesis
    # service holds. A reference is transcribed once at the start of a sitting,
    # so a long window would idle a GPU through the session it is not wanted for.
    assert config.scaledown_window_s == 120
    assert config.min_containers is None


def test_the_endpoint_is_closed_by_default() -> None:
    # It reads audio the operator supplied. An open URL that transcribes
    # anything is a service, not a demo.
    assert AsrConfig().requires_proxy_auth is True


def test_the_gpu_is_pinned_so_a_measurement_names_the_part_it_ran_on() -> None:
    assert AsrConfig().gpu_spec == "L4!"
    assert AsrConfig(pin_gpu=False).gpu_spec == "L4"


@pytest.mark.parametrize(
    "field,value",
    [
        ("gpu", "T4"),
        ("scaledown_window_s", 0),
        ("scaledown_window_s", 60 * 60),
        ("compute_type", "fp16"),
        ("beam_size", 0),
    ],
)
def test_a_bad_setting_fails_at_import_not_at_first_transcription(
    field: str, value: object
) -> None:
    # Every one of these would otherwise surface inside the container, after
    # the GPU has been requested. `fp16` in particular is the plausible typo:
    # CTranslate2 accepts `float16` and nothing else spelled that way.
    with pytest.raises(ConfigError):
        AsrConfig(**{field: value})  # type: ignore[arg-type]


def test_every_permitted_compute_type_constructs() -> None:
    for compute_type in ALLOWED_COMPUTE_TYPES:
        assert AsrConfig(compute_type=compute_type).compute_type == compute_type


def test_the_environment_overrides_without_an_image_rebuild() -> None:
    config = asr_config_from_env(
        {
            "BREEZE_ASR_GPU": "A10G",
            "BREEZE_ASR_SCALEDOWN_WINDOW_S": "300",
            "BREEZE_ASR_COMPUTE_TYPE": "int8_float16",
            "BREEZE_ASR_PIN_GPU": "0",
        }
    )
    assert config.gpu_spec == "A10G"
    assert config.scaledown_window_s == 300
    assert config.compute_type == "int8_float16"


def test_a_non_integer_window_is_named_rather_than_coerced() -> None:
    with pytest.raises(ConfigError, match="must be an integer"):
        asr_config_from_env({"BREEZE_ASR_SCALEDOWN_WINDOW_S": "ten minutes"})


# ── The Volume it shares ─────────────────────────────────────────────────────


def test_the_model_sits_on_the_synthesis_volume_under_its_own_directory() -> None:
    from infra.asr_weights import volume as asr_volume
    from infra.weights import volume as breeze_volume

    # Imported, not redefined. One Volume keeps setup to one place; a second
    # would be a second fill to remember for no benefit either model wants.
    assert asr_volume is breeze_volume
    assert VOLUME_NAME == "breeze-tts-weights"
    assert ASR_MODEL_DIR.startswith(f"{MODEL_MOUNT_PATH}/")
    assert ASR_MODEL_DIR != MODEL_MOUNT_PATH


def test_the_app_is_a_sibling_so_redeploying_one_leaves_the_other_running() -> None:
    from infra.service import app as tts_app

    from infra.asr import app as asr_app

    assert asr_app.name == ASR_APP_NAME
    assert asr_app.name != tts_app.name


# ── Completeness ─────────────────────────────────────────────────────────────


def _write_model(root: Path, *, omit: str | None = None, bin_bytes: int | None = None) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for name in ASR_REQUIRED_FILES:
        if name == omit:
            continue
        path = root / name
        if name == "model.bin":
            path.write_bytes(b"\0" * (ASR_MIN_TOTAL_BYTES if bin_bytes is None else bin_bytes))
        else:
            path.write_text(json.dumps({"stub": True}))
    return root


def test_a_complete_model_verifies(tmp_path: Path) -> None:
    report = require_asr_model(_write_model(tmp_path / "model"))
    assert report.complete
    assert report.missing == ()


def test_a_missing_model_bin_is_named_as_nothing_downloaded(tmp_path: Path) -> None:
    root = _write_model(tmp_path / "model", omit="model.bin")
    with pytest.raises(AsrModelIncomplete) as raised:
        require_asr_model(root)
    assert "model.bin" in str(raised.value)
    assert "nothing was downloaded" in str(raised.value)
    # The remedy is one command, not a description of one.
    assert "modal run infra/asr_weights.py::fill" in str(raised.value)


def test_a_truncated_model_bin_reads_as_an_interrupted_download(tmp_path: Path) -> None:
    # The failure this check mainly exists for: every file present, so a
    # file-count check would pass, and the runtime would raise from inside a
    # binary about an offset instead.
    root = _write_model(tmp_path / "model", bin_bytes=1024)
    with pytest.raises(AsrModelIncomplete, match="interrupted download"):
        require_asr_model(root)


def test_the_tokenizer_is_required_by_name(tmp_path: Path) -> None:
    # This conversion ships vocabulary.json where older ones shipped
    # vocabulary.txt. Verified against the repo listing rather than assumed.
    assert "vocabulary.json" in ASR_REQUIRED_FILES
    root = _write_model(tmp_path / "model", omit="tokenizer.json")
    assert inspect_asr_model(root).missing == ("tokenizer.json",)


def test_an_absent_directory_is_incomplete_rather_than_an_error(tmp_path: Path) -> None:
    report = inspect_asr_model(tmp_path / "nothing-here")
    assert not report.complete
    assert set(report.missing) == set(ASR_REQUIRED_FILES)


# ── Image ────────────────────────────────────────────────────────────────────


def test_the_runtime_is_pinned_and_the_smoke_check_asserts_the_same_pins() -> None:
    # Two lists that drift would let the build pass while the image carried a
    # version the pin did not promise.
    for name, version in EXPECTED_VERSIONS.items():
        assert f"{name}=={version}" in ASR_REQUIREMENTS


def test_cudnn_is_installed_explicitly_because_nothing_else_pulls_it_in() -> None:
    # faster-whisper does not depend on torch, so unlike the synthesis image
    # nothing here gets CUDA libraries for free. Without these, ctranslate2
    # imports cleanly and raises only when a model reaches a device.
    assert any("cudnn" in requirement for requirement in CUDA_REQUIREMENTS)
    assert any("cublas" in requirement for requirement in CUDA_REQUIREMENTS)


def test_the_loader_path_covers_both_wheels_at_the_pinned_interpreter() -> None:
    # Installed is not loadable: CTranslate2 dlopens by soname, so the wheels'
    # lib directories have to be on LD_LIBRARY_PATH of the running process.
    assert f"python{PYTHON_VERSION}" in NVIDIA_LIB_PATH
    assert "cudnn/lib" in NVIDIA_LIB_PATH
    assert "cublas/lib" in NVIDIA_LIB_PATH


def test_the_smoke_check_looks_for_the_libraries_that_fail_late() -> None:
    assert "libcudnn_ops.so.9" in REQUIRED_LIBRARIES
    assert any(lib.startswith("libcublas") for lib in REQUIRED_LIBRARIES)


def test_the_image_carries_no_synthesis_dependency() -> None:
    # It shares a Volume and a token pair with the synthesis image. It shares
    # no runtime: no torch, no FlashAttention, no vendor clone.
    joined = " ".join(ASR_REQUIREMENTS + CUDA_REQUIREMENTS)
    assert "torch" not in joined
    assert "flash" not in joined


def test_the_model_repo_is_the_ctranslate2_conversion() -> None:
    # Not openai/whisper-large-v3: WhisperModel loads a CTranslate2 conversion,
    # and pointing at the transformers checkpoint fails at load.
    assert ASR_MODEL_REPO == "Systran/faster-whisper-large-v3"
    assert ASR_MODEL_DIR.endswith("faster-whisper-large-v3")
