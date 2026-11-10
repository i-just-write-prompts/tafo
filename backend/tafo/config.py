"""Runtime settings. Secrets stay in the environment or local files, never in git."""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def host_is_loopback(header: str | None) -> bool:
    """True when the Host header names loopback, with or without a port."""
    if not header:
        return False
    raw = header.split(",")[0].strip().lower()
    if raw.startswith("["):
        end = raw.find("]")
        if end < 0:
            return False
        name = raw[1:end]
    elif raw.count(":") == 1:
        name = raw.split(":", 1)[0]
    else:
        name = raw
    return name in LOOPBACK_HOSTS


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
    human_edits_auto_approve: bool = True
    preview: bool = False
    static_dir: str = ""
    preview_password: str = ""

    @classmethod
    def from_env(cls) -> Settings:
        preview = _flag(os.environ.get("TAFO_PREVIEW"), False)
        data_raw = os.environ.get("TAFO_DATA_DIR", "").strip()
        db_raw = os.environ.get("TAFO_DB_PATH", "").strip()
        if preview and not data_raw and not db_raw:
            data_dir = Path(tempfile.gettempdir()) / "tafo-preview"
        else:
            data_dir = Path(data_raw or "./data").expanduser()
        db_path = Path(db_raw).expanduser() if db_raw else data_dir / "tafo.sqlite"
        calendar_mode = (os.environ.get("TAFO_CALENDAR_MODE", "demo").strip().lower() or "demo")
        google_credentials_file = os.environ.get("TAFO_GOOGLE_CREDENTIALS_FILE", "").strip()
        google_calendar_id = os.environ.get("TAFO_GOOGLE_CALENDAR_ID", "").strip()
        work_invite_email = os.environ.get("TAFO_WORK_INVITE_EMAIL", "").strip()
        seed_demo = _flag(os.environ.get("TAFO_SEED_DEMO"), True)
        if preview:
            # A review app is public. Demo data only, and ignore any credential that leaked in.
            calendar_mode = "demo"
            google_credentials_file = ""
            google_calendar_id = ""
            work_invite_email = ""
            seed_demo = False
        return cls(
            host=os.environ.get("TAFO_HOST", "127.0.0.1").strip() or "127.0.0.1",
            port=int(os.environ.get("TAFO_PORT", "8787")),
            data_dir=data_dir,
            db_path=db_path,
            display_timezone=os.environ.get("TAFO_DISPLAY_TIMEZONE", "America/Indianapolis").strip()
            or "America/Indianapolis",
            calendar_mode=calendar_mode,
            google_credentials_file=google_credentials_file,
            google_calendar_id=google_calendar_id,
            work_invite_email=work_invite_email,
            allow_lan=_flag(os.environ.get("TAFO_ALLOW_LAN"), False),
            seed_demo=seed_demo,
            human_edits_auto_approve=_flag(os.environ.get("TAFO_HUMAN_EDITS_AUTO_APPROVE"), True),
            preview=preview,
            static_dir=os.environ.get("TAFO_SERVE_STATIC_DIR", "").strip(),
            preview_password=os.environ.get("PREVIEW_PASSWORD", "").strip() if preview else "",
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
        if self.preview:
            if self.calendar_mode != "demo":
                raise RuntimeError("Preview mode only runs with TAFO_CALENDAR_MODE=demo.")
            if self.google_credentials_file or self.google_calendar_id or self.work_invite_email:
                raise RuntimeError("Preview mode refuses Google credentials and invite addresses.")
            if self.seed_demo:
                raise RuntimeError("Preview mode does not load the generic sample seed.")

    @property
    def google_configured(self) -> bool:
        return bool(self.google_credentials_file and self.google_calendar_id)
