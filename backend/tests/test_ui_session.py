"""Approve and deny stay on the local UI session. Agents can still propose."""

from datetime import timedelta

from tafo.timeutil import local_naive_to_utc
from zoneinfo import ZoneInfo

from tests.conftest import add_task


def _agent_block(client) -> dict:
    created = client.post(
        "/api/hermes/proposals",
        headers={"X-TAFO-Actor": "agent"},
        json={
            "source": "sample-agent",
            "source_kind": "agent",
            "kind": "calendar_block",
            "explanation": "Hold an hour for a personal errand.",
            "idempotency_key": "agent-approve-scope-1",
            "payload": {
                "domain": "personal",
                "starts_at": "2026-11-08T15:00:00Z",
                "ends_at": "2026-11-08T16:00:00Z",
            },
        },
    )
    assert created.status_code == 201, created.text
    return created.json()


def _still_pending(client, proposal: dict) -> None:
    fresh = client.get(f"/api/hermes/proposals/{proposal['id']}").json()
    assert fresh["status"] == "pending"
    assert fresh["version"] == proposal["version"]


def _decision(client, proposal: dict, action: str, headers: dict | None):
    return client.post(
        f"/api/decisions/{proposal['id']}/{action}",
        headers=headers,
        json={"expected_version": proposal["version"], "confirmed": True, "payload": {"op": "update"}},
    )


def test_non_ui_caller_cannot_fetch_the_token_or_decide(client):
    proposal = _agent_block(client)
    token = client.app.state.ui_session_token
    assert token
    client.inject_ui_session = False

    meta = client.get("/api/meta")
    assert meta.status_code == 200
    dumped_meta = meta.text
    assert token not in dumped_meta
    assert "ui_session_token" not in dumped_meta
    assert "set-cookie" not in {key.lower() for key in meta.headers}
    assert meta.json()["human_edits_auto_approve"] is True

    contract = client.get("/api/hermes/contract")
    assert token not in contract.text
    assert "tafo_ui" not in contract.text.lower()
    spec = client.get("/openapi.json")
    assert token not in spec.text

    no_actor = _decision(client, proposal, "approve", None)
    assert no_actor.status_code == 403
    assert no_actor.json()["detail"]["code"] == "ui_session_required"
    _still_pending(client, proposal)

    agent = _decision(client, proposal, "approve", {"X-TAFO-Actor": "agent"})
    assert agent.status_code == 403
    _still_pending(client, proposal)

    agent_with_cookie = _decision(
        client,
        proposal,
        "reject",
        {
            "X-TAFO-Actor": "agent",
            "Origin": "http://127.0.0.1:5173",
            "Sec-Fetch-Site": "same-origin",
            "Cookie": f"tafo_ui={token}",
        },
    )
    assert agent_with_cookie.status_code == 403
    _still_pending(client, proposal)

    token_less = _decision(
        client,
        proposal,
        "approve",
        {"X-TAFO-Actor": "human", "Origin": "http://127.0.0.1:5173", "Sec-Fetch-Site": "same-origin"},
    )
    assert token_less.status_code == 403
    assert token_less.json()["detail"]["code"] == "ui_session_required"
    _still_pending(client, proposal)

    edited = _decision(
        client,
        proposal,
        "edit",
        {"X-TAFO-Actor": "human", "Origin": "http://127.0.0.1:5173", "Sec-Fetch-Site": "same-origin"},
    )
    assert edited.status_code == 403
    _still_pending(client, proposal)

    denied = _decision(client, proposal, "reject", None)
    assert denied.status_code == 403
    _still_pending(client, proposal)

    browser = client.get(
        "/api/meta",
        headers={"Origin": "http://127.0.0.1:5173", "Sec-Fetch-Site": "same-origin"},
    )
    assert token not in browser.text
    assert f"tafo_ui={token}" in browser.headers.get("set-cookie", "")
    assert "HttpOnly" in browser.headers.get("set-cookie", "")
    assert "SameSite=Strict" in browser.headers.get("set-cookie", "")

    omitted_actor = _decision(
        client,
        proposal,
        "approve",
        {
            "Origin": "http://127.0.0.1:5173",
            "Sec-Fetch-Site": "same-origin",
            "Cookie": f"tafo_ui={token}",
        },
    )
    assert omitted_actor.status_code == 403
    assert omitted_actor.json()["detail"]["code"] == "ui_session_required"
    _still_pending(client, proposal)

    client.inject_ui_session = True
    allowed = client.post(
        f"/api/decisions/{proposal['id']}/approve",
        json={"expected_version": proposal["version"], "confirmed": True},
    )
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["proposal"]["status"] == "approved"


def test_display_zone_stores_dst_as_real_utc():
    zone = ZoneInfo("America/Indianapolis")
    spring_before = local_naive_to_utc("2027-03-14T01:30", "America/Indianapolis")
    spring_after = local_naive_to_utc("2027-03-14T03:30", "America/Indianapolis")
    assert spring_after - spring_before == timedelta(hours=1)
    assert spring_before.astimezone(zone).strftime("%z") == "-0500"
    assert spring_after.astimezone(zone).strftime("%z") == "-0400"
    fall_start = local_naive_to_utc("2027-11-07T00:30", "America/Indianapolis")
    fall_end = local_naive_to_utc("2027-11-07T02:30", "America/Indianapolis")
    assert fall_end - fall_start == timedelta(hours=3)
    assert fall_start.astimezone(zone).strftime("%z") == "-0400"
    assert fall_end.astimezone(zone).strftime("%z") == "-0500"


def test_human_schedule_still_approves_with_the_session(client):
    task = add_task(client, title="Water the balcony herbs", domain="home", estimate_hours=0.25, on_today=False)
    created = client.post(
        "/api/hermes/proposals",
        json={
            "source": "plan",
            "source_kind": "human",
            "kind": "calendar_block",
            "explanation": "Scheduled from the plan.",
            "idempotency_key": "plan.block.session-check",
            "payload": {
                "task_id": task["id"],
                "domain": "home",
                "starts_at": "2026-11-09T14:00:00Z",
                "ends_at": "2026-11-09T14:15:00Z",
                "allow_custom_title": True,
                "title": task["title"],
            },
        },
    )
    assert created.status_code == 201, created.text
    approved = client.post(
        f"/api/decisions/{created.json()['id']}/approve",
        json={"expected_version": created.json()["version"], "confirmed": True},
    )
    assert approved.status_code == 200, approved.text
    block = approved.json()["block"]
    assert block["title"] == "Water the balcony herbs"
    assert block["sync_state"] == "simulated"
