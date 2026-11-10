import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..");

const CALL = /(?:\bapi|\bfetch)\s*(?:<[^>\n]*>)?\(\s*[`'"]\/api\/(?:calendar\/|decisions\/|hermes\/proposals)/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "calendar") continue;
      sourceFiles(full, acc);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    acc.push(full);
  }
  return acc;
}

describe("calendar endpoint access", () => {
  it("keeps calendar and decision fetches inside CalendarClient", () => {
    const client = fs.readFileSync(path.join(here, "client.ts"), "utf8");
    expect(client).toContain('"/api/calendar/blocks"');
    expect(client).toContain('"/api/decisions/plan/commit"');
    expect(client).toContain('"/api/hermes/proposals"');
    const hits: string[] = [];
    for (const file of sourceFiles(src)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (CALL.test(line)) hits.push(`${path.relative(src, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
