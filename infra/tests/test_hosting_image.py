"""Slice 1 — the hosting image.

The image is described but never built here, matching the standing rule that no
test needs a network or a GPU. What is asserted is the recipe: that the things
whose absence is silent at runtime are present in it, and that the layer order
the build relies on for cache reuse actually holds.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from infra import hosting_image

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
IMAGE_SOURCE = (Path(hosting_image.__file__)).read_text()


def _shell_commands() -> list[str]:
    """Collect the literal shell commands the image runs.

    Read from the syntax tree rather than by searching the source text: the
    module's own prose describes what it installs, and a text search matches the
    explanation as readily as the instruction.

    Returns:
        Every string literal passed to a `run_commands` step.
    """
    tree = ast.parse(IMAGE_SOURCE)
    commands: list[str] = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr != "run_commands":
            continue
        for argument in node.args:
            commands.append(ast.unparse(argument))
    return commands


def _build_steps() -> list[str]:
    """Flatten the chained image builder into an ordered list of step names.

    Returns:
        Method names in the order `build_hosting_image` chains them.
    """
    tree = ast.parse(IMAGE_SOURCE)
    function = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "build_hosting_image"
    )
    steps: list[str] = []
    for node in ast.walk(function):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            steps.append(node.func.attr)
    # ast.walk yields the outermost call first; the chain reads inner-to-outer.
    return list(reversed(steps))


class TestRuntime:
    """What the gateway expects to find that a bare container does not have."""

    def test_node_major_satisfies_the_gateway_engine_range(self) -> None:
        """The declared Node version is the manifest's, not a guess."""
        manifest = json.loads((REPO_ROOT / "gateway" / "package.json").read_text())
        required = manifest["engines"]["node"]
        minimum = int(required.lstrip(">=^~").split(".")[0])
        assert int(hosting_image.NODE_MAJOR) >= minimum

    def test_ffmpeg_is_installed(self) -> None:
        """Not optional here: without it the gateway degrades to WAV-only and
        says so in a log line nobody reads in a container."""
        tree = ast.parse(IMAGE_SOURCE)
        apt_packages = {
            ast.literal_eval(argument)
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "apt_install"
            for argument in node.args
            if isinstance(argument, ast.Constant)
        }
        assert "ffmpeg" in apt_packages

    def test_dependencies_come_from_the_lockfile(self) -> None:
        """`npm ci`, not `npm install`: the hosted runtime must be the pinned
        set rather than whatever resolves on build day."""
        commands = _shell_commands()
        assert any("npm ci" in command for command in commands)
        assert not any("npm install" in command for command in commands)
        assert (REPO_ROOT / "gateway" / "package-lock.json").is_file()

    def test_the_compiler_is_pruned_after_the_build(self) -> None:
        """TypeScript is a devDependency; the image ships compiled JavaScript."""
        commands = _shell_commands()
        assert any("tsc" in command for command in commands)
        assert any("npm prune --omit=dev" in command for command in commands)


class TestLayerOrder:
    """The property the build relies on for cache reuse."""

    def test_the_npm_install_sits_below_the_source_copy(self) -> None:
        """So editing a route rebuilds only the cheap layer."""
        steps = _build_steps()
        # The manifests are added, then installed, then the source arrives.
        install_index = next(
            i for i, step in enumerate(steps) if step == "run_commands"
        )
        source_copy_index = next(
            i for i, step in enumerate(steps) if step == "add_local_dir"
        )
        assert install_index < source_copy_index

    def test_the_smoke_check_is_the_final_build_step(self) -> None:
        """A missing ffmpeg or an unbuilt UI must fail `modal deploy`, not the
        first visitor."""
        assert IMAGE_SOURCE.index("hosting_smoke_check.py") < IMAGE_SOURCE.index(
            "add_local_python_source"
        )

    def test_local_python_source_is_mounted_last(self) -> None:
        """Declared last so it mounts at runtime and never invalidates a build
        layer — the same reason infra/image.py orders it there."""
        steps = _build_steps()
        assert steps[-1] == "add_local_python_source"


