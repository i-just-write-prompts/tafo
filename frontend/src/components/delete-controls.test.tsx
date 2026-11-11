/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { Inbox } from "./Inbox";
import { TaskBoard } from "./TaskBoard";
import type { Meta, Proposal, Task } from "../types";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

const meta: Meta = {
  name: "TAFO",
  tagline: "Task around & find out",
  calendar_mode: "demo",
  sync_label: "Demo dry-run — NOT synced to Google Calendar",
  display_timezone: "America/Indianapolis",
  google_configured: false,
  work_invite_configured: false,
  manager_access: "deferred",
  outlook_gap: "Invite-only.",
  notices: ["Filters are not a boundary.", "Ask first."],
  filter_note: "Work, Life, and All are view filters.",
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_sample",
    title: "Draft the sample",
    domain: "work",
    status: "todo",
    estimate_hours: 1,
    due_date: null,
    notes: "",
    sort_order: 10,
    on_today: true,
    version: 3,
    subtasks: [
      {
        id: "sub_sample",
        task_id: "task_sample",
        title: "Open the folder",
        done: false,
        sort_order: 10,
        version: 2,
      },
    ],
    tracked_seconds: 0,
    progress: {
      checklist_done: 0,
      checklist_total: 1,
      estimate_hours: 1,
      tracked_hours: 0,
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("task and checklist delete controls", () => {
  it("asks before deleting a task and sends expected_version", async () => {
    apiMock.mockResolvedValue({ deleted: true });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    render(
      <TaskBoard
        tasks={[task()]}
        meta={meta}
        view="all"
        scope="today"
        onView={() => undefined}
        onRefresh={onRefresh}
        onError={onError}
        onProposed={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete task Draft the sample" }));
    expect(apiMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete task Draft the sample" }));
    await screen.findByRole("button", { name: "Delete task Draft the sample" });
    expect(apiMock).toHaveBeenCalledWith("/api/tasks/task_sample/delete", {
      method: "POST",
      body: JSON.stringify({ expected_version: 3 }),
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("refreshes when deleting a checklist item returns 409", async () => {
    apiMock.mockRejectedValue(
      new ApiError("This checklist item changed.", { status: 409, code: "version_conflict" }),
    );
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    render(
      <TaskBoard
        tasks={[task()]}
        meta={meta}
        view="all"
        scope="today"
        onView={() => undefined}
        onRefresh={onRefresh}
        onError={onError}
        onProposed={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete checklist item Open the folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete checklist item Open the folder" }));
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(apiMock).toHaveBeenCalledWith("/api/subtasks/sub_sample?expected_version=2", { method: "DELETE" });
    expect(onError).toHaveBeenCalledWith("This checklist item changed. The latest copy is loaded.");
  });

  it("deletes the linked task from the inbox and refreshes on 409", async () => {
    const sample = task();
    const proposal: Proposal = {
      id: "prp_sample",
      source: "tafo-ui",
      source_kind: "human",
      kind: "task_change",
      status: "pending",
      explanation: "Suggest a change to the sample.",
      payload: { op: "update", task_id: sample.id, changes: { notes: "later" } },
      edited_payload: null,
      availability: null,
      version: 1,
    };
    apiMock.mockRejectedValue(
      new ApiError("This task changed since you loaded it.", { status: 409, code: "version_conflict" }),
    );
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    render(
      <Inbox
        proposals={[proposal]}
        tasks={[sample]}
        meta={meta}
        onRefresh={onRefresh}
        onError={onError}
        onApproved={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete task Draft the sample" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete task Draft the sample" }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(apiMock).toHaveBeenCalledWith("/api/tasks/task_sample/delete", {
      method: "POST",
      body: JSON.stringify({ expected_version: 3 }),
    });
    expect(onRefresh).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("This task changed since you loaded it. The latest copy is loaded.");
  });
});
