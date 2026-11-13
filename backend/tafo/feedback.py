"""Device feedback routed to GitHub issues (server-side token only)."""

from __future__ import annotations

import base64
import json
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from tafo.problems import Problem
from tafo.timeutil import utc_now_iso


def feedback_configured(settings) -> bool:
    token = getattr(settings, "github_token", "").strip()
    mock = getattr(settings, "feedback_mock_issue", None)
    return bool(token) or mock is not None


def screenshot_default_on(settings) -> bool:
    return bool(getattr(settings, "github_repo_private", False))


def store_screenshot(data_dir: Path, client_id: str, raw: bytes) -> str:
    folder = data_dir / "feedback-screenshots"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{client_id}.png"
    path.write_bytes(raw)
    return str(path)


def format_issue_body(note: str, context: dict[str, Any], screenshot_url: str | None) -> str:
    lines = [note.strip(), "", "Context (auto)", ""]
    for key in sorted(context.keys()):
        value = context[key]
        if isinstance(value, (dict, list)):
            rendered = json.dumps(value, indent=2, sort_keys=True)
        else:
            rendered = str(value)
        lines.append(f"- **{key}:** {rendered}")
    if screenshot_url:
        lines.extend(["", f"![screenshot]({screenshot_url})"])
    return "\n".join(lines)


def create_github_issue(settings, title: str, body: str) -> dict[str, Any]:
    mock = getattr(settings, "feedback_mock_issue", None)
    if mock is not None:
        repo = getattr(settings, "github_repo", "i-just-write-prompts/tafo")
        number = int(mock)
        return {"ok": True, "number": number, "html_url": f"https://github.com/{repo}/issues/{number}"}
    token = getattr(settings, "github_token", "").strip()
    if not token:
        return {"ok": False, "reason": "not_configured"}
    repo = getattr(settings, "github_repo", "i-just-write-prompts/tafo")
    payload = json.dumps({"title": title, "body": body, "labels": ["feedback"]}).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/issues",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "tafo-feedback",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
            return {"ok": True, "number": data["number"], "html_url": data.get("html_url")}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        return {"ok": False, "reason": "github_error", "detail": detail}
    except Exception as exc:
        return {"ok": False, "reason": "github_error", "detail": str(exc)}


def submit_feedback(conn: sqlite3.Connection, settings, body: dict[str, Any]) -> dict[str, Any]:
    client_id = str(body.get("client_id", "")).strip()
    note = str(body.get("note", "")).strip()
    if not client_id:
        raise Problem(400, "missing_client_id", "client_id is required.")
    if not note:
        raise Problem(400, "missing_note", "A note is required.")
    context = body.get("context") or {}
    if not isinstance(context, dict):
        raise Problem(400, "invalid_context", "context must be an object.")
    existing = conn.execute("SELECT * FROM feedback_submissions WHERE client_id = ?", (client_id,)).fetchone()
    if existing and existing["status"] == "sent" and existing["github_issue_number"]:
        return {
            "status": "sent",
            "issue_number": existing["github_issue_number"],
            "idempotent_replay": True,
        }
    now = utc_now_iso()
    screenshot_path = existing["screenshot_path"] if existing else None
    shot_b64 = body.get("screenshot_base64")
    if isinstance(shot_b64, str) and shot_b64.strip():
        try:
            raw = base64.b64decode(shot_b64.split(",", 1)[-1], validate=False)
            screenshot_path = store_screenshot(settings.data_dir, client_id, raw)
        except Exception:
            screenshot_path = None
    title = note.splitlines()[0].strip()
    if len(title) > 70:
        title = f"{title[:67]}..."
    issue_body = format_issue_body(note, context, None)
    if not feedback_configured(settings):
        conn.execute(
            """
            INSERT INTO feedback_submissions (client_id, note, context_json, screenshot_path, github_issue_number, status, last_error, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, 'not_configured', 'TAFO_GITHUB_TOKEN is not set', ?, ?)
            ON CONFLICT(client_id) DO UPDATE SET
              note = excluded.note,
              context_json = excluded.context_json,
              screenshot_path = COALESCE(excluded.screenshot_path, feedback_submissions.screenshot_path),
              status = 'not_configured',
              last_error = excluded.last_error,
              updated_at = excluded.updated_at
            """,
            (client_id, note, json.dumps(context), screenshot_path, now, now),
        )
        return {"status": "not_configured", "issue_number": None, "idempotent_replay": False}
    result = create_github_issue(settings, title, issue_body)
    if not result.get("ok"):
        err = result.get("detail") or result.get("reason") or "unknown"
        conn.execute(
            """
            INSERT INTO feedback_submissions (client_id, note, context_json, screenshot_path, github_issue_number, status, last_error, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, 'queued', ?, ?, ?)
            ON CONFLICT(client_id) DO UPDATE SET
              note = excluded.note,
              context_json = excluded.context_json,
              screenshot_path = COALESCE(excluded.screenshot_path, feedback_submissions.screenshot_path),
              status = 'queued',
              last_error = excluded.last_error,
              updated_at = excluded.updated_at
            """,
            (client_id, note, json.dumps(context), screenshot_path, err, now, now),
        )
        return {"status": "queued", "issue_number": None, "idempotent_replay": False}
    number = int(result["number"])
    conn.execute(
        """
        INSERT INTO feedback_submissions (client_id, note, context_json, screenshot_path, github_issue_number, status, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'sent', NULL, ?, ?)
        ON CONFLICT(client_id) DO UPDATE SET
          note = excluded.note,
          context_json = excluded.context_json,
          screenshot_path = COALESCE(excluded.screenshot_path, feedback_submissions.screenshot_path),
          github_issue_number = excluded.github_issue_number,
          status = 'sent',
          last_error = NULL,
          updated_at = excluded.updated_at
        """,
        (client_id, note, json.dumps(context), screenshot_path, number, now, now),
    )
    return {"status": "sent", "issue_number": number, "idempotent_replay": False}