class TestPublishedPaths:
    """This module's contract with infra/hosting.py."""

    def test_the_in_image_paths_are_absolute(self) -> None:
        for path in (
            hosting_image.GATEWAY_ROOT,
            hosting_image.UI_DIR,
            hosting_image.FINDINGS_DIR,
            hosting_image.STATE_MOUNT_PATH,
        ):
            assert path.startswith("/")

    def test_hosting_points_configuration_at_exactly_these_paths(self) -> None:
        """Rather than each module assuming where the other put things."""
        from infra.hosting import STORE_ENV

        assert STORE_ENV["UI_DIST_DIR"] == hosting_image.UI_DIR
        assert STORE_ENV["BENCH_FINDINGS_DIR"] == hosting_image.FINDINGS_DIR

    def test_the_ui_and_findings_are_distinct_locations(self) -> None:
        assert hosting_image.UI_DIR != hosting_image.FINDINGS_DIR


class TestSmokeCheck:
    """The build-time check itself, exercised without building an image."""

    def test_it_rejects_a_missing_ui(self, tmp_path: Path, monkeypatch) -> None:
        from infra import hosting_smoke_check

        monkeypatch.setattr(hosting_smoke_check, "UI_DIR", tmp_path / "absent")
        with pytest.raises(RuntimeError, match="npm --prefix ui run build"):
            hosting_smoke_check.check_ui()

    def test_it_rejects_a_ui_that_lost_the_worklet(self, tmp_path: Path, monkeypatch) -> None:
        """pcm-processor.js is served untransformed and deliberately not
        bundled, so its absence surfaces only at first playback."""
        from infra import hosting_smoke_check

        (tmp_path / "index.html").write_text("<!doctype html>")
        monkeypatch.setattr(hosting_smoke_check, "UI_DIR", tmp_path)
        with pytest.raises(RuntimeError, match="pcm-processor"):
            hosting_smoke_check.check_ui()

    def test_it_rejects_missing_findings(self, tmp_path: Path, monkeypatch) -> None:
        from infra import hosting_smoke_check

        monkeypatch.setattr(hosting_smoke_check, "FINDINGS_DIR", tmp_path)
        with pytest.raises(RuntimeError, match="not yet measured"):
            hosting_smoke_check.check_findings()

    def test_it_rejects_findings_that_do_not_parse(self, tmp_path: Path, monkeypatch) -> None:
        from infra import hosting_smoke_check

        (tmp_path / "latency.json").write_text("{not json")
        monkeypatch.setattr(hosting_smoke_check, "FINDINGS_DIR", tmp_path)
        with pytest.raises(RuntimeError, match="does not parse"):
            hosting_smoke_check.check_findings()

    def test_it_accepts_a_complete_image(self, tmp_path: Path, monkeypatch) -> None:
        """A check that has never passed deliberately is not known to work
        either."""
        from infra import hosting_smoke_check

        ui = tmp_path / "ui"
        ui.mkdir()
        (ui / "index.html").write_text("<!doctype html>")
        (ui / "pcm-processor.js").write_text("// worklet")
        findings = tmp_path / "findings"
        findings.mkdir()
        (findings / "latency.json").write_text('{"warm_ttfa_ms": 161}')

        monkeypatch.setattr(hosting_smoke_check, "UI_DIR", ui)
        monkeypatch.setattr(hosting_smoke_check, "FINDINGS_DIR", findings)
        hosting_smoke_check.check_ui()
        assert hosting_smoke_check.check_findings() == 1


