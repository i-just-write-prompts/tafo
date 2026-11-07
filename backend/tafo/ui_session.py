"""Browser session for approve, deny, and proposal edit.

The secret is an HttpOnly cookie. It is not part of any JSON body. A request
that omits the actor header is not treated as a person.
"""

from __future__ import annotations

import secrets
from urllib.parse import urlparse

from fastapi import Request

from tafo.config import LOOPBACK_HOSTS
from tafo.problems import Problem


class UiSession:
    COOKIE = "tafo_ui"

    @staticmethod
    def mint() -> str:
        return secrets.token_urlsafe(32)

    @staticmethod
    def cookie_header(token: str) -> str:
        return f"{UiSession.COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/"

    @staticmethod
    def origin_is_loopback(origin: str | None) -> bool:
        if not origin:
            return False
        parsed = urlparse(origin.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        return parsed.hostname.lower() in LOOPBACK_HOSTS

    @staticmethod
    def should_issue(request: Request) -> bool:
        """Hand the cookie only to a same-origin browser fetch, not to a plain API call."""
        if request.method != "GET" or request.url.path != "/api/meta":
            return False
        if request.headers.get("sec-fetch-site") != "same-origin":
            return False
        return UiSession.origin_is_loopback(request.headers.get("origin"))

    @staticmethod
    def _matches(sent: str, expected: str) -> bool:
        if not isinstance(expected, str) or not expected or not isinstance(sent, str):
            return False
        if len(sent) != len(expected):
            return False
        return secrets.compare_digest(sent, expected)

    @staticmethod
    def accept(request: Request) -> None:
        """Cookie plus a loopback browser Origin. A header alone is not proof."""
        if not UiSession.origin_is_loopback(request.headers.get("origin")):
            raise Problem(
                403,
                "ui_session_required",
                "Approve, deny, and edit are only accepted from the local UI session.",
            )
        if request.headers.get("sec-fetch-site") != "same-origin":
            raise Problem(
                403,
                "ui_session_required",
                "Approve, deny, and edit are only accepted from the local UI session.",
            )
        expected = getattr(request.app.state, "ui_session_token", "")
        sent = request.cookies.get(UiSession.COOKIE, "")
        if not UiSession._matches(sent, expected):
            raise Problem(
                403,
                "ui_session_required",
                "Approve, deny, and edit are only accepted from the local UI session.",
            )
