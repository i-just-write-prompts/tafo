"""Browser session for approve, deny, and proposal edit.

Headed Chrome sends Sec-Fetch-Site: same-origin and no Origin on a same-origin
GET. That GET of /api/meta is what sets the HttpOnly cookie. A client that
does not send Sec-Fetch-Site does not receive it. Forging that header is
enough to obtain the cookie; bots are asked not to.
"""

from __future__ import annotations

import secrets

from fastapi import Request

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
    def should_issue(request: Request) -> bool:
        return (
            request.method == "GET"
            and request.url.path == "/api/meta"
            and request.headers.get("sec-fetch-site") == "same-origin"
        )

    @staticmethod
    def _matches(sent: str, expected: str) -> bool:
        if not isinstance(expected, str) or not expected or not isinstance(sent, str):
            return False
        if len(sent) != len(expected):
            return False
        return secrets.compare_digest(sent, expected)

    @staticmethod
    def accept(request: Request) -> None:
        expected = getattr(request.app.state, "ui_session_token", "")
        sent = request.cookies.get(UiSession.COOKIE, "")
        if not UiSession._matches(sent, expected):
            raise Problem(
                403,
                "ui_session_required",
                "Approve, deny, and edit are only accepted from the local UI session.",
            )
