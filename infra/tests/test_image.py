"""The runtime image's pins, and the properties they exist to guarantee."""

from __future__ import annotations

import re

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
