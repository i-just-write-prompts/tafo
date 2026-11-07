"""Per-launch token for the local Plan page.

Agents can propose. Approve and deny are accepted only when this token is
presented by the page that loaded it. The value is minted once per process
and is intentionally absent from the Hermes contract.
"""

from __future__ import annotations

import secrets

from fastapi import Request

from tafo.problems import Problem


class UiSession:
    HEADER = "x-tafo-ui-session"

    @staticmethod
    def mint() -> str:
        return secrets.token_urlsafe(32)

    @staticmethod
    def accept(request: Request) -> None:
        expected = getattr(request.app.state, "ui_session_token", "")
        sent = request.headers.get(UiSession.HEADER, "")
        if (
            not isinstance(expected, str)
            or not expected
            or not isinstance(sent, str)
            or len(sent) != len(expected)
            or not secrets.compare_digest(sent, expected)
        ):
            raise Problem(
                403,
                "ui_session_required",
                "Approve and deny are only accepted from the local UI session.",
            )
