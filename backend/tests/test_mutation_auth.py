"""Every mutating route rejects a caller who is not the local person.

Decision routes (approve, deny, edit, plan commit) need the UI session cookie.
Every other mutation rejects an explicit agent and treats a missing actor as
the local person, so POST /api/tasks with no cookie is 201. That split is
intentional: this API has no login, and the cookie only gates calendar decisions.
POST /api/hermes/proposals stays the one agent write.
"""

from fastapi.testclient import TestClient

BODIES = {
    ("POST", "/api/tasks"): {"title": "Nope", "domain": "work"},
    ("PATCH", "/api/tasks/{task_id}"): {"expected_version": 1, "title": "Nope"},
    ("POST", "/api/tasks/{task_id}/move"): {"direction": "up", "view": "all", "scope": "all", "expected_version": 1},
    ("POST", "/api/tasks/{task_id}/delete"): {"expected_version": 1},
    ("POST", "/api/tasks/{task_id}/subtasks"): {"title": "Nope"},
    ("PATCH", "/api/subtasks/{subtask_id}"): {"expected_version": 1, "title": "Nope"},
    ("DELETE", "/api/subtasks/{subtask_id}"): None,
    ("POST", "/api/tasks/{task_id}/timer/start"): None,
    ("POST", "/api/tasks/{task_id}/timer/stop"): None,
    ("PUT", "/api/week"): {"week_start": "2026-11-09", "expected_version": 1, "bullets": ""},
    ("POST", "/api/week/regenerate"): {"expected_version": 1},
    ("POST", "/api/decisions/plan/commit"): {"confirmed": True, "moves": [], "approvals": []},
    ("POST", "/api/decisions/{proposal_id}/approve"): {"expected_version": 1, "confirmed": True},
    ("POST", "/api/decisions/{proposal_id}/edit"): {"expected_version": 1, "confirmed": True, "payload": {}},
    ("POST", "/api/decisions/{proposal_id}/reject"): {"expected_version": 1, "confirmed": True},
    ("POST", "/api/calendar/outbox/{outbox_id}/retry"): None,
    ("POST", "/api/admin/backup"): None,
    ("POST", "/api/admin/restore"): {"confirm": "REPLACE_LOCAL_DATA", "snapshot": {}},
}

AGENT_ALLOWED = {("POST", "/api/hermes/proposals")}
HERMES_DECIDE = {
    ("POST", "/api/hermes/proposals/{proposal_id}/{action}"),
    ("PUT", "/api/hermes/proposals/{proposal_id}/{action}"),
    ("PATCH", "/api/hermes/proposals/{proposal_id}/{action}"),
}
MANAGER = {
    ("POST", "/api/manager"),
    ("PUT", "/api/manager"),
    ("PATCH", "/api/manager"),
    ("DELETE", "/api/manager"),
    ("POST", "/api/manager/{rest}"),
    ("PUT", "/api/manager/{rest}"),
    ("PATCH", "/api/manager/{rest}"),
    ("DELETE", "/api/manager/{rest}"),
}


def _fill(path: str) -> str:
    return (
        path.replace("{task_id}", "missing")
        .replace("{subtask_id}", "missing")
        .replace("{proposal_id}", "missing")
        .replace("{outbox_id}", "missing")
    )


def _writes(client: TestClient) -> set[tuple[str, str]]:
    spec = client.get("/openapi.json").json()
    found = set()
    for path, methods in spec["paths"].items():
        for method in methods:
            if method in {"post", "put", "patch", "delete"}:
                found.add((method.upper(), path))
    return found


def test_every_mutation_rejects_an_agent_and_decisions_require_a_session(client):
    found = _writes(client)
    assert found == set(BODIES) | AGENT_ALLOWED | HERMES_DECIDE | MANAGER
    client.inject_ui_session = False
    blocks = client.get("/api/calendar/blocks").json()
    proposals = client.get("/api/hermes/proposals").json()
    tasks = client.get("/api/tasks").json()

    for key, body in BODIES.items():
        method, path = key
        url = _fill(path)
        kwargs = {"headers": {"X-TAFO-Actor": "agent"}}
        if body is not None:
            kwargs["json"] = body
        if method == "DELETE":
            kwargs["params"] = {"expected_version": 1}
        agent = client.request(method, url, **kwargs)
        assert agent.status_code == 403, (key, agent.status_code, agent.text)
        if path.startswith("/api/decisions"):
            quiet = {"json": body} if body is not None else {}
            missing = client.request(method, url, **quiet)
            assert missing.status_code == 403, (key, missing.status_code, missing.text)
            assert missing.json()["detail"]["code"] == "ui_session_required"

    for key in HERMES_DECIDE:
        denied = client.request(key[0], _fill(key[1]).replace("{action}", "approve"))
        assert denied.status_code == 403, (key, denied.status_code, denied.text)
    for key in MANAGER:
        deferred = client.request(key[0], _fill(key[1]))
        assert deferred.status_code == 501, (key, deferred.status_code, deferred.text)

    assert client.get("/api/calendar/blocks").json() == blocks
    assert client.get("/api/hermes/proposals").json() == proposals
    assert client.get("/api/tasks").json() == tasks

    # No cookie and no actor header. Tasks stay open to the local person.
    created = client.post("/api/tasks", json={"title": "Local person", "domain": "work"})
    assert created.status_code == 201, created.text
    denied = client.post(
        "/api/decisions/plan/commit",
        json={"confirmed": True, "moves": [], "approvals": []},
    )
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "ui_session_required"


def test_cookie_free_writes_reject_cross_site_and_non_json(client):
    client.inject_ui_session = False
    blocks = client.get("/api/calendar/blocks").json()
    proposals = client.get("/api/hermes/proposals").json()
    tasks = client.get("/api/tasks").json()
    routes = [key for key in BODIES if not key[1].startswith("/api/decisions")]
    routes.append(("POST", "/api/hermes/proposals"))
    routes.extend(MANAGER)
    assert ("POST", "/api/admin/restore") in routes
    for method, path in routes:
        url = _fill(path).replace("{rest}", "tasks").replace("{action}", "approve")
        origin = client.request(
            method,
            url,
            content=b"{}",
            headers={"Origin": "https://evil.example", "Content-Type": "application/json"},
        )
        assert origin.status_code == 403, (method, path, origin.status_code, origin.text)
        assert origin.json()["detail"]["code"] == "bad_origin"
        cross = client.request(
            method,
            url,
            content=b"{}",
            headers={"Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"},
        )
        assert cross.status_code == 403, (method, path, cross.status_code, cross.text)
        assert cross.json()["detail"]["code"] == "cross_site"
        bare = client.request(method, url, content=b"{}")
        assert bare.status_code == 415, (method, path, bare.status_code, bare.text)
        assert bare.json()["detail"]["code"] == "json_required"
    assert client.get("/api/calendar/blocks").json() == blocks
    assert client.get("/api/hermes/proposals").json() == proposals
    assert client.get("/api/tasks").json() == tasks
