"""Request bodies documented in OpenAPI."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    domain: Literal["work", "home", "personal"]
    status: Literal["todo", "doing", "waiting", "done"] = "todo"
    estimate_hours: float | None = Field(default=None, gt=0, le=100)
    due_date: str | None = None
    notes: str = Field(default="", max_length=5000)
    on_today: bool = False


class TaskPatch(BaseModel):
    expected_version: int
    title: str | None = None
    domain: Literal["work", "home", "personal"] | None = None
    status: Literal["todo", "doing", "waiting", "done"] | None = None
    estimate_hours: float | None = Field(default=None, gt=0, le=100)
    due_date: str | None = None
    notes: str | None = Field(default=None, max_length=5000)
    on_today: bool | None = None


class TaskMove(BaseModel):
    direction: Literal["up", "down"]
    view: Literal["all", "work", "life"] = "all"
    scope: Literal["all", "today", "backlog"] = "all"
    expected_version: int


class TaskDelete(BaseModel):
    expected_version: int


class SubtaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class SubtaskPatch(BaseModel):
    expected_version: int
    title: str | None = None
    done: bool | None = None


class ProposalCreate(BaseModel):
    source: str = Field(min_length=1, max_length=80)
    source_kind: Literal["agent", "human"] = "human"
    kind: Literal["task_change", "calendar_block", "calendar_update", "calendar_cancel"]
    explanation: str = Field(min_length=1, max_length=2000)
    idempotency_key: str | None = None
    payload: dict


class DecisionBody(BaseModel):
    expected_version: int
    confirmed: bool = False
    note: str = ""
    acknowledge_fixed_move: bool = False
    acknowledge_task_drift: bool = False


class EditBody(BaseModel):
    expected_version: int
    confirmed: bool = False
    payload: dict


class WeekSave(BaseModel):
    week_start: str
    expected_version: int
    bullets: str = Field(max_length=20000)


class WeekRegenerate(BaseModel):
    week_start: str | None = None
    expected_version: int


class RestoreBody(BaseModel):
    confirm: str
    snapshot: dict


class PlanMove(BaseModel):
    block_id: str
    expected_version: int
    starts_at: str
    ends_at: str
    idempotency_key: str = Field(min_length=6, max_length=120)
    title: str = Field(min_length=1, max_length=200)
    acknowledge_fixed_move: bool = False


class PlanApproval(BaseModel):
    proposal_id: str
    expected_version: int
    starts_at: str | None = None
    ends_at: str | None = None


class PlanCommit(BaseModel):
    """Stage every plan-mode move and included proposal in one transaction."""

    confirmed: bool = False
    moves: list[PlanMove] = Field(default_factory=list)
    approvals: list[PlanApproval] = Field(default_factory=list)


class CategoryHourSpan(BaseModel):
    domain: Literal["work", "home", "personal"]
    weekday: int = Field(ge=0, le=6)
    start_minutes: int = Field(ge=0, lt=24 * 60)
    end_minutes: int = Field(gt=0, le=24 * 60)


class CategoryHoursPut(BaseModel):
    spans: list[CategoryHourSpan]


class SacredWindowBody(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=120)
    days_mask: int = Field(ge=1, le=127)
    start_minutes: int = Field(ge=0, lt=24 * 60)
    end_minutes: int = Field(gt=0, le=24 * 60)
    agent_block: bool = True
    heads_up: bool = True


class FeedbackSubmit(BaseModel):
    client_id: str = Field(min_length=8, max_length=64)
    note: str = Field(min_length=1, max_length=5000)
    context: dict = Field(default_factory=dict)
    screenshot_base64: str | None = None
