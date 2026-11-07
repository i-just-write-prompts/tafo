"""Browser session for approve, deny, and proposal edit.

The cookie is issued only after a person enters the pairing code printed on
the server console at launch. No HTTP response contains that code or the
cookie's secret.
"""

from __future__ import annotations

import secrets
import time

from fastapi import Request

from tafo.problems import Problem

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class UiSession:
    COOKIE = "tafo_ui"
    WINDOW_SECONDS = 60.0
    MAX_FAILURES = 5

    @staticmethod
    def mint() -> str:
        return secrets.token_urlsafe(32)

    @staticmethod
    def mint_code() -> str:
        return "".join(secrets.choice(ALPHABET) for _ in range(8))

    @staticmethod
    def format_code(code: str) -> str:
        return f"{code[:4]}-{code[4:]}"

    @staticmethod
    def normalize_code(raw: str) -> str:
        return "".join(ch for ch in raw.upper() if ch.isalnum())

    @staticmethod
    def cookie_header(token: str) -> str:
        return f"{UiSession.COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/"

    @staticmethod
    def _matches(sent: str, expected: str) -> bool:
        if not isinstance(expected, str) or not expected or not isinstance(sent, str):
            return False
        if len(sent) != len(expected):
            return False
        return secrets.compare_digest(sent, expected)

    @staticmethod
    def paired(request: Request) -> bool:
        expected = getattr(request.app.state, "ui_session_token", "")
        sent = request.cookies.get(UiSession.COOKIE, "")
        return UiSession._matches(sent, expected)

    @staticmethod
    def redeem(request: Request, submitted: str) -> None:
        now = time.monotonic()
        recent = [stamp for stamp in request.app.state.pairing_failures if now - stamp < UiSession.WINDOW_SECONDS]
        request.app.state.pairing_failures = recent
        if len(recent) >= UiSession.MAX_FAILURES:
            raise Problem(429, "pairing_rate_limited", "Too many attempts. Wait a minute and try again.")
        normalized = UiSession.normalize_code(submitted)
        if not UiSession._matches(normalized, request.app.state.pairing_code):
            request.app.state.pairing_failures.append(now)
            raise Problem(403, "pairing_rejected", "That pairing code was not accepted.")

    @staticmethod
    def accept(request: Request) -> None:
        if not UiSession.paired(request):
            raise Problem(
                403,
                "ui_session_required",
                "Approve, deny, and edit are only accepted from the local UI session.",
            )
