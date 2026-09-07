"""Slice 3 — the hosting app's decoration-time posture.

Modal objects are constructed and never called, matching the standing rule that
no test needs a GPU, an external network, or a deployed service.

The asymmetries are what these assert. Two of them separate this app from the
synthesis and recognition apps, and both would be actively harmful if someone
"made them consistent": concurrency is high here and 1 there, and proxy auth is
off here and on there.
"""

from __future__ import annotations

import pytest

from infra.config import ConfigError, HostingConfig, config_from_env, hosting_config_from_env


class TestHostingConfig:
    """The posture the gateway's stores actually require."""

    def test_defaults_are_the_shipped_posture(self) -> None:
        config = hosting_config_from_env({})
        assert config.max_containers == 1
        assert config.min_containers == 1
        assert config.requires_proxy_auth is False
        assert config.max_concurrent_inputs > 1

    def test_concurrency_is_high_here_and_one_on_the_gpu_apps(self) -> None:
        """The asymmetry is the point, and a test is what stops it being 'fixed'.

        The standing "no @modal.concurrent" rule belongs to the synthesis and
        recognition apps, where the vendor holds a process-wide lock. Carried
        onto a web server it would let one streaming synthesis block every asset
        load and every other visitor.
        """
        hosting = hosting_config_from_env({})
        assert hosting.max_concurrent_inputs >= 2

    def test_proxy_auth_is_off_here_and_on_for_synthesis(self) -> None:
        """The security decision, pinned where it can be read.

        Proxy auth on this endpoint would demand a wk-/ws- pair in the browser,
        which is precisely what the gateway exists to prevent.
        """
        assert hosting_config_from_env({}).requires_proxy_auth is False
        assert config_from_env({}).requires_proxy_auth is True

    def test_a_second_container_is_refused(self) -> None:
        """Two replicas over one Volume would each hold a stale in-memory index."""
        with pytest.raises(ConfigError, match="max_containers must be 1"):
            HostingConfig(max_containers=2)

    def test_scaling_to_zero_is_allowed_and_is_the_operator_s_call(self) -> None:
        """min_containers is a posture choice, not a correctness requirement.

        It was once refused outright, which encoded a preference as a rule. The
        resident container costs about 87 minutes of H100 headroom a month out
        of the Starter plan's credits — worth it for a link handed out often,
        not for one that sits idle. That trade belongs to the operator.
        """
        assert HostingConfig(min_containers=0).min_containers == 0

    def test_a_negative_container_count_is_still_refused(self) -> None:
        with pytest.raises(ConfigError, match="non-negative"):
            HostingConfig(min_containers=-1)

    def test_the_resident_container_is_the_default(self) -> None:
        """Defaulting to 0 would make every first visitor wait; the default
        stays 1 and scaling down is opt-in."""
        assert hosting_config_from_env({}).min_containers == 1

    def test_min_containers_is_environment_driven(self) -> None:
        assert hosting_config_from_env({"BREEZE_HOSTING_MIN_CONTAINERS": "0"}).min_containers == 0

    def test_serialising_requests_is_refused(self) -> None:
        with pytest.raises(ConfigError, match="concurrency 1"):
            HostingConfig(max_concurrent_inputs=1)

    def test_enabling_proxy_auth_is_refused(self) -> None:
        with pytest.raises(ConfigError, match="requires_proxy_auth must be False"):
            HostingConfig(requires_proxy_auth=True)

    def test_environment_overrides_are_validated(self) -> None:
        config = hosting_config_from_env(
            {"GATEWAY_PORT": "9000", "BREEZE_HOSTING_CONCURRENCY": "40"}
        )
        assert config.port == 9000
        assert config.max_concurrent_inputs == 40

    def test_a_non_integer_override_names_the_variable(self) -> None:
        with pytest.raises(ConfigError, match="GATEWAY_PORT"):
            hosting_config_from_env({"GATEWAY_PORT": "eight thousand"})


class TestStoreEnvironment:
    """Where the gateway is told to put its state."""

    def test_every_store_resolves_beneath_the_mount(self) -> None:
        from infra.hosting import STORE_ENV
        from infra.hosting_image import STATE_MOUNT_PATH

        for name in (
            "CLIP_CACHE_DIR",
            "VOICE_STORE_DIR",
            "SCRIPT_STORE_DIR",
            "REFERENCE_STORE_DIR",
        ):
            assert STORE_ENV[name].startswith(f"{STATE_MOUNT_PATH}/")

    def test_ui_and_findings_resolve_into_the_image_not_the_volume(self) -> None:
        """They ship with the build and are not state; on the Volume they would
        survive a rebuild that was meant to replace them."""
        from infra.hosting import STORE_ENV
        from infra.hosting_image import FINDINGS_DIR, STATE_MOUNT_PATH, UI_DIR

        assert STORE_ENV["UI_DIST_DIR"] == UI_DIR
        assert STORE_ENV["BENCH_FINDINGS_DIR"] == FINDINGS_DIR
        for name in ("UI_DIST_DIR", "BENCH_FINDINGS_DIR"):
            assert not STORE_ENV[name].startswith(f"{STATE_MOUNT_PATH}/")

    def test_every_path_is_absolute(self) -> None:
        """config.ts resolves a relative store path against a REPO_ROOT derived
        from its own module location, which in a container is not a layout
        anyone should have to reason about."""
        from infra.hosting import STORE_ENV

        for name, value in STORE_ENV.items():
            if name.endswith("_DIR"):
                assert value.startswith("/"), f"{name} is not absolute"

    def test_the_bind_host_is_the_wildcard_modal_requires(self) -> None:
        from infra.hosting import STORE_ENV

        assert STORE_ENV["GATEWAY_HOST"] == "0.0.0.0"


class TestVolumes:
    """State and weights are separate Volumes, deliberately."""

    def test_the_state_volume_is_not_the_weights_volume(self) -> None:
        """Weights are a 7.7 GB read-mostly fill; gateway state is small and
        written constantly. One Volume for both would make every clip write
        contend with a checkpoint."""
        from infra.config import VOLUME_NAME
        from infra.hosting import STATE_VOLUME_NAME

        assert STATE_VOLUME_NAME != VOLUME_NAME

    def test_the_mount_path_is_not_the_model_mount_path(self) -> None:
        from infra.config import MODEL_MOUNT_PATH
        from infra.hosting_image import STATE_MOUNT_PATH

        assert STATE_MOUNT_PATH != MODEL_MOUNT_PATH


class TestNoCommitTheatre:
    """Durability is the platform's job here, not the Python process's."""

    def test_the_module_calls_no_volume_commit(self) -> None:
        """A commit issued from a process that does not own the writes would be
        theatre. The window this leaves is stated in the runbook instead."""
        import ast
        from pathlib import Path

        # Parsed rather than grepped: the module's own docstring explains why it
        # calls no commit, and a text search trips over the explanation.
        tree = ast.parse((Path(__file__).resolve().parent.parent / "hosting.py").read_text())
        called = {
            node.func.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        assert "commit" not in called
