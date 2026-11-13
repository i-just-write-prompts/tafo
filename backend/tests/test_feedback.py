"""Feedback endpoint uses a mocked GitHub issue number."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tafo.app import create_app
from tafo.calendar_adapter import build_adapter
from tafo.config import Settings
from tafo.db import connect
from tafo.migrate import apply_migrations


@pytest.fixture()
def slice2_client(tmp_path: Path) -> TestClient:
    db_path = tmp_path / "feedback.sqlite"
    settings = Settings(
        host="127.0.0.1",
        port=8787,
        data_dir=tmp_path,
        db_path=db_path,
        display_timezone="America/Indianapolis",
        calendar_mode="demo",
        google_credentials_file="",
        google_calendar_id="",
        work_invite_email="",
        allow_lan=False,
        seed_demo=False,
        slice2=True,
        github_token="",
        feedback_mock_issue=42,
    )
    conn = connect(db_path)
    try:
        apply_migrations(conn)
    finally:
        conn.close()
    adapter = build_adapter(settings)
    app = create_app(settings, adapter)
    return TestClient(app)


def test_feedback_creates_mock_issue(slice2_client: TestClient) -> None:
    body = {
        "client_id": "test-client-001",
        "note": "Drag snapped wrong",
        "context": {"view": "Day", "build": "abc1234"},
    }
    response = slice2_client.post("/api/feedback", json=body, headers={"X-TAFO-Actor": "human"})
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "sent"
    assert data["issue_number"] == 42
    replay = slice2_client.post("/api/feedback", json=body, headers={"X-TAFO-Actor": "human"})
    assert replay.json()["idempotent_replay"] is True


def test_feedback_not_configured_without_token(tmp_path: Path) -> None:
    db_path = tmp_path / "feedback2.sqlite"
    settings = Settings(
        host="127.0.0.1",
        port=8787,
        data_dir=tmp_path,
        db_path=db_path,
        display_timezone="America/Indianapolis",
        calendar_mode="demo",
        google_credentials_file="",
        google_calendar_id="",
        work_invite_email="",
        allow_lan=False,
        seed_demo=False,
        slice2=True,
        github_token="",
        feedback_mock_issue=None,
    )
    conn = connect(db_path)
    try:
        apply_migrations(conn)
    finally:
        conn.close()
    client = TestClient(create_app(settings, build_adapter(settings)))
    response = client.post(
        "/api/feedback",
        json={"client_id": "test-client-002", "note": "Something broke", "context": {}},
        headers={"X-TAFO-Actor": "human"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "not_configured"
