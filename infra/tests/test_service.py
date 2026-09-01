"""The serving class's two bridges: the warmup scrape and the load-once shim."""

from __future__ import annotations

import io
import types

from infra.config import SERVICE_CONFIG
from infra.service import WARMUP_LINE, _Tee


def test_the_tee_forwards_writes_and_keeps_a_copy() -> None:
    downstream = io.StringIO()
    tee = _Tee(downstream)
    tee.write("fast warmup: 41234.50 ms\n")
    tee.flush()
    # The line must still reach the container log — bench scrapes it through
    # `modal app logs` to decompose cold start.
    assert downstream.getvalue() == "fast warmup: 41234.50 ms\n"
    assert tee.text == "fast warmup: 41234.50 ms\n"


def test_the_warmup_line_is_scraped_from_surrounding_output() -> None:
    text = "loading shards\nfast warmup: 41234.50 ms\nready\n"
    match = WARMUP_LINE.search(text)
    assert match is not None
    assert float(match.group(1)) == 41234.50


def test_absent_warmup_output_scrapes_to_nothing_rather_than_zero() -> None:
    # A missing measurement must read as "not measured", never as a fast one.
    assert WARMUP_LINE.search("no graphs captured\n") is None


def _vendor_double() -> types.SimpleNamespace:
    """A stand-in for `breeze_infer.api` carrying the shape service.py uses."""
    calls: list[str] = []

    class State:
        pass

    class App:
        state = State()

    def load_app(target_app: object, settings: object) -> None:
        calls.append("load")
        target_app.state.runtime = object()  # type: ignore[attr-defined]

    return types.SimpleNamespace(app=App(), _load_app=load_app, calls=calls)


def test_the_lifespan_call_is_a_no_op_after_enter_has_loaded() -> None:
    # Modal marks a container warm when enter() returns, so the load is lifted
    # out of the lifespan. The vendor's lifespan still calls `_load_app`; the
    # shim must stop that becoming a second 7.7 GB load and 53-graph capture.
    vendor = _vendor_double()
    original = vendor._load_app

    def load_once(target_app: object, settings: object) -> None:
        if hasattr(target_app.state, "runtime"):  # type: ignore[attr-defined]
            return
        original(target_app, settings)

    vendor._load_app = load_once

    original(vendor.app, object())  # what enter() does
    vendor._load_app(vendor.app, object())  # what the lifespan does after it

    assert vendor.calls == ["load"]


def test_the_shim_still_loads_when_enter_has_not_run() -> None:
    vendor = _vendor_double()
    original = vendor._load_app

    def load_once(target_app: object, settings: object) -> None:
        if hasattr(target_app.state, "runtime"):  # type: ignore[attr-defined]
            return
        original(target_app, settings)

    load_once(vendor.app, object())
    assert vendor.calls == ["load"]


def test_the_service_is_decorated_from_the_single_config_surface() -> None:
    assert SERVICE_CONFIG.requires_proxy_auth is True
    assert SERVICE_CONFIG.min_containers is None
    assert SERVICE_CONFIG.scaledown_window_s == 600


def test_no_concurrency_decorator_is_applied() -> None:
    # The vendor holds a process-wide _request_lock and returns 409, and
    # configs/fast.json declares concurrency 1. One input per container is the
    # correct posture, so @modal.concurrent must not appear.
    import ast
    import pathlib

    module = ast.parse((pathlib.Path(__file__).parent.parent / "service.py").read_text())
    decorators = [
        ast.unparse(decorator)
        for node in ast.walk(module)
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        for decorator in node.decorator_list
    ]
    assert not any(d.startswith("modal.concurrent") for d in decorators)
    assert any(d.startswith("modal.enter") for d in decorators)
    assert any(d.startswith("modal.asgi_app") for d in decorators)
