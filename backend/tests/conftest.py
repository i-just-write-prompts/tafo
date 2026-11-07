import fastapi.testclient as fastapi_testclient
import pytest

from tafo.app import create_app
from tafo.config import Settings


class LoopbackTestClient(fastapi_testclient.TestClient):
    """Existing tests keep working: decision calls receive the per-launch UI session.

    Set inject_ui_session = False to simulate an agent or API caller that never loaded the page.
    """

    inject_ui_session = True

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("base_url", "http://127.0.0.1")
        super().__init__(*args, **kwargs)

    def _with_ui_session(self, headers):
        token = self.app.state.ui_session_token
        merged: dict[str, str] = {}
        if headers:
            pairs = headers.items() if hasattr(headers, "items") else headers
            for key, value in pairs:
                merged[str(key)] = value
        lower = {key.lower() for key in merged}
        if "x-tafo-actor" not in lower:
            merged["X-TAFO-Actor"] = "human"
        cookie = merged.get("Cookie") or merged.get("cookie")
        if cookie is None:
            merged["Cookie"] = f"tafo_ui={token}"
        elif "tafo_ui=" not in cookie:
            merged["Cookie"] = f"{cookie}; tafo_ui={token}"
        return merged

    def request(self, method, url, **kwargs):
        if self.inject_ui_session:
            kwargs["headers"] = self._with_ui_session(kwargs.get("headers"))
        return super().request(method, url, **kwargs)


fastapi_testclient.TestClient = LoopbackTestClient
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=8787,
        data_dir=tmp_path,
        db_path=tmp_path / "tafo.sqlite",
        display_timezone="America/Indianapolis",
        calendar_mode="demo",
        google_credentials_file="",
        google_calendar_id="",
        work_invite_email="",
        allow_lan=False,
        seed_demo=False,
    )


@pytest.fixture
def client(settings):
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client


def make_client(settings: Settings, adapter=None) -> TestClient:
    app = create_app(settings, adapter=adapter)
    return TestClient(app)


def add_task(client: TestClient, **overrides) -> dict:
    body = {
        "title": "Sample task",
        "domain": "work",
        "estimate_hours": 1,
        "on_today": True,
    }
    body.update(overrides)
    response = client.post("/api/tasks", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def approve(client: TestClient, proposal: dict, **extra) -> dict:
    body = {"expected_version": proposal["version"], "confirmed": True}
    body.update(extra)
    response = client.post(f"/api/decisions/{proposal['id']}/approve", json=body)
    assert response.status_code == 200, response.text
    return response.json()
