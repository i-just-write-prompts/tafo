const QUEUE_KEY = "tafo.feedback.queue";
const SENT_ONCE_KEY = "tafo.feedback.sentOnce";

export interface QueuedFeedback {
  clientId: string;
  note: string;
  context: Record<string, unknown>;
  screenshotDataUrl?: string | null;
  createdAt: string;
}

export function feedbackSentOnce(): boolean {
  return localStorage.getItem(SENT_ONCE_KEY) === "1";
}

export function markFeedbackSentOnce(): void {
  localStorage.setItem(SENT_ONCE_KEY, "1");
}

export function loadQueue(): QueuedFeedback[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueuedFeedback[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveQueue(rows: QueuedFeedback[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(rows));
}

export function enqueueFeedback(item: QueuedFeedback): void {
  const queue = loadQueue().filter((row) => row.clientId !== item.clientId);
  queue.push(item);
  saveQueue(queue);
}

export function dequeueFeedback(clientId: string): void {
  saveQueue(loadQueue().filter((row) => row.clientId !== clientId));
}
