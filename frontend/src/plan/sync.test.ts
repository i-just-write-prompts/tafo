import { describe, expect, it } from "vitest";
import { PlanConfig, SyncStatus } from "./sync";

describe("sync chip and auto-approve", () => {
  it("names the four chip states", () => {
    expect(SyncStatus.label({ offline: false, calendarMode: "demo", operations: [{ status: "simulated" }] })).toBe("Demo – not synced");
    expect(SyncStatus.label({ offline: false, calendarMode: "live", operations: [{ status: "synced" }] })).toBe("Synced");
    expect(SyncStatus.label({ offline: false, calendarMode: "demo", operations: [{ status: "pending" }, { status: "pending" }] })).toBe("2 pending");
    expect(SyncStatus.label({ offline: true, calendarMode: "demo", operations: [{ status: "simulated" }, { status: "pending" }] })).toBe("Offline – 2 unsynced");
  });

  it("approves Mike's own edits unless the setting is turned off", () => {
    expect(PlanConfig.autoApprove(undefined)).toBe(true);
    expect(PlanConfig.autoApprove(true)).toBe(true);
    expect(PlanConfig.autoApprove(false)).toBe(false);
  });
});
