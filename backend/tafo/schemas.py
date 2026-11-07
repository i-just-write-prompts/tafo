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
