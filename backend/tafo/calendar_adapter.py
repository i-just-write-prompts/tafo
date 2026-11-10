"""Calendar write adapters.

Demo mode never contacts Google and never reports a genuine sync.
Live mode talks to the Google Calendar API only through an explicit transport.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Protocol

from tafo.config import Settings
from tafo.demo_schedule import DEMO_MIRROR_KEY, demo_mirror_span, each_utc_day, utc_on
from tafo.timeutil import fmt_utc, overlaps, parse_utc

GENERIC_TITLE = {
    "work": "Focus block",
    "home": "Home block",
    "personal": "Personal block",
}
GENERIC_DESCRIPTION = "Time block created by TAFO."
OUTLOOK_GAP = (
    "Invite-only integration does not reveal existing Outlook meetings. "
    "Sending a work-email invitation can place that one block on a work calendar; "
    "it does not read Outlook free/busy. This schedule is not conflict-free."
)
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar"


class CalendarNotConfigured(Exception):
    pass


class TransportError(Exception):
    def __init__(self, status: int, body: str, retry_after: float | None = None) -> None:
        super().__init__(body[:500])
        self.status = status
        self.body = body[:500]
        self.retry_after = retry_after


@dataclass
class BusyInterval:
    source: str
    external_id: str
    starts_at: str
    ends_at: str
    summary: str
    tafo_event_key: str | None = None
    app_owned: bool = False

    def as_dict(self) -> dict:
        return {
            "source": self.source,
            "external_id": self.external_id,
            "starts_at": self.starts_at,
            "ends_at": self.ends_at,
            "summary": self.summary,
            "tafo_event_key": self.tafo_event_key,
            "app_owned": self.app_owned,
        }


@dataclass
class StepRecord:
    name: str
    ok: bool
    detail: str
    google_event_id: str | None = None

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "ok": self.ok,
            "detail": self.detail,
            "google_event_id": self.google_event_id,
        }


@dataclass
class AdapterResult:
    ok: bool
    status: str
    sync_state: str
    google_event_id: str | None
    honest_label: str
    steps: list[StepRecord]
    error: str | None = None
    mode: str = "demo"
    retry_after: float | None = None

    def as_dict(self) -> dict:
        return {
            "ok": self.ok,
            "status": self.status,
            "sync_state": self.sync_state,
            "google_event_id": self.google_event_id,
            "honest_label": self.honest_label,
            "steps": [step.as_dict() for step in self.steps],
            "error": self.error,
            "mode": self.mode,
            "retry_after": self.retry_after,
        }


class CalendarAdapter(Protocol):
    mode: str

    def read_busy(self, start: datetime, end: datetime) -> list[BusyInterval]: ...

    def create_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult: ...

    def update_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult: ...

    def cancel_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult: ...


DEMO_HONEST_LABEL = "Simulated dry-run. NOT synced to Google Calendar. No invitation was sent."


def _demo_ok(detail: str) -> AdapterResult:
    label = DEMO_HONEST_LABEL
    return AdapterResult(
        ok=True,
        status="simulated",
        sync_state="simulated",
        google_event_id=None,
        honest_label=label,
        steps=[StepRecord("simulate", True, detail)],
        mode="demo",
    )


class DemoCalendarAdapter:
    """Dry-run adapter. Results are simulated and are not Google sync."""

    mode = "demo"

    def read_busy(self, start: datetime, end: datetime) -> list[BusyInterval]:
        items: list[BusyInterval] = []
        for day in each_utc_day(start, end):
            hold_start = utc_on(day, 18)
            hold_end = hold_start + timedelta(hours=1)
            if overlaps(hold_start, hold_end, start, end):
                items.append(
                    BusyInterval(
                        source="demo_fixture",
                        external_id=f"demo-hold-{day.isoformat()}",
                        starts_at=fmt_utc(hold_start),
                        ends_at=fmt_utc(hold_end),
                        summary="Demo fixture hold (not from Google)",
                    )
                )
        mirror_start, mirror_end = demo_mirror_span()
        if overlaps(mirror_start, mirror_end, start, end):
            items.append(
                BusyInterval(
                    source="demo_fixture",
                    external_id="demo-mirror-specimen",
                    starts_at=fmt_utc(mirror_start),
                    ends_at=fmt_utc(mirror_end),
                    summary="Personal block",
                    tafo_event_key=DEMO_MIRROR_KEY,
                    app_owned=True,
                )
            )
        return items

    def create_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        del event_key, payload, known_google_id
        return _demo_ok("Stored locally as a simulated block. Google was not called.")

    def update_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        del event_key, payload, known_google_id
        return _demo_ok("Simulated update. Google was not called and nothing was rescheduled there.")

    def cancel_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        del event_key, payload, known_google_id
        return _demo_ok("Simulated cancel. Nothing was deleted on Google.")


class DemoFaults:
    """Test-only switch on a demo adapter. Live mode never wraps this."""

    def __init__(self, inner: CalendarAdapter) -> None:
        self.inner = inner
        self.mode = getattr(inner, "mode", "demo")
        self.fail_keys: set[str] = set()
        self.fail_creates = 0

    def clear(self) -> None:
        self.fail_keys.clear()
        self.fail_creates = 0

    def _failed(self) -> AdapterResult:
        return AdapterResult(
            ok=False,
            status="failed",
            sync_state="not_synced",
            google_event_id=None,
            honest_label="Not synced. The calendar write failed.",
            steps=[],
            error="forced_failure",
            mode="demo",
        )

    def read_busy(self, start: datetime, end: datetime) -> list[BusyInterval]:
        return self.inner.read_busy(start, end)

    def create_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        if self.fail_creates > 0:
            self.fail_creates -= 1
            return self._failed()
        return self.inner.create_block(event_key, payload, known_google_id)

    def update_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        if event_key in self.fail_keys:
            self.fail_keys.discard(event_key)
            return self._failed()
        return self.inner.update_block(event_key, payload, known_google_id)

    def cancel_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        return self.inner.cancel_block(event_key, payload, known_google_id)


class UnconfiguredCalendarAdapter:
    """Live mode without credentials. Fails closed and does not pretend to sync."""

    mode = "live"

    def __init__(self, reason: str) -> None:
        self.reason = reason

    def read_busy(self, start: datetime, end: datetime) -> list[BusyInterval]:
        del start, end
        raise CalendarNotConfigured(self.reason)

    def _fail(self) -> AdapterResult:
        return AdapterResult(
            ok=False,
            status="failed",
            sync_state="not_synced",
            google_event_id=None,
            honest_label="Not synced. Google Calendar is not configured, so nothing was written.",
            steps=[StepRecord("configure", False, self.reason)],
            error="not_configured",
            mode="live",
        )

    def create_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        del event_key, payload, known_google_id
        return self._fail()

    def update_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        del event_key, payload, known_google_id
        return self._fail()

    def cancel_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        del event_key, payload, known_google_id
        return self._fail()


class UrllibTransport:
    """Real HTTP transport. Tests inject a fake transport instead of using this."""

    def request(
        self,
        method: str,
        url: str,
        *,
        params: dict | None,
        json_body: dict | None,
        headers: dict | None,
        timeout: int = 30,
    ) -> dict:
        if params:
            query = urllib.parse.urlencode(params)
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}{query}"
        data = None
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
        request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            header = exc.headers.get("Retry-After") if exc.headers else None
            raise TransportError(exc.code, body, retry_after=parse_retry_after(header)) from exc
        if not raw:
            return {}
        return json.loads(raw)


class AuthorizedUserTokenProvider:
    """Loads a runtime-local Google authorized-user file. Optional google-auth dependency."""

    def __init__(self, path: str) -> None:
        self.path = path

    def access_token(self) -> str:
        file_path = Path(self.path)
        if not file_path.is_file():
            raise CalendarNotConfigured("Google credentials file was not found. No calendar request was sent.")
        restrict_private_file(file_path)
        try:
            from google.auth.transport.requests import Request
            from google.oauth2.credentials import Credentials
        except ImportError as exc:
            raise CalendarNotConfigured(
                "google-auth is not installed. Install the tafo live extra. No calendar request was sent."
            ) from exc
        creds = Credentials.from_authorized_user_file(str(file_path), [CALENDAR_SCOPE])
        if not creds.valid:
            if creds.expired and creds.refresh_token:
                creds.refresh(Request())
                write_private_text(file_path, creds.to_json())
            else:
                raise CalendarNotConfigured("Google credentials are not usable. No calendar request was sent.")
        if not creds.token:
            raise CalendarNotConfigured("Google credentials did not yield an access token. No calendar request was sent.")
        return creds.token


class GoogleCalendarAdapter:
    """Google Calendar is the write authority for app-owned blocks."""

    mode = "live"
    _event_locks_guard = threading.Lock()
    _event_locks: dict[str, threading.Lock] = {}

    def _event_lock(self, event_key: str) -> threading.Lock:
        with GoogleCalendarAdapter._event_locks_guard:
            lock = GoogleCalendarAdapter._event_locks.get(event_key)
            if lock is None:
                lock = threading.Lock()
                GoogleCalendarAdapter._event_locks[event_key] = lock
            return lock

    def __init__(
        self,
        transport,
        calendar_id: str,
        work_email: str,
        *,
        token: str | None = None,
        token_provider: AuthorizedUserTokenProvider | None = None,
    ) -> None:
        self.transport = transport
        self.calendar_id = calendar_id
        self.work_email = work_email.strip()
        self._token = token
        self._token_provider = token_provider

    def _headers(self) -> dict:
        token = self._token if self._token is not None else self._token_provider.access_token()  # type: ignore[union-attr]
        return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    def _events_url(self) -> str:
        calendar = urllib.parse.quote(self.calendar_id, safe="")
        return f"https://www.googleapis.com/calendar/v3/calendars/{calendar}/events"

    def _find(self, event_key: str, headers: dict) -> dict | None:
        data = self.transport.request(
            "GET",
            self._events_url(),
            params={
                "privateExtendedProperty": f"tafoEventKey={event_key}",
                "maxResults": "10",
                "showDeleted": "false",
                "singleEvents": "true",
            },
            json_body=None,
            headers=headers,
        )
        items = data.get("items") or []
        return items[0] if items else None

    def _body(self, event_key: str, payload: dict) -> dict:
        return {
            "summary": payload["title"],
            "description": payload.get("description") or GENERIC_DESCRIPTION,
            "start": {"dateTime": payload["starts_at"], "timeZone": "UTC"},
            "end": {"dateTime": payload["ends_at"], "timeZone": "UTC"},
            "extendedProperties": {"private": {"tafoEventKey": event_key, "tafo": "1"}},
        }

    def read_busy(self, start: datetime, end: datetime) -> list[BusyInterval]:
        headers = self._headers()
        listed = self.transport.request(
            "GET",
            self._events_url(),
            params={
                "timeMin": fmt_utc(start),
                "timeMax": fmt_utc(end),
                "singleEvents": "true",
                "maxResults": "250",
                "orderBy": "startTime",
                "showDeleted": "false",
            },
            json_body=None,
            headers=headers,
        )
        intervals: list[BusyInterval] = []
        listed_spans: list[tuple[datetime, datetime]] = []
        for item in listed.get("items") or []:
            if item.get("status") == "cancelled" or item.get("transparency") == "transparent":
                continue
            start_raw = (item.get("start") or {}).get("dateTime") or (item.get("start") or {}).get("date")
            end_raw = (item.get("end") or {}).get("dateTime") or (item.get("end") or {}).get("date")
            if not start_raw or not end_raw:
                continue
            start_at = _google_time(start_raw)
            end_at = _google_time(end_raw, end_of_date=len(end_raw) == 10)
            key = ((item.get("extendedProperties") or {}).get("private") or {}).get("tafoEventKey")
            intervals.append(
                BusyInterval(
                    source="google",
                    external_id=item.get("id") or "",
                    starts_at=fmt_utc(start_at),
                    ends_at=fmt_utc(end_at),
                    summary=item.get("summary") or "Busy",
                    tafo_event_key=key,
                    app_owned=bool(key),
                )
            )
            listed_spans.append((start_at, end_at))
        freebusy = self.transport.request(
            "POST",
            "https://www.googleapis.com/calendar/v3/freeBusy",
            params=None,
            json_body={
                "timeMin": fmt_utc(start),
                "timeMax": fmt_utc(end),
                "items": [{"id": self.calendar_id}],
            },
            headers=headers,
        )
        calendar = (freebusy.get("calendars") or {}).get(self.calendar_id) or {}
        if calendar.get("errors") and not intervals:
            message = json.dumps(calendar.get("errors"))[:400]
            raise TransportError(502, message)
        for period in calendar.get("busy") or []:
            period_start = parse_utc(period["start"])
            period_end = parse_utc(period["end"])
            if any(overlaps(period_start, period_end, left, right) for left, right in listed_spans):
                continue
            intervals.append(
                BusyInterval(
                    source="google_freebusy",
                    external_id=f"freebusy-{fmt_utc(period_start)}",
                    starts_at=fmt_utc(period_start),
                    ends_at=fmt_utc(period_end),
                    summary="Busy (details hidden by Google)",
                )
            )
        return intervals

    def create_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        with self._event_lock(event_key):
            return self._upsert(event_key, payload, known_google_id)

    def update_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        with self._event_lock(event_key):
            return self._upsert(event_key, payload, known_google_id)

    def cancel_block(self, event_key: str, payload: dict, known_google_id: str | None = None) -> AdapterResult:
        steps: list[StepRecord] = []
        notify = "all" if payload.get("invite_work_email") else "none"
        try:
            headers = self._headers()
            existing = self._find(event_key, headers)
        except (TransportError, CalendarNotConfigured) as exc:
            retry_after = exc.retry_after if isinstance(exc, TransportError) else None
            return _live_failure("lookup_event", str(exc), known_google_id, retry_after=retry_after)
        event_id = (existing or {}).get("id") or known_google_id
        if not event_id:
            steps.append(StepRecord("cancel_event", True, "No Google event exists for this key. Nothing to delete."))
            return AdapterResult(
                ok=True,
                status="synced",
                sync_state="synced",
                google_event_id=None,
                honest_label="Synced cancel check. No Google event was present for this app key.",
                steps=steps,
                mode="live",
            )
        try:
            self.transport.request(
                "DELETE",
                f"{self._events_url()}/{urllib.parse.quote(event_id, safe='')}",
                params={"sendUpdates": notify},
                json_body=None,
                headers=headers,
            )
        except TransportError as exc:
            if exc.status in {404, 410}:
                steps.append(StepRecord("cancel_event", True, "Google already had no active event.", event_id))
                return AdapterResult(
                    ok=True,
                    status="synced",
                    sync_state="synced",
                    google_event_id=None,
                    honest_label="Synced cancel. The Google event was already gone.",
                    steps=steps,
                    mode="live",
                )
            steps.append(StepRecord("cancel_event", False, exc.body, event_id))
            return AdapterResult(
                ok=False,
                status="failed",
                sync_state="not_synced",
                google_event_id=event_id,
                honest_label="Not synced. Cancel failed, so the previous Google event may still be on the calendar.",
                steps=steps,
                error=exc.body,
                mode="live",
                retry_after=exc.retry_after,
            )
        steps.append(StepRecord("cancel_event", True, "Cancelled the app-owned Google event.", event_id))
        return AdapterResult(
            ok=True,
            status="synced",
            sync_state="synced",
            google_event_id=event_id,
            honest_label="Synced to Google Calendar. The app-owned event was cancelled.",
            steps=steps,
            mode="live",
        )

    def _upsert(self, event_key: str, payload: dict, known_google_id: str | None) -> AdapterResult:
        steps: list[StepRecord] = []
        try:
            headers = self._headers()
            existing = self._find(event_key, headers)
        except (TransportError, CalendarNotConfigured) as exc:
            retry_after = exc.retry_after if isinstance(exc, TransportError) else None
            return _live_failure("lookup_event", str(exc), known_google_id, retry_after=retry_after)
        body = self._body(event_key, payload)
        stable_id = deterministic_event_id(event_key)
        # Prefer a located event, then the id we already stored. An empty lookup
        # still checks the deterministic id so a crash after insert does not POST again.
        event_id = (existing or {}).get("id") or known_google_id
        if not event_id:
            found, failure = self._fetch_stable(stable_id, headers)
            if failure is not None:
                return failure
            event_id = found
        if event_id:
            patched, missing = self._patch_event(event_id, body, headers)
            if patched:
                steps.append(StepRecord("upsert_event", True, "Updated the existing app-owned event. No duplicate insert.", event_id))
            elif missing is not None and missing.status in {404, 410}:
                steps.append(StepRecord("upsert_event", False, "Stored event id was gone. One replacement will be created.", event_id))
                event_id = None
            elif missing is not None:
                return _write_failure(steps, missing, event_id or known_google_id)
        if not event_id:
            inserted, conflict = self._insert_stable(stable_id, body, headers)
            if inserted:
                event_id = inserted
                steps.append(StepRecord("upsert_event", True, "Created one app-owned Google event.", event_id))
            elif conflict is not None and conflict.status == 409:
                patched, missing = self._patch_event(stable_id, body, headers)
                if patched:
                    event_id = stable_id
                    steps.append(
                        StepRecord(
                            "upsert_event",
                            True,
                            "Google already had this deterministic id. Updated it instead of inserting another.",
                            event_id,
                        )
                    )
                else:
                    return _write_failure(steps, missing or conflict, stable_id)
            elif conflict is not None:
                return _write_failure(steps, conflict, known_google_id)
            else:
                return AdapterResult(
                    ok=False,
                    status="failed",
                    sync_state="not_synced",
                    google_event_id=None,
                    honest_label="Not synced. Google did not return an event id. No success is claimed.",
                    steps=steps + [StepRecord("upsert_event", False, "Missing event id.")],
                    error="missing_event_id",
                    mode="live",
                )
        if payload.get("invite_work_email"):
            if not self.work_email:
                steps.append(
                    StepRecord(
                        "invite_work_email",
                        False,
                        "TAFO_WORK_INVITE_EMAIL is empty. No invitation was sent.",
                        event_id,
                    )
                )
                return AdapterResult(
                    ok=False,
                    status="partial",
                    sync_state="partial",
                    google_event_id=event_id,
                    honest_label="Partial failure. The Google event exists, but no work invitation was sent. Not fully synced.",
                    steps=steps,
                    error="work_email_missing",
                    mode="live",
                )
            try:
                self.transport.request(
                    "PATCH",
                    f"{self._events_url()}/{urllib.parse.quote(event_id or '', safe='')}",
                    params={"sendUpdates": "all"},
                    json_body={"attendees": [{"email": self.work_email}]},
                    headers=headers,
                )
                steps.append(
                    StepRecord(
                        "invite_work_email",
                        True,
                        "Google was asked to invite the configured work address. Delivery still depends on that account and workplace policy.",
                        event_id,
                    )
                )
            except TransportError as exc:
                steps.append(StepRecord("invite_work_email", False, exc.body, event_id))
                return AdapterResult(
                    ok=False,
                    status="partial",
                    sync_state="partial",
                    google_event_id=event_id,
                    honest_label="Partial failure. The Google event exists, but the work invitation step failed. Not fully synced.",
                    steps=steps,
                    error=exc.body,
                    mode="live",
                    retry_after=exc.retry_after,
                )
        return AdapterResult(
            ok=True,
            status="synced",
            sync_state="synced",
            google_event_id=event_id,
            honest_label="Synced to Google Calendar.",
            steps=steps,
            mode="live",
        )

    def _fetch_stable(self, stable_id: str, headers: dict) -> tuple[str | None, AdapterResult | None]:
        try:
            fetched = self.transport.request(
                "GET",
                f"{self._events_url()}/{urllib.parse.quote(stable_id, safe='')}",
                params=None,
                json_body=None,
                headers=headers,
            )
        except TransportError as exc:
            if exc.status in {404, 410}:
                return None, None
            return None, _live_failure("lookup_event", exc.body, None, retry_after=exc.retry_after)
        if isinstance(fetched, dict) and fetched.get("id") and fetched.get("status") != "cancelled":
            return str(fetched["id"]), None
        return None, None

    def _patch_event(self, event_id: str, body: dict, headers: dict) -> tuple[bool, TransportError | None]:
        try:
            self.transport.request(
                "PATCH",
                f"{self._events_url()}/{urllib.parse.quote(event_id, safe='')}",
                params={"sendUpdates": "none"},
                json_body=body,
                headers=headers,
            )
        except TransportError as exc:
            return False, exc
        return True, None

    def _insert_stable(self, stable_id: str, body: dict, headers: dict) -> tuple[str | None, TransportError | None]:
        insert_body = dict(body)
        insert_body["id"] = stable_id
        try:
            created = self.transport.request(
                "POST",
                self._events_url(),
                params={"sendUpdates": "none"},
                json_body=insert_body,
                headers=headers,
            )
        except TransportError as exc:
            return None, exc
        event_id = created.get("id") if isinstance(created, dict) else None
        if not event_id:
            return None, None
        return str(event_id), None


def _write_failure(steps: list[StepRecord], exc: TransportError, kept: str | None) -> AdapterResult:
    steps.append(StepRecord("upsert_event", False, exc.body, kept))
    return AdapterResult(
        ok=False,
        status="failed",
        sync_state="not_synced",
        google_event_id=kept,
        honest_label=(
            "Not synced. Google Calendar write failed. "
            + ("The recorded event id was kept. No new event was created." if kept else "No success is claimed.")
        ),
        steps=steps,
        error=exc.body,
        mode="live",
        retry_after=exc.retry_after,
    )


def _live_failure(step: str, detail: str, kept_id: str | None = None, retry_after: float | None = None) -> AdapterResult:
    if kept_id:
        label = (
            "Lookup failed before another write. The recorded Google event id was kept. "
            "No new event was created. Not fully synced."
        )
    else:
        label = "Not synced. The calendar request failed before a completed write. No success is claimed."
    return AdapterResult(
        ok=False,
        status="failed",
        sync_state="not_synced",
        google_event_id=kept_id,
        honest_label=label,
        steps=[StepRecord(step, False, detail)],
        error=detail,
        mode="live",
        retry_after=retry_after,
    )


def deterministic_event_id(event_key: str) -> str:
    """Stable Google event id for one TAFO event key. Base32hex, 5–1024 chars."""
    digest = hashlib.sha256(event_key.encode("utf-8")).hexdigest()
    return f"tafo{digest}"


def parse_retry_after(value: str | None) -> float | None:
    if value is None or not str(value).strip():
        return None
    try:
        return max(0.0, min(float(str(value).strip()), 30.0))
    except ValueError:
        return None


def restrict_private_file(path: Path) -> None:
    """Owner read/write only (mode 0600).

    Checked on Linux. Windows was not executed: ``os.chmod`` does not install a
    Windows ACL, so on that platform this only best-effort clears the Unix mode bits.
    """
    os.chmod(path, 0o600)


def write_private_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
    restrict_private_file(path)


def _google_time(value: str, end_of_date: bool = False) -> datetime:
    if len(value) == 10:
        parsed = parse_utc(value + "T00:00:00Z")
        if end_of_date:
            return parsed + timedelta(days=1)
        return parsed
    return parse_utc(value)


def build_adapter(settings: Settings) -> CalendarAdapter:
    if settings.calendar_mode == "demo":
        return DemoCalendarAdapter()
    if not settings.google_configured:
        return UnconfiguredCalendarAdapter(
            "Set TAFO_GOOGLE_CREDENTIALS_FILE and TAFO_GOOGLE_CALENDAR_ID. No calendar request was sent."
        )
    return GoogleCalendarAdapter(
        UrllibTransport(),
        settings.google_calendar_id,
        settings.work_invite_email,
        token_provider=AuthorizedUserTokenProvider(settings.google_credentials_file),
    )
