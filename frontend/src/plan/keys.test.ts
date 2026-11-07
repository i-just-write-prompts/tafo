import { describe, expect, it } from "vitest";
import { PlanKeys } from "./keys";

describe("plan keys", () => {
  it("maps the default keys and leaves typing alone except escape", () => {
    expect(PlanKeys.command({ key: "t" })).toBe("today");
    expect(PlanKeys.command({ key: "W" })).toBe("week");
    expect(PlanKeys.command({ key: "d" })).toBe("day");
    expect(PlanKeys.command({ key: "n" })).toBe("quick-add");
    expect(PlanKeys.command({ key: "/" })).toBe("find");
    expect(PlanKeys.command({ key: "a" })).toBe("approve");
    expect(PlanKeys.command({ key: "x" })).toBe("deny");
    expect(PlanKeys.command({ key: " " })).toBe("toggle-done");
    expect(PlanKeys.command({ key: "ArrowLeft" })).toBe("arrow-left");
    expect(PlanKeys.command({ key: "ArrowUp" })).toBe("arrow-up");
    expect(PlanKeys.command({ key: "z", ctrlKey: true })).toBe("undo");
    expect(PlanKeys.command({ key: "t", target: { tagName: "INPUT" } })).toBeNull();
    expect(PlanKeys.command({ key: "z", ctrlKey: true, target: { tagName: "INPUT", type: "checkbox" } })).toBe("undo");
    expect(PlanKeys.command({ key: "Escape", target: { tagName: "INPUT" } })).toBe("escape");
    expect(PlanKeys.command({ key: "t", metaKey: true })).toBeNull();
  });
});
