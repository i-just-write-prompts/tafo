from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from tests.conftest import add_task


def test_indianapolis_display_offset():
    moment = datetime(2026, 11, 6, 14, 0, tzinfo=timezone.utc)
    local = moment.astimezone(ZoneInfo("America/Indianapolis"))
    assert local.hour == 9
    assert local.utcoffset() is not None
    assert local.utcoffset().total_seconds() == -5 * 3600


def test_task_crud_filters_checklist_and_order(client):
    work = add_task(client, title="Draft the sample brief", domain="work", estimate_hours=1.5, due_date="2026-11-10", notes="Desk copy")
    home = add_task(client, title="Mend the sample curtain", domain="home", on_today=False, estimate_hours=0.5)
    personal = add_task(client, title="Read Harbor Signals chapter 4", domain="personal", on_today=True)

    listed = client.get("/api/tasks", params={"view": "all", "scope": "all"}).json()
    assert listed["filter_only"] is True
    assert listed["authorization"] == "none"
    assert {task["title"] for task in listed["tasks"]} == {
        "Draft the sample brief",
        "Mend the sample curtain",
        "Read Harbor Signals chapter 4",
    }

    life = client.get("/api/tasks", params={"view": "life", "scope": "all"}).json()
    assert {task["domain"] for task in life["tasks"]} == {"home", "personal"}
    work_only = client.get("/api/tasks", params={"view": "work", "scope": "today"}).json()
    assert [task["id"] for task in work_only["tasks"]] == [work["id"]]
    backlog = client.get("/api/tasks", params={"view": "all", "scope": "backlog"}).json()
    assert [task["id"] for task in backlog["tasks"]] == [home["id"]]

    created = client.post(f"/api/tasks/{work['id']}/subtasks", json={"title": "Open the sample folder"})
    assert created.status_code == 201, created.text
    item = created.json()
    toggled = client.patch(f"/api/subtasks/{item['id']}", json={"expected_version": item["version"], "done": True})
    assert toggled.status_code == 200, toggled.text
    assert toggled.json()["done"] is True

    moved = client.post(
        f"/api/tasks/{personal['id']}/move",
        json={"direction": "up", "view": "all", "scope": "today", "expected_version": personal["version"]},
    )
    assert moved.status_code == 200, moved.text
    today = client.get("/api/tasks", params={"view": "all", "scope": "today"}).json()["tasks"]
    assert [task["id"] for task in today][:2] == [personal["id"], work["id"]]

    current = client.get(f"/api/tasks/{work['id']}").json()
    patched = client.patch(
        f"/api/tasks/{current['id']}",
        json={"expected_version": current["version"], "status": "doing", "estimate_hours": 2},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["status"] == "doing"
    assert patched.json()["estimate_hours"] == 2

    deleted = client.post(f"/api/tasks/{home['id']}/delete", json={"expected_version": home["version"]})
    assert deleted.status_code == 200, deleted.text
    assert client.get(f"/api/tasks/{home['id']}").status_code == 404


def test_timer_and_weekly_bullets(client):
    task = add_task(client, title="File the sample envelope", domain="work", estimate_hours=0.5)
    first = client.post(f"/api/tasks/{task['id']}/timer/start")
    assert first.status_code == 200, first.text
    assert first.json()["running"] is True
    blocked = client.post(f"/api/tasks/{task['id']}/timer/start")
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "timer_active"
    stopped = client.post(f"/api/tasks/{task['id']}/timer/stop")
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()["ended_at"] is not None

    done = client.patch(f"/api/tasks/{task['id']}", json={"expected_version": task["version"], "status": "done"})
    assert done.status_code == 200, done.text
    week = client.get("/api/week")
    assert week.status_code == 200, week.text
    body = week.json()
    assert "File the sample envelope (work)" in body["bullets"]
    assert body["timezone"] == "America/Indianapolis"

    custom = "- Shipped the sample envelope by hand.\n"
    saved = client.put("/api/week", json={"week_start": body["week_start"], "expected_version": body["version"], "bullets": custom})
    assert saved.status_code == 200, saved.text
    assert saved.json()["bullets"] == custom
    again = client.get("/api/week").json()
    assert again["bullets"] == custom

    rebuilt = client.post(
        "/api/week/regenerate",
        json={"week_start": body["week_start"], "expected_version": saved.json()["version"]},
    )
    assert rebuilt.status_code == 200, rebuilt.text
    assert "File the sample envelope (work)" in rebuilt.json()["bullets"]
    assert rebuilt.json()["version"] == saved.json()["version"] + 1


def test_agent_cannot_patch_tasks(client):
    task = add_task(client, title="Leave this sample alone")
    denied = client.patch(
        f"/api/tasks/{task['id']}",
        json={"expected_version": task["version"], "title": "Changed by agent"},
        headers={"X-TAFO-Actor": "agent"},
    )
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "agent_cannot_mutate"
    fresh = client.get(f"/api/tasks/{task['id']}").json()
    assert fresh["title"] == "Leave this sample alone"
    assert fresh["version"] == task["version"]
