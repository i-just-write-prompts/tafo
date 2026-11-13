import { expect, test } from "@playwright/test";
import { reseed } from "./support";

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test("feedback send hits server mock issue", async ({ page, request }) => {
  await reseed(request);
  const body = await request.post("http://127.0.0.1:8787/api/feedback", {
    headers: { "X-TAFO-Actor": "human" },
    data: { client_id: "e2e-issue-1", note: "From playwright", context: { view: "Day" } },
  });
  expect(body.ok()).toBeTruthy();
  const json = await body.json();
  expect(json.status).toBe("sent");
  expect(json.issue_number).toBe(42);
});

test("client bundle has no GitHub token string", async ({ page }) => {
  await page.goto("/");
  const scripts = await page.locator("script[src]").evaluateAll((nodes) => nodes.map((n) => (n as HTMLScriptElement).src));
  let joined = "";
  for (const src of scripts) {
    const res = await page.request.get(src);
    joined += await res.text();
  }
  expect(joined).not.toContain("github_pat_");
  expect(joined).not.toContain("ghp_");
});
