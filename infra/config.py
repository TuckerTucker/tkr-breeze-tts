"""Deployment configuration for the Breeze-TTS-2 Modal service.

One configuration surface for GPU type, warm behaviour, authentication and
fast-path posture, rather than decorator arguments spread through
``infra.service``. Every value is validated here so a bad setting fails at
import time with the allowed range named, rather than at ``modal deploy`` or —
worse — at the operator's first synthesis attempt.

This module deliberately imports nothing from ``modal``. It is read at
decoration time by the serving class and by the tests, and keeping it free of
the SDK is what makes both possible.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from typing import Final

import structlog

log = structlog.get_logger(__name__)

# GPU values Modal accepts for this workload. H100 carries the `!` suffix in
# `GPU_PIN_SUFFIX` when pinning is requested, which stops Modal auto-upgrading
# to an H200 and quietly invalidating a measurement run.
ALLOWED_GPUS: Final[frozenset[str]] = frozenset(
    {"H100", "H200", "L40S", "A100-40GB", "A100-80GB", "A10G", "L4"}
)

# Modal's own bounds for `scaledown_window`, in seconds.
MIN_SCALEDOWN_WINDOW_S: Final[int] = 2
MAX_SCALEDOWN_WINDOW_S: Final[int] = 20 * 60

# Proxy auth token pairs are prefixed `wk-`/`ws-`. A workspace *API* token uses
# `ak-`/`as-` and authenticates to nothing on a proxy-auth endpoint; the
# resulting 401 reads like a broken deployment rather than the wrong token, so
# the distinction is checked rather than discovered.
PROXY_KEY_PREFIX: Final[str] = "wk-"
PROXY_SECRET_PREFIX: Final[str] = "ws-"
API_TOKEN_KEY_PREFIX: Final[str] = "ak-"
API_TOKEN_SECRET_PREFIX: Final[str] = "as-"

APP_NAME: Final[str] = "breeze-tts"
MODEL_REPO: Final[str] = "BreezeBlue/Breeze-TTS-2"
VOLUME_NAME: Final[str] = "breeze-tts-weights"
MODEL_MOUNT_PATH: Final[str] = "/weights"
MODEL_DIR: Final[str] = f"{MODEL_MOUNT_PATH}/{MODEL_REPO.split('/')[-1]}"


class ConfigError(ValueError):
    """Raised when a deployment setting is outside its permitted range."""


@dataclass(frozen=True)
class FastPathConfig:
    """The vendor's five CUDA-graph stages, expressed as one posture.

    The vendor CLI exposes ``--fast-all`` plus five independent per-stage
    booleans. Five booleans are five ways to produce a half-warmed container
    whose latency is neither the fast-path figure nor the eager one. This
    collapses them: `all` is the shipped `--fast-all` posture, and the
    per-stage fields exist only for a deliberate, named exception.

    Attributes:
        all: Mirrors ``--fast-all``. ``None`` leaves the vendor default in
            place; ``True`` enables every stage.
        text_encoder: Per-stage override, used only when `all` is ``None``.
        backbone_prefill: Per-stage override.
        backbone_decode: Per-stage override.
        depth_decoder: Per-stage override.
        codec: Per-stage override.
    """

    all: bool | None = True
    text_encoder: bool = False
    backbone_prefill: bool = False
    backbone_decode: bool = False
    depth_decoder: bool = False
    codec: bool = False

    @property
    def enabled(self) -> bool:
        """Whether any CUDA-graph capture will happen at warmup."""
        if self.all is not None:
            return self.all
        return any(
            (
                self.text_encoder,
                self.backbone_prefill,
                self.backbone_decode,
                self.depth_decoder,
                self.codec,
            )
        )


@dataclass(frozen=True)
class ServiceConfig:
    """Everything the serving class needs at decoration time.

    Attributes:
        gpu: A member of `ALLOWED_GPUS`.
        pin_gpu: When true the GPU string carries Modal's ``!`` pin suffix, so
            an H100 request is never auto-upgraded to an H200. Measurements
            taken on one part are not claims about the other.
        scaledown_window_s: Idle seconds before Modal scales the container to
            zero. 600 is session-warm: one cold start per sitting, sized
            against a *measured* 166s cold start rather than a guess.

            The arithmetic is not a cost optimisation and should not be read
            as one. An H100 idles at $0.066/min and a cold start costs $0.182,
            so idle time overtakes cold-start cost at 2.8 minutes — on dollars
            alone the right window is *shorter* than this, not longer. What a
            10-minute window buys is the 2.8 minutes of operator attention a
            cold start costs, at a worst-case idle tail of $0.66. For a demo
            whose whole claim is sub-second latency, a wake that lands in the
            middle of a sitting is the failure that matters more than the
            cents. Lower it if the credit is the binding constraint.
        min_containers: Containers kept resident. ``None`` scales to zero. An
            always-on H100 is roughly $3.95/hr against ~$0.003 for the
            generation it serves, so this is an escape hatch, not a default.
        requires_proxy_auth: Modal web endpoints are public by default, and the
            Breeze-TTS-2 weights are research / non-commercial. Serving them on
            an open URL is a materially different act from running them
            locally, so this defaults on.
        timeout_s: Per-request ceiling. Generous, because a cold start's weight
            load and 53-graph capture happen inside the first request's window.
        fast: The CUDA-graph posture.
    """

    gpu: str = "H100"
    pin_gpu: bool = True
    scaledown_window_s: int = 600
    min_containers: int | None = None
    requires_proxy_auth: bool = True
    timeout_s: int = 900
    fast: FastPathConfig = field(default_factory=FastPathConfig)

    def __post_init__(self) -> None:
        if self.gpu not in ALLOWED_GPUS:
            raise ConfigError(
                f"unknown gpu {self.gpu!r}; allowed values are "
                f"{', '.join(sorted(ALLOWED_GPUS))}"
            )
        if not (
            MIN_SCALEDOWN_WINDOW_S
            <= self.scaledown_window_s
            <= MAX_SCALEDOWN_WINDOW_S
        ):
            raise ConfigError(
                f"scaledown_window_s {self.scaledown_window_s} is outside Modal's "
                f"permitted range {MIN_SCALEDOWN_WINDOW_S}..{MAX_SCALEDOWN_WINDOW_S} "
                "seconds"
            )
        if self.min_containers is not None and self.min_containers < 0:
            raise ConfigError("min_containers must be non-negative or None")

    @property
    def gpu_spec(self) -> str:
        """The string handed to Modal's ``gpu=`` argument."""
        return f"{self.gpu}!" if self.pin_gpu else self.gpu

    def with_overrides(self, **changes: object) -> ServiceConfig:
        """Return a validated copy with `changes` applied.

        Args:
            **changes: Field names and replacement values.

        Returns:
            A new, validated `ServiceConfig`.
        """
        return replace(self, **changes)  # type: ignore[arg-type]


