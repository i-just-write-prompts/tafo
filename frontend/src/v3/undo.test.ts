import { describe, expect, it } from "vitest";

import { showUndo, UNDO_MS, undoExpired, undoStillThere } from "./undo";

describe("undo timer", () => {
  it("keeps the toast for four seconds and then drops it", () => {
    const toast = showUndo("Call vendor → 11:00 AM", { id: "t3" }, 1_000, 7);
    expect(undoExpired(toast, 1_000 + UNDO_MS - 1)).toBe(false);
    expect(undoStillThere(toast, 7, 1_000 + UNDO_MS - 1)).toBe(true);
    expect(undoExpired(toast, 1_000 + UNDO_MS)).toBe(true);
    expect(undoStillThere(toast, 8, 1_200)).toBe(false);
    expect(undoExpired(null, 0)).toBe(false);
  });
});
