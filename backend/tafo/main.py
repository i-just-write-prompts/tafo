"""Local server entrypoint. Loads a gitignored .env if one is present."""

from __future__ import annotations

import os
from pathlib import Path

from tafo.app import create_app
from tafo.config import Settings


def load_env_file() -> None:
    candidates = [
        Path.cwd() / ".env",
        Path(__file__).resolve().parents[2] / ".env",
    ]
    seen: set[Path] = set()
    for path in candidates:
        resolved = path.resolve()
        if resolved in seen or not resolved.is_file():
            continue
        seen.add(resolved)
        for line in resolved.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        return


load_env_file()
app = create_app(Settings.from_env())


def main() -> None:
    import uvicorn

    settings: Settings = app.state.settings
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
