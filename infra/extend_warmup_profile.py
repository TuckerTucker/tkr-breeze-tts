"""Add the text-encoder shapes the reference templates need.

The vendor's ``configs/fast.json`` captures the text encoder at batch 1 and
batch 2 only, because its ``warmup_request`` is hardcoded to the
``tts_instruction`` template. ``ref_edit_tata`` — the template behind both
Clone and Direction — is never warmed, and with ``freeze_after_warmup`` an
uncaptured shape *raises* rather than falling back:

    RuntimeError: text encoder CUDA graph (4, 32) was not declared in the
    warmup profile

The text-encoder batch is the number of **text segments across all branches**:

===================  ====  ===================  =========================
template             mode  cfg 1.0 (1 branch)   cfg != 1.0 (dual branch)
===================  ====  ===================  =========================
tts_instruction      1 seg batch 1              batch 2
ref_edit_tata        2 seg batch 2              batch 4
===================  ====  ===================  =========================

``_ref_edit_tata_dual_branches`` returns uncond (1 text segment), ref (2), and
ins (1) — four in total, which is exactly the ``(4, 32)`` the runtime asked
for. Clone works at cfg 1.0 today only by coincidence: its two segments happen
to land on a batch-2 graph captured for the *other* template.

Only the text encoder needs new shapes. ``warmup_from_profile`` builds its
backbone graphs from ``cfg_scale_by_batch``, which keys on 1 and 2 regardless
of segment count, so the backbone and depth-decoder stages already cover both
templates.

This patches the vendor's own file in place at build time rather than shipping
a hand-copied replacement, so a bump of ``VENDOR_COMMIT`` keeps whatever the
vendor changed and only re-applies the addition.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Final

# The batch the reference templates need under dual-branch CFG.
REFERENCE_BATCH_SIZE: Final[int] = 4

# `TextEncoderGraphCache` buckets to multiples of 32, so declared lengths must
# be multiples of 32. Matching batch 2's ceiling keeps the reference modes on
# the same 512-token budget as everything else at cfg != 1.0.
TOKEN_GRANULARITY: Final[int] = 32
MAX_TOKEN_LENGTH: Final[int] = 512


def extend(profile: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Add batch-4 text-encoder graphs to a parsed warmup profile.

    Args:
        profile: The parsed ``fast.json``.

    Returns:
        The profile and how many graphs were added. Idempotent: re-running
        adds nothing.
    """
    graphs = profile["stages"]["text_encoder"]["graphs"]
    present = {(g["batch_size"], g["token_length"]) for g in graphs}

    added = 0
    for token_length in range(
        TOKEN_GRANULARITY, MAX_TOKEN_LENGTH + 1, TOKEN_GRANULARITY
    ):
        key = (REFERENCE_BATCH_SIZE, token_length)
        if key in present:
            continue
        graphs.append(
            {"batch_size": REFERENCE_BATCH_SIZE, "token_length": token_length}
        )
        added += 1

    graphs.sort(key=lambda g: (g["batch_size"], g["token_length"]))
    return profile, added


def main() -> None:
    """Patch the profile named on argv, in place.

    Raises:
        SystemExit: Non-zero if the file is missing or unparseable, so the
            image build fails here rather than at first Clone request.
    """
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/breeze-infer/configs/fast.json")
    if not path.is_file():
        raise SystemExit(f"warmup profile not found at {path}")

    profile = json.loads(path.read_text())
    before = len(profile["stages"]["text_encoder"]["graphs"])
    profile, added = extend(profile)
    after = len(profile["stages"]["text_encoder"]["graphs"])

    path.write_text(json.dumps(profile, indent=2) + "\n")
    total = sum(
        len(stage.get("graphs", [])) for stage in profile["stages"].values()
    )
    print(
        f"warmup profile extended: text_encoder {before} -> {after} graphs "
        f"(+{added} at batch_size={REFERENCE_BATCH_SIZE}); "
        f"{total} graphs declared in total",
        flush=True,
    )


if __name__ == "__main__":
    main()
