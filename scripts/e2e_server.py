"""Serve TAFO for Playwright on a throwaway Slice 1 database.

The process forces demo calendar mode, disables the generic sample seed,
clears Google settings, and binds to loopback. Each reset deletes the file
and loads scripts/load_demo_fixture.py. data/tafo.sqlite is refused.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = ROOT / "scripts" / "load_demo_fixture.py"
_fixture = None


def fixture_module():
    global _fixture
    if _fixture is None:
        spec = importlib.util.spec_from_file_location("load_demo_fixture", FIXTURE_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Cannot load {FIXTURE_PATH}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _fixture = module
    return _fixture


def reset_database(db_path: Path) -> None:
    """Replace db_path with a fresh Slice 1 review fixture."""
    module = fixture_module()
    resolved = db_path.expanduser().resolve()
    if module.JourneyFixture.forbidden(resolved):
        raise module.FixturePathError(
            "Refusing to write the default database data/tafo.sqlite. "
            "Pass an explicit throwaway path."
        )
    resolved.parent.mkdir(parents=True, exist_ok=True)
    for extra in (resolved, Path(f"{resolved}-wal"), Path(f"{resolved}-shm")):
        extra.unlink(missing_ok=True)
    module.JourneyFixture.load(resolved)


def force_safe_env(db_path: Path) -> None:
    """Demo mode, no Google, loopback only. Overrides a developer .env."""
    port = os.environ.get("TAFO_PORT", "").strip() or "8787"
    os.environ["TAFO_DATA_DIR"] = str(db_path.parent)
    os.environ["TAFO_DB_PATH"] = str(db_path)
    os.environ["TAFO_CALENDAR_MODE"] = "demo"
    os.environ["TAFO_SEED_DEMO"] = "0"
    os.environ["TAFO_DISPLAY_TIMEZONE"] = "America/Indianapolis"
    os.environ["TAFO_HOST"] = "127.0.0.1"
    os.environ["TAFO_PORT"] = port
    os.environ["TAFO_ALLOW_LAN"] = "0"
    os.environ["TAFO_GOOGLE_CREDENTIALS_FILE"] = ""
    os.environ["TAFO_GOOGLE_CALENDAR_ID"] = ""
    os.environ["TAFO_WORK_INVITE_EMAIL"] = ""
    os.environ["TAFO_HUMAN_EDITS_AUTO_APPROVE"] = "1"
    os.environ["TAFO_E2E"] = "1"


def main(argv: list[str] | None = None) -> int:
    del argv
    raw = os.environ.get("TAFO_DB_PATH", "").strip()
    if not raw:
        print("TAFO_DB_PATH is required and must be a throwaway file.", file=sys.stderr)
        return 2
    db_path = Path(raw).expanduser().resolve()
    try:
        reset_database(db_path)
    except Exception as exc:
        name = type(exc).__name__
        if name == "FixturePathError":
            print(exc, file=sys.stderr)
            return 2
        raise
    force_safe_env(db_path)

    import uvicorn
    from fastapi.responses import JSONResponse

    from tafo.main import app

    settings = app.state.settings
    if Path(settings.db_path).resolve() != db_path:
        print(f"Refusing to serve {settings.db_path}; expected {db_path}.", file=sys.stderr)
        return 2
    if settings.calendar_mode != "demo" or settings.allow_lan or settings.seed_demo:
        print("Refusing to serve outside demo loopback settings.", file=sys.stderr)
        return 2

    @app.post("/api/e2e/reset")
    def reset_fixture() -> JSONResponse:
        reset_database(db_path)
        return JSONResponse({"ok": True, "db": str(db_path)})

    print(f"TAFO e2e demo server db={db_path} port={settings.port}", flush=True)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
