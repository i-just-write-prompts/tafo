import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../e2e");

function specs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return specs(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("save-claim rule", () => {
  it("sends toast text assertions through saveClaim", () => {
    const failures: string[] = [];
    for (const file of specs(e2eDir)) {
      if (file.endsWith(`${path.sep}helpers${path.sep}saveClaim.ts`)) continue;
      const source = readFileSync(file, "utf8");
      const names = new Set<string>();
      for (const line of source.split("\n")) {
        const assigned = /(?:const|let)\s+(\w+)\s*=\s*.*plan-toast/.exec(line);
        if (assigned) names.add(assigned[1]);
        const claims = /to(?:ContainText|HaveText)\(|\.innerText/.test(line);
        const direct = /plan-toast/.test(line) && claims;
        const viaName = [...names].some((name) => new RegExp(`\\b${name}\\b`).test(line) && claims);
        if (direct || viaName) failures.push(`${path.relative(e2eDir, file)}: ${line.trim()}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
