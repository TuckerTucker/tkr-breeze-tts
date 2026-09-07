"""Post-deploy verification for the hosted gateway.

Distinct from ``infra/hosting_smoke_check.py``, which runs *inside* the image at
build time and asserts the container has what the gateway needs. This one runs
*against a deployed URL* from outside and asserts the properties that must hold
once it is serving.

Four things are checked, and each is one that fails silently otherwise:

* **An API route without a session is refused.** A gate that does not gate is
  worse than no gate, because it will be trusted.
* **The UI shell without a session is served.** This is the deliberate
  exemption — the shell is what renders the password field — and an exemption
  nobody checks is an exemption that silently widens.
* **The login exchange succeeds and sets a session cookie.** Otherwise the
  deployment is a locked door with no key.
* **No served byte carries the proxy pair or the upstream URL.** This is the
  standing invariant the whole architecture rests on, checked on the one
  surface that is served to strangers.

Run against a deployment::

    .venv/bin/python -m infra.hosting_deploy_check https://…modal.run

The password is read from ``BREEZE_DEMO_PASSWORD`` so it never lands in shell
history. Absent it, the login and cookie checks are skipped and reported as
skipped rather than passed.
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from typing import Final

import httpx

#: Credential shapes that must never appear in anything served to a browser.
CREDENTIAL_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r"\b(wk|ws)-[A-Za-z0-9_-]{4,}"),
    re.compile(r"\bhttps?://[A-Za-z0-9._-]+\.modal\.run"),
)


@dataclass(frozen=True)
class CheckResult:
    """One check's outcome.

    Attributes:
        name: What was checked.
        ok: Whether it held. A skipped check is not ok and not a failure.
        detail: What was observed.
        skipped: True when the check could not run at all.
    """

    name: str
    ok: bool
    detail: str
    skipped: bool = False


def scan_for_credentials(text: str) -> list[str]:
    """Find credential-shaped strings in something served to a browser.

    Args:
        text: A response body, or its headers rendered as text.

    Returns:
        Every match found, so the report names what leaked rather than only
        that something did.
    """
    found: list[str] = []
    for pattern in CREDENTIAL_PATTERNS:
        found.extend(match.group(0) for match in pattern.finditer(text))
    return found


def _request(
    url: str, *, method: str = "GET", json: dict[str, object] | None = None,
    client: httpx.Client | None = None,
) -> tuple[int, str, str]:
    """Perform one HTTP request, treating any status as a result.

    httpx rather than urllib: it ships a CA bundle (the macOS framework Python
    has no usable trust store, so urllib cannot verify Modal's certificate) and
    it carries cookies across a session without a hand-rolled jar.

    Args:
        url: Absolute URL to request.
        method: HTTP method.
        json: Request body, when there is one.
        client: A session carrying the login cookie, when one exists.

    Returns:
        The status code, the body, and the headers rendered as text.
    """
    owned = client is None
    http = client or httpx.Client(timeout=60, follow_redirects=True)
    try:
        response = http.request(method, url, json=json)
        return response.status_code, response.text, str(dict(response.headers))
    finally:
        if owned:
            http.close()


def check_api_is_refused(base: str) -> CheckResult:
    """Assert an API route refuses an unauthenticated request.

    Args:
        base: The deployment's base URL.

    Returns:
        The check's outcome.
    """
    status, _, _ = _request(f"{base}/api/voices")
    return CheckResult(
        "API refused without a session",
        status == 401,
        f"GET /api/voices returned {status}, expected 401",
    )


def check_shell_is_served(base: str) -> CheckResult:
    """Assert the static shell is served without a session.

    This is the deliberate exemption: the password field is a React component,
    so refusing the shell would mean the gate never renders and a visitor handed
    the link would meet a bare 401 body instead of a login.

    Args:
        base: The deployment's base URL.

    Returns:
        The check's outcome.
    """
    status, _, _ = _request(f"{base}/")
    return CheckResult(
        "UI shell served without a session",
        status == 200,
        f"GET / returned {status}, expected 200",
    )


def check_no_credentials_served(base: str, client: httpx.Client | None = None) -> CheckResult:
    """Assert nothing served to a browser carries the credential or upstream URL.

    Checked hardest on the shell, because that is the surface served to people
    who have not authenticated at all.

    Args:
        base: The deployment's base URL.

    Returns:
        The check's outcome.
    """
    leaked: list[str] = []
    for path in ("/", "/index.html", "/api/voices"):
        _, body, headers = _request(f"{base}{path}", client=client)
        leaked.extend(scan_for_credentials(body))
        leaked.extend(scan_for_credentials(headers))
    return CheckResult(
        "no credential or upstream URL in any served byte",
        not leaked,
        "clean" if not leaked else f"LEAKED: {sorted(set(leaked))}",
    )


def check_login(base: str, password: str | None) -> tuple[CheckResult, CheckResult]:
    """Assert the login exchange works and then admits an API request.

    Args:
        base: The deployment's base URL.
        password: The shared password, or None to skip.

    Returns:
        The login result and the follow-on authenticated-request result.
    """
    if not password:
        skipped = CheckResult(
            "login exchange",
            False,
            "BREEZE_DEMO_PASSWORD is not set, so this was not checked",
            skipped=True,
        )
        return skipped, CheckResult(
            "API served with a session",
            False,
            "not checked, because login was not attempted",
            skipped=True,
        )

    # One client for both calls, so the cookie the login sets is the cookie the
    # follow-on request presents — which is the whole property under test.
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        status, _, headers = _request(
            f"{base}/api/session", method="POST", json={"password": password}, client=client
        )
        carries_cookie = "breeze_session" in client.cookies
        login = CheckResult(
            "login exchange sets a session cookie",
            status == 204 and carries_cookie,
            f"POST /api/session returned {status}; session cookie stored: {carries_cookie}. "
            "A 401 here with a hash just created is most likely a Secret that did not "
            "reach the container.",
        )

        after_status, _, _ = _request(f"{base}/api/voices", client=client)
        authed = CheckResult(
            "API served with a session",
            after_status == 200,
            f"GET /api/voices with the session returned {after_status}, expected 200",
        )
    return login, authed


def run(base: str, password: str | None) -> list[CheckResult]:
    """Run every post-deploy check.

    Args:
        base: The deployment's base URL, without a trailing slash.
        password: The shared password, when the operator supplied one.

    Returns:
        Every check's outcome, in report order.
    """
    base = base.rstrip("/")
    login, authed = check_login(base, password)
    return [
        check_api_is_refused(base),
        check_shell_is_served(base),
        check_no_credentials_served(base),
        login,
        authed,
    ]


def main(argv: list[str]) -> int:
    """Check a deployment and report.

    Args:
        argv: Command-line arguments; the deployment URL is the first.

    Returns:
        A process exit status: non-zero when any check failed.
    """
    if len(argv) < 2:
        print("usage: python -m infra.hosting_deploy_check <url>", file=sys.stderr)
        return 2

    results = run(argv[1], os.environ.get("BREEZE_DEMO_PASSWORD"))
    failed = 0
    for result in results:
        if result.skipped:
            mark = "SKIP"
        elif result.ok:
            mark = "ok  "
        else:
            mark = "FAIL"
            failed += 1
        print(f"{mark}  {result.name}: {result.detail}")

    if failed:
        print(f"\n{failed} check(s) failed — treat this deployment as unfit to hand out.", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
