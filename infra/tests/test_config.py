"""Deployment configuration: defaults, bounds, and proxy-token prefixes."""

from __future__ import annotations

import pytest

from infra.config import (
    ALLOWED_GPUS,
    MAX_SCALEDOWN_WINDOW_S,
    MIN_SCALEDOWN_WINDOW_S,
    ConfigError,
    FastPathConfig,
    ServiceConfig,
    config_from_env,
    validate_proxy_token_pair,
)


def test_defaults_are_the_documented_posture() -> None:
    config = ServiceConfig()
    assert config.gpu == "H100"
    assert config.gpu_spec == "H100!"
    assert config.scaledown_window_s == 300
    assert config.min_containers is None
    assert config.requires_proxy_auth is True
    assert config.fast.enabled is True


def test_gpu_is_swappable_without_touching_the_image() -> None:
    # The multi-arch FlashAttention wheel is what buys this: no image field
    # exists on ServiceConfig at all, so a GPU change cannot imply a rebuild.
    for gpu in sorted(ALLOWED_GPUS):
        assert ServiceConfig(gpu=gpu).gpu == gpu
    assert not hasattr(ServiceConfig(), "image")


def test_unknown_gpu_is_rejected_with_the_allowed_set_named() -> None:
    with pytest.raises(ConfigError) as excinfo:
        ServiceConfig(gpu="RTX4090")
    assert "L40S" in str(excinfo.value)


def test_pinning_can_be_turned_off() -> None:
    assert ServiceConfig(pin_gpu=False).gpu_spec == "H100"


@pytest.mark.parametrize(
    "value", [MIN_SCALEDOWN_WINDOW_S - 1, MAX_SCALEDOWN_WINDOW_S + 1, 0, -5]
)
def test_out_of_range_scaledown_is_rejected_with_its_bound(value: int) -> None:
    with pytest.raises(ConfigError) as excinfo:
        ServiceConfig(scaledown_window_s=value)
    assert str(MAX_SCALEDOWN_WINDOW_S) in str(excinfo.value)


@pytest.mark.parametrize("value", [MIN_SCALEDOWN_WINDOW_S, 300, MAX_SCALEDOWN_WINDOW_S])
def test_in_range_scaledown_is_accepted(value: int) -> None:
    assert ServiceConfig(scaledown_window_s=value).scaledown_window_s == value


def test_negative_min_containers_is_rejected() -> None:
    with pytest.raises(ConfigError):
        ServiceConfig(min_containers=-1)


def test_always_on_is_available_but_opt_in() -> None:
    assert ServiceConfig().min_containers is None
    assert ServiceConfig(min_containers=1).min_containers == 1


def test_fast_path_is_one_setting_not_five_booleans() -> None:
    assert FastPathConfig().enabled is True
    assert FastPathConfig(all=False).enabled is False
    assert FastPathConfig(all=None).enabled is False
    assert FastPathConfig(all=None, codec=True).enabled is True


def test_env_overrides_are_parsed_and_validated() -> None:
    config = config_from_env(
        {
            "BREEZE_GPU": "L40S",
            "BREEZE_PIN_GPU": "0",
            "BREEZE_SCALEDOWN_WINDOW_S": "600",
            "BREEZE_MIN_CONTAINERS": "1",
        }
    )
    assert config.gpu_spec == "L40S"
    assert config.scaledown_window_s == 600
    assert config.min_containers == 1


def test_env_defaults_match_the_dataclass_defaults() -> None:
    assert config_from_env({}) == ServiceConfig()


def test_non_integer_env_value_names_the_variable() -> None:
    with pytest.raises(ConfigError) as excinfo:
        config_from_env({"BREEZE_SCALEDOWN_WINDOW_S": "five minutes"})
    assert "BREEZE_SCALEDOWN_WINDOW_S" in str(excinfo.value)


def test_a_proxy_pair_with_the_right_prefixes_passes() -> None:
    validate_proxy_token_pair("wk-abc123", "ws-def456")


def test_an_api_token_pair_is_refused_with_the_distinction_named() -> None:
    with pytest.raises(ConfigError) as excinfo:
        validate_proxy_token_pair("ak-abc123", "as-def456")
    message = str(excinfo.value)
    assert "API token" in message
    assert "proxy-tokens create" in message


def test_a_missing_half_names_the_variable_and_the_remedy() -> None:
    with pytest.raises(ConfigError) as excinfo:
        validate_proxy_token_pair("wk-abc123", None)
    assert "MODAL_SECRET" in str(excinfo.value)
    assert "proxy-tokens create" in str(excinfo.value)


def test_a_wrong_prefix_that_is_neither_is_still_refused() -> None:
    with pytest.raises(ConfigError):
        validate_proxy_token_pair("abc123", "def456")
