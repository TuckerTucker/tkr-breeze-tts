"""A fake transport and a fake clock, so timing logic is testable offline."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Any

import pytest

from bench.harness import Credentials


@dataclass
class FakeResponse:
    """A scripted streaming response.

    Attributes:
        status_code: HTTP status to report.
        headers: Response headers.
        chunks: Body chunks, yielded in order.
        tick_s: Simulated seconds consumed before each chunk.
        clock: The fake clock these ticks advance.
        raise_after: Chunk index after which the stream aborts, or ``None``.
        body_text: What `read_text` returns.
    """

    status_code: int = 200
    headers: Mapping[str, str] = field(default_factory=dict)
    chunks: tuple[bytes, ...] = ()
    tick_s: float = 0.0
    clock: Any = None
    raise_after: int | None = None
    body_text: str = ""

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *exc_info: object) -> bool:
        return False

    def iter_bytes(self) -> Iterator[bytes]:
        for index, chunk in enumerate(self.chunks):
            if self.raise_after is not None and index == self.raise_after:
                raise ConnectionError("upstream went away")
            if self.clock is not None:
                self.clock.advance(self.tick_s)
            yield chunk

    def read_text(self) -> str:
        return self.body_text


class FakeClock:
    """A monotonic clock the test drives by hand."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        """Move the clock forward.

        Args:
            seconds: How far.
        """
        self.now += seconds


@dataclass
class FakeTransport:
    """Serves a queue of scripted responses and records every call.

    Attributes:
        responses: Responses to return, in order. The last is reused once
            exhausted, which keeps repeat-heavy probes readable.
        calls: Every ``(url, headers, data)`` triple issued.
    """

    responses: list[FakeResponse] = field(default_factory=list)
    calls: list[tuple[str, dict[str, str], dict[str, str]]] = field(
        default_factory=list
    )
    get_status: int = 200

    def stream(
        self, url: str, *, headers: Mapping[str, str], data: Mapping[str, str]
    ) -> FakeResponse:
        self.calls.append((url, dict(headers), dict(data)))
        if not self.responses:
            raise AssertionError("FakeTransport ran out of scripted responses")
        if len(self.responses) == 1:
            return self.responses[0]
        return self.responses.pop(0)

    def get(self, url: str, *, headers: Mapping[str, str]) -> Any:
        self.calls.append((url, dict(headers), {}))

        class _Result:
            status_code = self.get_status

        return _Result()


@pytest.fixture
def credentials() -> Credentials:
    """A valid-looking proxy token pair against a stub endpoint."""
    return Credentials(
        endpoint="https://example--breeze-tts-serve.modal.run",
        key="wk-testkey",
        secret="ws-testsecret",
    )


@pytest.fixture
def clock() -> FakeClock:
    """A hand-driven monotonic clock."""
    return FakeClock()
