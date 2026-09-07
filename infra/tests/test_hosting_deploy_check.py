"""Slice 8 — the post-deploy check, exercised without a deployment.

A check that has never failed is not known to work, so the credential scanner is
driven against fabricated responses in both directions. Nothing here reaches a
network.
"""

from __future__ import annotations

from infra.hosting_deploy_check import CheckResult, scan_for_credentials


class TestCredentialScanner:
    """The standing invariant, checked where it can actually be violated."""

    def test_it_finds_a_proxy_key(self) -> None:
        assert scan_for_credentials("Modal-Key: wk-abc123def456") == ["wk-abc123def456"]

    def test_it_finds_a_proxy_secret(self) -> None:
        assert scan_for_credentials("secret=ws-abc123def456") == ["ws-abc123def456"]

    def test_it_finds_an_upstream_url(self) -> None:
        body = 'const endpoint = "https://acme--breeze-tts-serve.modal.run";'
        assert scan_for_credentials(body) == ["https://acme--breeze-tts-serve.modal.run"]

    def test_it_finds_several_leaks_and_names_them_all(self) -> None:
        """Naming what leaked beats reporting only that something did."""
        found = scan_for_credentials(
            "wk-aaaabbbb and ws-ccccdddd and https://x--y.modal.run"
        )
        assert len(found) == 3

    def test_it_passes_a_clean_shell(self) -> None:
        clean = '<!doctype html><script src="/assets/index-a1b2c3.js"></script>'
        assert scan_for_credentials(clean) == []

    def test_it_does_not_fire_on_ordinary_prose(self) -> None:
        """A false positive here would block a deploy for no reason."""
        assert scan_for_credentials("we work in a workspace with keys") == []


class TestCheckResult:
    """A skipped check is not a passed one."""

    def test_skipped_is_distinct_from_ok(self) -> None:
        skipped = CheckResult("login", False, "no password supplied", skipped=True)
        assert skipped.skipped is True
        assert skipped.ok is False
