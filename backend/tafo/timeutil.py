"""UTC storage helpers. Display conversion uses the configured timezone."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from tafo.problems import Problem


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def fmt_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_now_iso() -> str:
    return fmt_utc(utc_now())


def parse_utc(value: str) -> datetime:
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise Problem(400, "invalid_time", "Times must be ISO-8601.") from exc
    if parsed.tzinfo is None:
        raise Problem(400, "invalid_time", "Times must include a timezone. UTC 'Z' is the storage form.")
    return parsed.astimezone(timezone.utc).replace(microsecond=0)


def local_naive_to_utc(local_value: str, tz_name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(local_value.strip())
    except ValueError as exc:
        raise Problem(400, "invalid_time", "Local times must look like 2026-11-09T09:00.") from exc
    if parsed.tzinfo is not None:
        return parsed.astimezone(timezone.utc).replace(microsecond=0)
    try:
        tz = ZoneInfo(tz_name)
    except Exception as exc:
        raise Problem(400, "invalid_timezone", f"Unknown timezone {tz_name}.") from exc
    return parsed.replace(tzinfo=tz).astimezone(timezone.utc).replace(microsecond=0)


def to_local_naive(dt: datetime, tz_name: str) -> str:
    local = dt.astimezone(ZoneInfo(tz_name)).replace(microsecond=0, tzinfo=None)
    return local.strftime("%Y-%m-%dT%H:%M")


def week_bounds(tz_name: str, week_start: str | None) -> tuple[str, datetime, datetime]:
    tz = ZoneInfo(tz_name)
    if week_start:
        try:
            monday = date.fromisoformat(week_start)
        except ValueError as exc:
            raise Problem(400, "invalid_week", "week_start must be YYYY-MM-DD.") from exc
    else:
        today = datetime.now(tz).date()
        monday = today - timedelta(days=today.weekday())
    if monday.weekday() != 0:
        raise Problem(400, "invalid_week", "week_start must be a Monday in the display timezone.")
    start = datetime.combine(monday, time.min, tzinfo=tz)
    end = start + timedelta(days=7)
    return monday.isoformat(), start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def overlaps(a0: datetime, a1: datetime, b0: datetime, b1: datetime) -> bool:
    return a0 < b1 and b0 < a1


def new_id(prefix: str) -> str:
    import uuid

    return f"{prefix}_{uuid.uuid4().hex[:16]}"
