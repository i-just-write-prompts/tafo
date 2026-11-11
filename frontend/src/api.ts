export const OFFLINE_MESSAGE =
  "TAFO can't reach the API at 127.0.0.1:8787. The local server may not be running.";

export class ApiError extends Error {
  status: number;
  code?: string;
  offline: boolean;

  constructor(message: string, options: { status?: number; code?: string; offline?: boolean } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? 0;
    this.code = options.code;
    this.offline = options.offline ?? false;
  }
}

export function interpretResponse(
  status: number,
  text: string,
  statusText: string,
): { message: string; code?: string; offline: boolean } {
  const trimmed = text.trim();
  if (!trimmed) {
    if (status >= 500) {
      return { message: OFFLINE_MESSAGE, offline: true };
    }
    return { message: statusText || "Request failed", offline: false };
  }
  try {
    const body = JSON.parse(trimmed) as { detail?: { message?: string; code?: string } | string };
    const detail = body?.detail;
    const code = typeof detail === "object" ? detail?.code : undefined;
    const message = typeof detail === "string" ? detail : detail?.message || statusText || "Request failed";
    return { message, code, offline: false };
  } catch {
    if (status >= 500) {
      return { message: OFFLINE_MESSAGE, offline: true };
    }
    return { message: statusText || "Request failed", offline: false };
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new ApiError(OFFLINE_MESSAGE, { offline: true });
  }
  const text = await response.text();
  if (!response.ok) {
    const interpreted = interpretResponse(response.status, text, response.statusText);
    throw new ApiError(interpreted.message, {
      status: response.status,
      code: interpreted.code,
      offline: interpreted.offline,
    });
  }
  return (text ? JSON.parse(text) : null) as T;
}

export async function reportFailure(
  error: unknown,
  onRefresh: () => Promise<void>,
  onError: (message: string) => void,
): Promise<void> {
  if (error instanceof ApiError && error.code === "version_conflict") {
    try {
      await onRefresh();
    } catch (refreshError) {
      onError(refreshError instanceof Error ? refreshError.message : "Could not refresh");
      return;
    }
    onError(`${error.message} The latest copy is loaded.`);
    return;
  }
  if (error instanceof ApiError) {
    onError(error.message);
    return;
  }
  onError(error instanceof Error ? error.message : "Something went wrong");
}

export function toLocalInput(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function formatWhen(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function payloadOf(proposal: { payload: Record<string, unknown>; edited_payload: Record<string, unknown> | null }) {
  return proposal.edited_payload ?? proposal.payload;
}
