import { api } from "../api";
import type { FeedbackContext } from "./feedbackCapture";
import { dequeueFeedback, enqueueFeedback, loadQueue, type QueuedFeedback } from "./feedbackStore";

export interface FeedbackResult {
  status: "sent" | "queued" | "not_configured";
  issue_number: number | null;
  idempotent_replay?: boolean;
}

export async function sendFeedback(note: string, context: FeedbackContext, screenshotDataUrl: string | null): Promise<FeedbackResult> {
  const body = {
    client_id: context.clientId,
    note,
    context: context as unknown as Record<string, unknown>,
    screenshot_base64: screenshotDataUrl,
  };
  const queued: QueuedFeedback = {
    clientId: context.clientId,
    note,
    context: context as unknown as Record<string, unknown>,
    screenshotDataUrl,
    createdAt: new Date().toISOString(),
  };
  enqueueFeedback(queued);
  try {
    const result = await api<FeedbackResult>("/api/feedback", { method: "POST", body: JSON.stringify(body) });
    if (result.status === "sent") dequeueFeedback(context.clientId);
    return result;
  } catch {
    return { status: "queued", issue_number: null };
  }
}

export async function flushFeedbackQueue(): Promise<void> {
  const queue = loadQueue();
  for (const item of queue) {
    try {
      const result = await api<FeedbackResult>("/api/feedback", {
        method: "POST",
        body: JSON.stringify({
          client_id: item.clientId,
          note: item.note,
          context: item.context,
          screenshot_base64: item.screenshotDataUrl ?? null,
        }),
      });
      if (result.status === "sent") dequeueFeedback(item.clientId);
    } catch {
      break;
    }
  }
}
