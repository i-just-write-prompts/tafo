import { describe, expect, it } from "vitest";

import { wrapWeekTitle } from "./titles";

const widthOf = (value: string) => value.length * 6;

describe("week titles", () => {
  it("hyphenates a word that cannot fit, then fades a one-line short title", () => {
    const design = wrapWeekTitle("Design crit", 30, 3, widthOf);
    expect(design.lines[0].endsWith("-")).toBe(true);
    expect(design.faded).toBe(false);
    const vendor = wrapWeekTitle("Call vendor", 36, 1, widthOf);
    expect(vendor.lines).toEqual(["Call vendor"]);
    expect(vendor.faded).toBe(true);
  });
});