def config_from_env(env: dict[str, str] | None = None) -> ServiceConfig:
    """Build a `ServiceConfig`, letting the environment override defaults.

    Changing `BREEZE_GPU` requires no image rebuild — the image carries no
    GPU-architecture assumption, because FlashAttention comes from a
    multi-arch prebuilt wheel rather than a source build pinned to SM90.

    Args:
        env: Environment mapping to read. Defaults to `os.environ`.

    Returns:
        The validated configuration.

    Raises:
        ConfigError: If any supplied value is outside its permitted range.
    """
    source = os.environ if env is None else env

    def _int(name: str) -> int | None:
        raw = source.get(name)
        if raw is None or raw.strip() == "":
            return None
        try:
            return int(raw)
        except ValueError as exc:
            raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc

    scaledown = _int("BREEZE_SCALEDOWN_WINDOW_S")
    min_containers = _int("BREEZE_MIN_CONTAINERS")
    timeout = _int("BREEZE_TIMEOUT_S")

    config = ServiceConfig(
        gpu=source.get("BREEZE_GPU", "H100"),
        pin_gpu=source.get("BREEZE_PIN_GPU", "1") not in {"0", "false", "False"},
        scaledown_window_s=600 if scaledown is None else scaledown,
        min_containers=min_containers,
        requires_proxy_auth=source.get("BREEZE_REQUIRES_PROXY_AUTH", "1")
        not in {"0", "false", "False"},
        timeout_s=900 if timeout is None else timeout,
    )
    log.info(
        "service_config.resolved",
        gpu=config.gpu_spec,
        scaledown_window_s=config.scaledown_window_s,
        min_containers=config.min_containers,
        requires_proxy_auth=config.requires_proxy_auth,
        fast_enabled=config.fast.enabled,
    )
    return config


def validate_proxy_token_pair(key: str | None, secret: str | None) -> None:
    """Check a proxy auth pair before it is ever used to authenticate.

    ``requires_proxy_auth`` closes the endpoint to everyone including us until
    a pair exists. The pair comes from
    ``modal workspace proxy-tokens create --json``; ``list`` and ``delete``
    are the rotation path. It is CLI-scriptable, not a dashboard errand.

    Args:
        key: The value intended for the ``Modal-Key`` header.
        secret: The value intended for the ``Modal-Secret`` header.

    Raises:
        ConfigError: If either half is absent, or carries the ``ak-``/``as-``
            API-token prefixes rather than the proxy ``wk-``/``ws-`` ones.
    """
    missing = [
        name
        for name, value in (("MODAL_KEY", key), ("MODAL_SECRET", secret))
        if not value
    ]
    if missing:
        raise ConfigError(
            f"missing {' and '.join(missing)}. Create a pair with: "
            "modal workspace proxy-tokens create --json"
        )
    assert key is not None and secret is not None

    if key.startswith(API_TOKEN_KEY_PREFIX) or secret.startswith(
        API_TOKEN_SECRET_PREFIX
    ):
        raise ConfigError(
            "MODAL_KEY/MODAL_SECRET carry the ak-/as- prefixes of a workspace API "
            "token. A proxy-auth endpoint does not accept API tokens — this pair "
            "authenticates to nothing. Create a proxy token pair instead: "
            "modal workspace proxy-tokens create --json"
        )
    if not key.startswith(PROXY_KEY_PREFIX) or not secret.startswith(
        PROXY_SECRET_PREFIX
    ):
        raise ConfigError(
            f"expected MODAL_KEY to start with {PROXY_KEY_PREFIX!r} and "
            f"MODAL_SECRET with {PROXY_SECRET_PREFIX!r}; got "
            f"{key[:3]!r} and {secret[:3]!r}. These come from "
            "modal workspace proxy-tokens create --json"
        )


SERVICE_CONFIG: Final[ServiceConfig] = config_from_env()
