export class SyncStatus {
  static label(input: {
    offline: boolean;
    calendarMode: string;
    operations: { status: string }[];
  }): string {
    if (input.offline) {
      const unsynced = input.operations.filter((operation) => operation.status !== "synced").length;
      return `Offline – ${unsynced} unsynced`;
    }
    const pending = input.operations.filter((operation) => operation.status === "pending").length;
    if (pending > 0) return `${pending} pending`;
    if (input.calendarMode === "demo") return "Demo – not synced";
    return "Synced";
  }
}

export class PlanConfig {
  static autoApprove(flag: boolean | undefined): boolean {
    return flag !== false;
  }
}
