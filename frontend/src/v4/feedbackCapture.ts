import { TAFO_REV } from "../rev";

export interface FeedbackContext {
  view: string;
  sheet: string;
  dateLabel: string;
  selectedTitle: string | null;
  selectedId: string | null;
  planMode: boolean;
  stagedCount: number;
  build: string;
  version: string;
  viewport: string;
  timezone: string;
  timestamp: string;
  clientId: string;
}

export function mintClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `fb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildContext(input: {
  view: string;
  sheet: string;
  dateLabel: string;
  selectedTitle: string | null;
  selectedId: string | null;
  planMode: boolean;
  stagedCount: number;
  version?: string;
}): FeedbackContext {
  return {
    ...input,
    build: TAFO_REV.slice(0, 7),
    version: input.version ?? "v4-slice2",
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timestamp: new Date().toISOString(),
    clientId: mintClientId(),
  };
}

export function contextLine(context: FeedbackContext): string {
  const title = context.selectedTitle ? context.selectedTitle : "—";
  return `${context.view} · ${context.dateLabel} · ${title} · build ${context.build}`;
}

/** Screenshot capture is off in this build (no client dependency; see AC 61). */
export async function captureScreenshot(allow: boolean): Promise<string | null> {
  void allow;
  return null;
}
