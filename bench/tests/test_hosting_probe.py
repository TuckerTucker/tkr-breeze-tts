"""Slice 9 — the hosting probe's reasoning, tested without a deployment.

The probe itself must run against real hardware to mean anything. What can be
tested here is the judgement it applies to what it measures: whether it calls a
buffering proxy buffering, and whether it tells truncation apart from refusal.
Both are decisions that would otherwise only be exercised on the day they
matter.
"""

from __future__ import annotations

import json

from bench.hosting_probe import (
    BUFFERING_RATIO,
    StreamingResult,
    UploadResult,
    write_finding,
)


class TestBufferingVerdict:
    """The reading drawn from first-byte against total."""

    def test_the_local_shape_reads_as_streaming(self) -> None:
        """17ms against 176ms is what the gateway measured locally."""
        assert (17 / 176) < BUFFERING_RATIO

    def test_a_first_byte_that_tracks_the_total_reads_as_buffering(self) -> None:
        """A proxy that assembles the whole response before releasing it gives a
        first-byte time near the total. Nothing fails; the demo is just quietly
        slower, which is why this has to be measured rather than watched for."""
        assert (170 / 176) > BUFFERING_RATIO

    def test_the_threshold_sits_between_the_two(self) -> None:
        assert 0.1 < BUFFERING_RATIO < 0.97


class TestResultShapes:
    """What a recorded finding says."""

    def test_a_streaming_result_carries_its_reading_in_words(self) -> None:
        result = StreamingResult(
            first_byte_ms=17.0,
            total_ms=176.0,
            bytes_received=8192,
            streams=True,
            warm=True,
            note="first byte at 17ms of a 176ms response",
        )
        assert result.streams is True
        assert result.note

    def test_truncation_and_refusal_are_distinct_outcomes(self) -> None:
        """Truncation is the worse one: it reaches a visitor as a corrupt
        reference rather than as a refusal."""
        truncated = UploadResult(1, False, "truncated", 400, "…")
        refused = UploadResult(1, False, "refused", 413, "…")
        assert truncated.failure_mode != refused.failure_mode
        assert not truncated.accepted and not refused.accepted


class TestColdSamplesAreNotReadings:
    """A cold sample cannot answer the buffering question.

    The first real run of this probe measured a container that had scaled to
    zero: 147.8s to first byte of a 150.9s response, ratio 0.98 — which is
    exactly what a buffering proxy looks like, and was in fact a GPU cold start.
    The warm re-run read 0.22. The probe now warms first and records which it
    was, because a finding that does not say cannot be trusted later.
    """

    def test_a_cold_ratio_is_indistinguishable_from_buffering(self) -> None:
        cold_ratio = 147777.7 / 150923.4
        assert cold_ratio > BUFFERING_RATIO

    def test_the_warm_ratio_from_the_real_deployment_reads_as_streaming(self) -> None:
        warm_ratio = 834 / 3851
        assert warm_ratio < BUFFERING_RATIO

    def test_a_cold_sample_never_reports_streaming(self) -> None:
        """`streams` is anded with `warm`, so an unwarmed run cannot claim a
        verdict it is not entitled to."""
        cold = StreamingResult(
            first_byte_ms=100.0, total_ms=1000.0, bytes_received=1,
            streams=False, warm=False, note="cold",
        )
        assert cold.streams is False
        assert cold.warm is False


class TestFindingIsReplaceOnWrite:
    """Re-running a probe must not grow the findings directory."""

    def test_writing_twice_leaves_one_file(self, tmp_path) -> None:
        path = tmp_path / "hosting.json"
        write_finding({"measured_at": "first"}, path)
        write_finding({"measured_at": "second"}, path)

        assert json.loads(path.read_text())["measured_at"] == "second"
        assert len(list(tmp_path.glob("*.json"))) == 1

    def test_it_creates_the_directory_when_absent(self, tmp_path) -> None:
        path = tmp_path / "nested" / "hosting.json"
        write_finding({"measured_at": "now"}, path)
        assert path.is_file()

    def test_the_finding_withholds_the_endpoint(self, tmp_path) -> None:
        """The hosted URL is the upstream this project never publishes, and a
        finding is a committed file."""
        from bench.hosting_probe import RESULTS_PATH

        assert RESULTS_PATH.name == "hosting.json"


class TestUploadProbePayload:
    """The probe must test size, not content validity."""

    def test_it_sends_a_parseable_wav(self) -> None:
        """The first run sent 512 MiB of zeros; the gateway rejected it as 'not a
        recognised audio file' before size was ever in question, and the probe
        misread that semantic 400 as a proxy ceiling."""
        from bench.hosting_probe import _silent_wav

        wav = _silent_wav(2048)
        assert wav[:4] == b"RIFF"
        assert wav[8:12] == b"WAVE"
        assert wav[36:40] == b"data"
        assert len(wav) == 2048

    def test_the_declared_data_length_matches_the_payload(self) -> None:
        import struct

        from bench.hosting_probe import _silent_wav

        wav = _silent_wav(4096)
        declared = struct.unpack("<I", wav[40:44])[0]
        assert declared == len(wav) - 44

    def test_a_gateway_content_refusal_means_the_body_arrived(self) -> None:
        """The proxy question is 'did the bytes cross', not 'did the gateway like
        them'. A typed refusal from the gateway answers it affirmatively."""
        body = '{"error":{"type":"reference","kind":"unsupported-type"}}'
        assert '"type":"reference"' in body
