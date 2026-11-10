"""Preview mode. Demo fixture only, reloaded every time the process starts.

A shared password covers the UI and the API. /api/health stays open and empty
so a platform check can run without learning anything about the data.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import importlib.util
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from tafo.config import Settings

PREVIEW_BANNER = (
    "Preview. Demo data only. This copy resets when the server restarts and is not synced to Google."
)
HEALTH_PATH = "/api/health"
AUTHENTICATE = 'Basic realm="TAFO preview"'


def fixture_script() -> Path:
    raw = os.environ.get("TAFO_FIXTURE_SCRIPT", "").strip()
    candidates = []
    if raw:
        candidates.append(Path(raw))
    candidates.append(Path.cwd() / "scripts" / "load_demo_fixture.py")
    candidates.append(Path(__file__).resolve().parents[2] / "scripts" / "load_demo_fixture.py")
    for path in candidates:
        if path.is_file():
            return path
    raise RuntimeError("Preview mode cannot find scripts/load_demo_fixture.py.")


def fixture_module():
    path = fixture_script()
    spec = importlib.util.spec_from_file_location("load_demo_fixture", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reseed_preview(settings: Settings) -> None:
    """Replace the preview database with a fresh Slice 1 fixture."""
    if not settings.preview:
        raise RuntimeError("Refusing to reseed outside preview mode.")
    settings.validate()
    module = fixture_module()
    db_path = settings.db_path.expanduser().resolve()
    if module.JourneyFixture.forbidden(db_path):
        raise module.FixturePathError(
            "Refusing to write the default database data/tafo.sqlite. "
            "Preview mode needs an ephemeral path."
        )
    db_path.parent.mkdir(parents=True, exist_ok=True)
    for extra in (db_path, Path(f"{db_path}-wal"), Path(f"{db_path}-shm")):
        extra.unlink(missing_ok=True)
    module.JourneyFixture.load(db_path)


def passwords_match(sent: str, expected: str) -> bool:
    """Compare two strings without leaking which one matched through the compare itself."""
    return hmac.compare_digest(
        hashlib.sha256(sent.encode("utf-8")).digest(),
        hashlib.sha256(expected.encode("utf-8")).digest(),
    )


def basic_password(header: str | None) -> str | None:
    """Return the password from a Basic header. The username is ignored."""
    if not header:
        return None
    scheme, _, rest = header.partition(" ")
    if scheme.lower() != "basic" or not rest.strip():
        return None
    try:
        decoded = base64.b64decode(rest.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None
    _username, separator, password = decoded.partition(":")
    if not separator:
        return None
    return password


def install_preview_gate(app: FastAPI, settings: Settings) -> None:
    """Require PREVIEW_PASSWORD for every preview request except /api/health."""
    if not settings.preview:
        return
    expected = settings.preview_password.strip()

    @app.middleware("http")
    async def preview_gate(request: Request, call_next):
        path = request.url.path.rstrip("/") or "/"
        if path == HEALTH_PATH:
            return JSONResponse({"ok": True})
        if not expected:
            return JSONResponse(status_code=503, content={"detail": "Preview password is not configured."})
        presented = basic_password(request.headers.get("authorization"))
        if presented is None or not passwords_match(presented, expected):
            return JSONResponse(
                status_code=401,
                content={"detail": "Preview password required."},
                headers={"WWW-Authenticate": AUTHENTICATE},
            )
        return await call_next(request)


def mount_preview_ui(app: FastAPI, directory: Path) -> None:
    root = directory.expanduser().resolve()
    if not (root / "index.html").is_file():
        raise RuntimeError(f"TAFO_SERVE_STATIC_DIR has no index.html: {root}")
    app.mount("/", StaticFiles(directory=root, html=True), name="ui")
