"""The runtime image's pins, and the properties they exist to guarantee."""

from __future__ import annotations

import ast
import re
from pathlib import Path

from infra.image import (
    FLASH_ATTN_WHEEL,
    PYTHON_VERSION,
    SERVICE_REQUIREMENTS,
    VENDOR_COMMIT,
    VENDOR_REQUIREMENTS,
    VENDOR_ROOT,
    build_image,
)
from infra.smoke_check import EXPECTED_VERSIONS


def test_python_is_pinned_to_the_only_version_with_a_wheel() -> None:
    # cp312 is the only Python published for the torch 2.9 flash-attn wheel,
    # so the interpreter version is a consequence of the dependency.
    assert PYTHON_VERSION == "3.12"
    assert "cp312-cp312" in FLASH_ATTN_WHEEL


def test_flash_attn_comes_from_a_prebuilt_multi_arch_wheel() -> None:
    # A source build would carry FLASH_ATTN_CUDA_ARCHS=90 and lock the image
    # to Hopper, which is what makes GPU type an image property rather than a
    # config value. The wheel URL is the whole defence.
    assert FLASH_ATTN_WHEEL.endswith(".whl")
    assert "cu12torch2.9" in FLASH_ATTN_WHEEL
    assert "linux_x86_64" in FLASH_ATTN_WHEEL
    assert "flash-attn" not in VENDOR_REQUIREMENTS
    assert not any(req.startswith("flash") for req in VENDOR_REQUIREMENTS)


def test_no_gpu_architecture_appears_anywhere_in_the_image_definition() -> None:
    blob = " ".join(
        (*VENDOR_REQUIREMENTS, *SERVICE_REQUIREMENTS, FLASH_ATTN_WHEEL, VENDOR_ROOT)
    )
    assert "FLASH_ATTN_CUDA_ARCHS" not in blob
    assert "sm90" not in blob.lower()


def test_vendor_pins_match_what_the_smoke_check_asserts() -> None:
    pinned = {
        name: version
        for name, _, version in (
            req.partition("==") for req in VENDOR_REQUIREMENTS
        )
        if version
    }
    for name, expected in EXPECTED_VERSIONS.items():
        if name == "flash-attn":
            assert expected in FLASH_ATTN_WHEEL
            continue
        assert pinned[name] == expected, f"{name} pin drifted from the smoke check"


def test_the_vendor_clone_is_pinned_to_a_commit() -> None:
    # An unpinned clone would make every rebuild a silent upgrade of the code
    # the recorded measurements were taken against.
    assert re.fullmatch(r"[0-9a-f]{40}", VENDOR_COMMIT)


def test_the_image_builds_as_a_definition_without_network_access() -> None:
    image = build_image()
    assert image is not None


def test_the_infra_package_is_shipped_into_the_container() -> None:
    """The image must carry this package, not just the entrypoint file.

    Modal stopped auto-mounting local Python packages in 1.0. Without an
    explicit `add_local_python_source`, the entrypoint arrives as a flat
    `/root/weights.py` with its siblings absent, and `from infra.config import
    ...` raises ModuleNotFoundError *inside the container* — after the image
    has built and the GPU has been requested. This is asserted on the image
    definition because nothing else in this suite can reach it: the failure
    lives on the far side of a deploy.
    """
    source = (Path(__file__).parent.parent / "image.py").read_text()
    module = ast.parse(source)
    calls = [
        node.func.attr
        for node in ast.walk(module)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    ]
    assert "add_local_python_source" in calls

    # And it must be the last layer: a local-file layer above a build step
    # would invalidate the 2.5 GB of wheels below it on every source edit.
    assert calls.index("add_local_python_source") == 0, (
        "add_local_python_source must be the outermost call in the chain"
    )


def test_the_warmup_profile_is_extended_for_the_reference_templates() -> None:
    """Clone and Direction need text-encoder batch 4, which the vendor never
    captures because its warmup_request is hardcoded to tts_instruction.

    Verified live before the fix: ref_edit_tata served at cfg 1.0 and raised
    `text encoder CUDA graph (4, 32) was not declared` at cfg 2.5 and 4.0.
    """
    from infra.extend_warmup_profile import (
        MAX_TOKEN_LENGTH,
        REFERENCE_BATCH_SIZE,
        extend,
    )

    assert REFERENCE_BATCH_SIZE == 4

    # A profile shaped like the vendor's: batch 1 and 2 only.
    profile = {
        "stages": {
            "text_encoder": {
                "graphs": [
                    {"batch_size": b, "token_length": n}
                    for b, limit in ((1, 256), (2, 512))
                    for n in range(32, limit + 1, 32)
                ]
            }
        }
    }
    extended, added = extend(profile)
    graphs = extended["stages"]["text_encoder"]["graphs"]
    lengths = [g["token_length"] for g in graphs if g["batch_size"] == 4]

    assert added == 16
    assert lengths == list(range(32, MAX_TOKEN_LENGTH + 1, 32))
    # Idempotent: a rebuild must not double the profile.
    assert extend(extended)[1] == 0


def test_the_profile_extension_runs_as_a_build_step() -> None:
    source = (Path(__file__).parent.parent / "image.py").read_text()
    assert "extend_warmup_profile.py" in source
    # After the clone, so it patches the vendor's own file rather than a copy
    # that would drift when VENDOR_COMMIT moves.
    assert source.index("git clone") < source.index("extend_warmup_profile.py")