class TestEntrypointImports:
    """The container imports infra/hosting.py, which imports infra/config.py.

    This class exists because of a real failure: the image built cleanly, the
    build-time smoke check passed, and every unit test passed — then the
    container crash-looped on `ModuleNotFoundError: No module named 'structlog'`
    before the gateway was ever spawned. Nothing caught it because the tests run
    in a venv where structlog is installed. The requirement is therefore derived
    from config.py's own imports rather than restated, so the two cannot drift.
    """

    @staticmethod
    def _third_party_imports(path: Path) -> set[str]:
        """Collect module-scope imports that are neither stdlib nor local.

        Args:
            path: The module to inspect.

        Returns:
            Distribution-ish top-level module names.
        """
        import sys

        tree = ast.parse(path.read_text())
        modules: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                modules.add(node.module.split(".")[0])
        return {
            m
            for m in modules
            if m not in sys.stdlib_module_names and m not in {"infra", "modal"}
        }

    def test_the_image_installs_everything_config_imports(self) -> None:
        """Derived, not restated: adding an import to config.py fails this."""
        needed = self._third_party_imports(REPO_ROOT / "infra" / "config.py")
        installed = {
            requirement.split(">=")[0].split("==")[0].strip()
            for requirement in hosting_image.ENTRYPOINT_REQUIREMENTS
        }
        missing = needed - installed
        assert not missing, (
            f"infra/config.py imports {sorted(missing)} at module scope, but the "
            "hosting image does not install it. The container imports config.py to "
            "find the decorated function, so this crash-loops before the gateway "
            "starts — and it does so only in the container, never in the tests."
        )

    def test_the_image_installs_everything_hosting_imports(self) -> None:
        """The entrypoint module itself, by the same rule."""
        needed = self._third_party_imports(REPO_ROOT / "infra" / "hosting.py")
        installed = {
            requirement.split(">=")[0].split("==")[0].strip()
            for requirement in hosting_image.ENTRYPOINT_REQUIREMENTS
        }
        assert not needed - installed

    def test_the_requirements_are_pinned_at_a_floor(self) -> None:
        for requirement in hosting_image.ENTRYPOINT_REQUIREMENTS:
            assert (">=" in requirement) or ("==" in requirement)


class TestEntrypointCheck:
    """The check that would have caught the crash-loop."""

    def test_it_rejects_an_image_whose_entry_point_is_misplaced(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        """Reproduces the real failure: tsc emitted dist/src/index.js because the
        repo tsconfig sets rootDir "." for local development, and hosting.py runs
        dist/index.js. The message names where it actually landed, because
        'missing' alone would send someone looking for a build that succeeded."""
        from infra import hosting_smoke_check

        (tmp_path / "dist" / "src").mkdir(parents=True)
        (tmp_path / "dist" / "src" / "index.js").write_text("// wrong place")
        monkeypatch.setattr(hosting_smoke_check, "GATEWAY_ROOT", tmp_path)

        with pytest.raises(RuntimeError, match="dist/src/index.js"):
            hosting_smoke_check.check_entrypoint()

    def test_it_rejects_a_dist_that_was_never_built(self, tmp_path: Path, monkeypatch) -> None:
        from infra import hosting_smoke_check

        (tmp_path / "dist").mkdir()
        monkeypatch.setattr(hosting_smoke_check, "GATEWAY_ROOT", tmp_path)
        with pytest.raises(RuntimeError, match="nowhere"):
            hosting_smoke_check.check_entrypoint()

    def test_it_accepts_the_entry_point_hosting_actually_runs(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        from infra import hosting_smoke_check

        (tmp_path / "dist").mkdir()
        (tmp_path / "dist" / "index.js").write_text("// right place")
        monkeypatch.setattr(hosting_smoke_check, "GATEWAY_ROOT", tmp_path)
        hosting_smoke_check.check_entrypoint()

    def test_the_image_build_pins_the_entry_point_path(self) -> None:
        """The build must not inherit the repo tsconfig's local-dev layout."""
        commands = _shell_commands()
        build = [c for c in commands if "tsc" in c]
        assert build, "no TypeScript build step found"
        assert any("--rootDir src" in c and "--outDir dist" in c for c in build)
