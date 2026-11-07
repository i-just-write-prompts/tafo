"""Busy time, mirror dedupe, and a non-binding slot suggestion."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from tafo.blocks import blocks_overlapping
from tafo.calendar_adapter import OUTLOOK_GAP, BusyInterval, CalendarAdapter
from tafo.config import Settings
from tafo.db import read_session
from tafo.timeutil import fmt_utc, overlaps, parse_utc, to_local_naive, utc_now


def dedupe_busy(raw: list[BusyInterval], local_blocks: list[dict]) -> dict[str, list[BusyInterval]]:
    local_ids = {block["id"] for block in local_blocks}
    google_ids = {block["google_event_id"] for block in local_blocks if block.get("google_event_id")}
    external: list[BusyInterval] = []
    suppressed: list[BusyInterval] = []
    orphans: list[BusyInterval] = []
    for item in raw:
        owned = item.app_owned or bool(item.tafo_event_key)
        matched = (item.tafo_event_key in local_ids) or (item.external_id in google_ids)
        if owned and matched:
            suppressed.append(item)
        elif owned:
            orphans.append(item)
        else:
            external.append(item)
    return {"external": external, "suppressed_mirrors": suppressed, "orphan_app_blocks": orphans}


def availability_report(
    settings: Settings,
    adapter: CalendarAdapter,
    start: datetime,
    end: datetime,
) -> dict:
    """Load local blocks, release the connection, then read the remote calendar."""
    with read_session(settings.db_path) as conn:
        local = blocks_overlapping(conn, start, end)
    read_error = None
    try:
        raw = adapter.read_busy(start, end)
        read_source = "demo_fixtures" if adapter.mode == "demo" else "google"
    except Exception as exc:
        raw = []
        read_error = str(exc)
        read_source = "unconfigured" if adapter.mode == "live" else "error"
    parts = dedupe_busy(raw, local)
    fixed = [block for block in local if block["fixed"]]
    return {
        "starts_at": fmt_utc(start),
        "ends_at": fmt_utc(end),
        "read_source": read_source,
        "read_error": read_error,
        "mode": adapter.mode,
        "external_busy": [item.as_dict() for item in parts["external"]],
        "suppressed_mirrors": [item.as_dict() for item in parts["suppressed_mirrors"]],
        "orphan_app_blocks": [item.as_dict() for item in parts["orphan_app_blocks"]],
        "local_blocks": local,
        "fixed_blocks": fixed,
        "outlook_gap": OUTLOOK_GAP,
        "conflict_free": False,
        "conflict_free_reason": OUTLOOK_GAP,
        "display_timezone": settings.display_timezone,
        "note": (
            "Known busy time is informational. TAFO does not move fixed appointments "
            "or rewrite a proposal to dodge a conflict."
        ),
    }


def _blockers(report: dict) -> list[tuple[datetime, datetime]]:
    spans: list[tuple[datetime, datetime]] = []
    for bucket in ("external_busy", "orphan_app_blocks", "local_blocks"):
        for item in report[bucket]:
            if item.get("status") == "cancelled":
                continue
            spans.append((parse_utc(item["starts_at"]), parse_utc(item["ends_at"])))
    return spans


def suggest_slot(
    settings: Settings,
    adapter: CalendarAdapter,
    *,
    duration_minutes: int,
) -> dict:
    if duration_minutes < 15 or duration_minutes > 12 * 60:
        from tafo.problems import Problem

        raise Problem(400, "invalid_duration", "Duration must be between 15 minutes and 12 hours.")
    tz_name = settings.display_timezone
    now_utc = utc_now()
    search_end = now_utc + timedelta(days=7)
    report = availability_report(settings, adapter, now_utc, search_end)
    blockers = _blockers(report)
    duration = timedelta(minutes=duration_minutes)
    from zoneinfo import ZoneInfo

    tz = ZoneInfo(tz_name)
    now_local = now_utc.astimezone(tz)
    chosen: datetime | None = None
    avoided = False
    for day_offset in range(7):
        day = (now_local + timedelta(days=day_offset)).date()
        for minute in range(9 * 60, 16 * 60, 30):
            start_local = datetime(
                day.year,
                day.month,
                day.day,
                minute // 60,
                minute % 60,
                tzinfo=tz,
            )
            end_local = start_local + duration
            if end_local.hour > 16 or (end_local.hour == 16 and end_local.minute > 0):
                continue
            if start_local <= now_local + timedelta(minutes=15):
                continue
            start_utc = start_local.astimezone(timezone.utc).replace(microsecond=0)
            end_utc = end_local.astimezone(timezone.utc).replace(microsecond=0)
            if any(overlaps(start_utc, end_utc, left, right) for left, right in blockers):
                continue
            chosen = start_utc
            avoided = True
            break
        if chosen:
            break
    if chosen is None:
        fallback_day = (now_local + timedelta(days=1)).date()
        start_local = datetime(fallback_day.year, fallback_day.month, fallback_day.day, 9, 0, tzinfo=tz)
        chosen = start_local.astimezone(timezone.utc).replace(microsecond=0)
        avoided = False
    end_chosen = chosen + duration
    return {
        "starts_at": fmt_utc(chosen),
        "ends_at": fmt_utc(end_chosen),
        "starts_local": to_local_naive(chosen, tz_name),
        "ends_local": to_local_naive(end_chosen, tz_name),
        "timezone": tz_name,
        "duration_minutes": duration_minutes,
        "avoided_known_conflicts": avoided,
        "moved_existing_events": False,
        "availability": report,
        "outlook_gap": OUTLOOK_GAP,
    }
