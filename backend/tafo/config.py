"""Runtime settings. Secrets stay in the environment or local files, never in git."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _flag(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    data_dir: Path
    db_path: Path
    display_timezone: str
    calendar_mode: str
    google_credentials_file: str
    google_calendar_id: str
    work_invite_email: str
    allow_lan: bool
    seed_demo: bool

    @classmethod
    def from_env(cls) -> Settings:
        data_dir = Path(os.environ.get("TAFO_DATA_DIR", "./data")).expanduser()
        db_raw = os.environ.get("TAFO_DB_PATH", "").strip()
        db_path = Path(db_raw).expanduser() if db_raw else data_dir / "tafo.sqlite"
        return cls(
            host=os.environ.get("TAFO_HOST", "127.0.0.1").strip() or "127.0.0.1",
            port=int(os.environ.get("TAFO_PORT", "8787")),
            data_dir=data_dir,
            db_path=db_path,
            display_timezone=os.environ.get("TAFO_DISPLAY_TIMEZONE", "America/Indianapolis").strip()
            or "America/Indianapolis",
            calendar_mode=(os.environ.get("TAFO_CALENDAR_MODE", "demo").strip().lower() or "demo"),
            google_credentials_file=os.environ.get("TAFO_GOOGLE_CREDENTIALS_FILE", "").strip(),
            google_calendar_id=os.environ.get("TAFO_GOOGLE_CALENDAR_ID", "").strip(),
            work_invite_email=os.environ.get("TAFO_WORK_INVITE_EMAIL", "").strip(),
            allow_lan=_flag(os.environ.get("TAFO_ALLOW_LAN"), False),
            seed_demo=_flag(os.environ.get("TAFO_SEED_DEMO"), True),
        )

    def validate(self) -> None:
        if self.host not in LOOPBACK_HOSTS and not self.allow_lan:
            raise RuntimeError(
                f"Refusing to bind {self.host}. TAFO listens on loopback unless TAFO_ALLOW_LAN=1. "
                "There is no authentication on this API."
            )
        if self.calendar_mode not in {"demo", "live"}:
            raise RuntimeError("TAFO_CALENDAR_MODE must be 'demo' or 'live'.")
        try:
            ZoneInfo(self.display_timezone)
        except Exception as exc:
            raise RuntimeError(f"Invalid TAFO_DISPLAY_TIMEZONE: {self.display_timezone}") from exc
        if self.port < 1 or self.port > 65535:
            raise RuntimeError("TAFO_PORT is out of range.")

    @property
    def google_configured(self) -> bool:
        return bool(self.google_credentials_file and self.google_calendar_id)
