import json

from tafo.calendar_adapter import GENERIC_DESCRIPTION, OUTLOOK_GAP

from tests.conftest import add_task, approve


def test_agent_proposal_does_not_apply_until_a_person_approves(client):
    task = add_task(client, title="Northwind outline", domain="work", on_today=False)
    created = client.post(
        "/api/hermes/proposals",
        headers={"X-TAFO-Actor": "agent"},
        json={
            "source": "sample-agent",
            "source_kind": "agent",
            "kind": "task_change",
            "explanation": "Suggest moving the sample outline onto Today.",
            "idempotency_key": "agent-req-outline-1",
            "payload": {
                "op": "update",
                "task_id": task["id"],
                "changes": {"on_today": True, "title": "Should not apply yet"},
            },
        },
    )
    assert created.status_code == 201, created.text
    proposal = created.json()
    assert proposal["status"] == "pending"
    fresh = client.get(f"/api/tasks/{task['id']}").json()
    assert fresh["on_today"] is False
    assert fresh["title"] == "Northwind outline"

    replay = client.post(
        "/api/hermes/proposals",
        headers={"X-TAFO-Actor": "agent"},
        json={
            "source": "sample-agent",
            "source_kind": "agent",
            "kind": "task_change",
            "explanation": "Suggest moving the sample outline onto Today.",
            "idempotency_key": "agent-req-outline-1",
            "payload": {"op": "update", "task_id": task["id"], "changes": {"on_today": True}},
        },
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["id"] == proposal["id"]

    for action in ("approve", "reject", "edit"):
        denied = client.post(f"/api/hermes/proposals/{proposal['id']}/{action}", json={"confirmed": True})
        assert denied.status_code == 403
        assert denied.json()["detail"]["code"] == "approval_required"

    agent_decision = client.post(
        f"/api/decisions/{proposal['id']}/approve",
        headers={"X-TAFO-Actor": "agent"},
        json={"expected_version": proposal["version"], "confirmed": True},
    )
    assert agent_decision.status_code == 403
    assert client.get(f"/api/tasks/{task['id']}").json()["on_today"] is False

    unconfirmed = client.post(
        f"/api/decisions/{proposal['id']}/approve",
        json={"expected_version": proposal["version"], "confirmed": False},
    )
    assert unconfirmed.status_code == 400

    edited = client.post(
        f"/api/decisions/{proposal['id']}/edit",
        json={
            "expected_version": proposal["version"],
            "confirmed": True,
            "payload": {"op": "update", "task_id": task["id"], "changes": {"on_today": True, "status": "doing"}},
        },
    )
    assert edited.status_code == 200, edited.text
    assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "todo"
    decision = approve(client, edited.json())
    assert decision["idempotent_replay"] is False
    updated = client.get(f"/api/tasks/{task['id']}").json()
    assert updated["on_today"] is True
    assert updated["status"] == "doing"
    assert updated["title"] == "Northwind outline"


def test_reject_leaves_the_task_alone(client):
    task = add_task(client, title="Library hold", domain="personal", status="waiting")
    proposal = client.post(
        "/api/hermes/proposals",
        json={
            "source": "tafo-ui",
            "source_kind": "human",
            "kind": "task_change",
            "explanation": "Maybe mark the sample done.",
            "payload": {"op": "update", "task_id": task["id"], "changes": {"status": "done"}},
        },
    ).json()
    rejected = client.post(
        f"/api/decisions/{proposal['id']}/reject",
        json={"expected_version": proposal["version"], "confirmed": True, "note": "Not yet"},
    )
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == "rejected"
    assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "waiting"


def test_version_conflict_on_task_and_proposal(client):
    task = add_task(client, title="Rank me", domain="home")
    stale = client.patch(
        f"/api/tasks/{task['id']}",
        json={"expected_version": task["version"], "notes": "first"},
    )
    assert stale.status_code == 200, stale.text
    conflict = client.patch(
        f"/api/tasks/{task['id']}",
        json={"expected_version": task["version"], "notes": "stale"},
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "version_conflict"
    assert client.get(f"/api/tasks/{task['id']}").json()["notes"] == "first"

    proposal = client.post(
        "/api/hermes/proposals",
        json={
            "source": "tafo-ui",
            "kind": "task_change",
            "explanation": "Bring the sample forward.",
            "payload": {"op": "update", "task_id": task["id"], "changes": {"on_today": False}},
        },
    ).json()
    edited = client.post(
        f"/api/decisions/{proposal['id']}/edit",
        json={
            "expected_version": proposal["version"],
            "confirmed": True,
            "payload": {"op": "update", "task_id": task["id"], "changes": {"notes": "from edit"}},
        },
    )
    assert edited.status_code == 200, edited.text
    raced = client.post(
        f"/api/decisions/{proposal['id']}/approve",
        json={"expected_version": proposal["version"], "confirmed": True},
    )
    assert raced.status_code == 409
    audit = client.get("/api/audit").json()["entries"]
    assert any(entry["action"] == "task.update" for entry in audit)
    assert any(entry["action"] == "proposal.edit" for entry in audit)


def test_calendar_proposal_reads_busy_time_and_keeps_generic_title(client):
    task = add_task(client, title="Quiet sample writing", domain="work", estimate_hours=1)
    evil = "ceo@corp.example"
    created = client.post(
        "/api/hermes/proposals",
        headers={"X-TAFO-Actor": "agent"},
        json={
            "source": "sample-agent",
            "source_kind": "agent",
            "kind": "calendar_block",
            "explanation": "Hold an hour for the sample. This must not rename the event.",
            "idempotency_key": "agent-cal-1",
            "payload": {
                "task_id": task["id"],
                "domain": "work",
                "title": "Quarterly secret launch",
                "description": "confidential client name",
                "work_email": evil,
                "starts_at": "2026-11-10T15:00:00Z",
                "ends_at": "2026-11-10T16:00:00Z",
                "invite_work_email": True,
                "fixed": True,
            },
        },
    )
    assert created.status_code == 201, created.text
    proposal = created.json()
    encoded = json.dumps(proposal)
    assert evil not in encoded
    assert "Quarterly secret launch" not in encoded
    assert proposal["payload"]["title"] == "Focus block"
    assert proposal["payload"]["description"] == GENERIC_DESCRIPTION
    assert proposal["payload"]["fixed"] is False
    assert proposal["payload"]["starts_at"] == "2026-11-10T15:00:00Z"
    assert proposal["availability"]["outlook_gap"] == OUTLOOK_GAP
    assert proposal["availability"]["conflict_free"] is False
    assert proposal["availability"]["read_source"] == "demo_fixtures"
    assert client.get("/api/calendar/blocks").json()["blocks"] == []
    decision = approve(client, proposal)
    assert decision["outbox"]["status"] == "simulated"
    assert "not synced" in decision["outbox"]["honest_label"].lower()
    assert "simulated" in decision["outbox"]["honest_label"].lower()
    assert decision["outbox"]["google_event_id"] is None
    assert decision["block"]["sync_state"] == "simulated"
    assert decision["block"]["written_mode"] == "demo"
    assert decision["block"]["title"] == "Focus block"
    again = approve(client, decision["proposal"])
    assert again["idempotent_replay"] is True
    assert again["outbox"]["id"] == decision["outbox"]["id"]
    operations = client.get("/api/calendar/outbox").json()["operations"]
    assert len([item for item in operations if item["proposal_id"] == proposal["id"]]) == 1
