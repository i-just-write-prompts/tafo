import { describe, expect, it } from "vitest";
import { ApiError, OFFLINE_MESSAGE, interpretResponse, reportFailure } from "./api";

describe("offline proxy responses", () => {
  it("turns an empty 500 into a retryable offline message", () => {
    const result = interpretResponse(500, "", "Internal Server Error");
    expect(result.offline).toBe(true);
    expect(result.message).toBe(OFFLINE_MESSAGE);
    expect(result.message).toContain("127.0.0.1:8787");
    expect(result.message).not.toBe("Internal Server Error");
  });

  it("keeps a JSON error from the API", () => {
    const result = interpretResponse(400, JSON.stringify({ detail: { code: "bad_host", message: "Loopback only." } }), "Bad Request");
    expect(result.offline).toBe(false);
    expect(result.code).toBe("bad_host");
    expect(result.message).toBe("Loopback only.");
  });
});

describe("version conflicts", () => {
  it("refetches and keeps the conflict message", async () => {
    const error = new ApiError("This task changed since you loaded it. Reload and try again.", {
      status: 409,
      code: "version_conflict",
    });
    let refreshed = 0;
    const notes: string[] = [];
    await reportFailure(
      error,
      async () => {
        refreshed += 1;
      },
      (message) => notes.push(message),
    );
    expect(refreshed).toBe(1);
    expect(notes).toEqual(["This task changed since you loaded it. Reload and try again. The latest copy is loaded."]);
  });

  it("does not refetch for a different error", async () => {
    let refreshed = 0;
    const notes: string[] = [];
    await reportFailure(
      new ApiError("Stop the running timer before starting another.", { status: 409, code: "timer_active" }),
      async () => {
        refreshed += 1;
      },
      (message) => notes.push(message),
    );
    expect(refreshed).toBe(0);
    expect(notes).toEqual(["Stop the running timer before starting another."]);
  });
});
