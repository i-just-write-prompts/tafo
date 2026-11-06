"""Fictional demo busy markers. They are not a connected calendar."""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone

DEMO_MIRROR_KEY = "evt_mirror_demo"


def demo_mirror_span(now: datetime | None = None) -> tuple[datetime, datetime]:
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(microsecond=0)
    candidate = moment.replace(hour=14, minute=0, second=0)
    if candidate <= moment + timedelta(hours=2):
        candidate += timedelta(days=1)
    return candidate, candidate + timedelta(hours=1)


def demo_fixed_span(now: datetime | None = None) -> tuple[datetime, datetime]:
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(microsecond=0)
    candidate = moment.replace(hour=16, minute=0, second=0)
    if candidate <= moment + timedelta(hours=2):
        candidate += timedelta(days=1)
    return candidate, candidate + timedelta(hours=1)


def each_utc_day(start: datetime, end: datetime):
    day = start.astimezone(timezone.utc).date()
    last = end.astimezone(timezone.utc).date()
    produced = 0
    while day <= last and produced < 21:
        yield day
        day += timedelta(days=1)
        produced += 1


def utc_on(day, hour: int) -> datetime:
    return datetime.combine(day, time(hour, 0), tzinfo=timezone.utc)
