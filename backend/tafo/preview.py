"""Public preview mode. Demo fixture only, reloaded every time the process starts."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from tafo.config import Settings

PREVIEW_BANNER = (
    "Preview. Demo data only. This copy resets when the server restarts and is not synced to Google."
)


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


def mount_preview_ui(app: FastAPI, directory: Path) -> None:
    root = directory.expanduser().resolve()
    if not (root / "index.html").is_file():
        raise RuntimeError(f"TAFO_SERVE_STATIC_DIR has no index.html: {root}")
    app.mount("/", StaticFiles(directory=root, html=True), name="ui")
