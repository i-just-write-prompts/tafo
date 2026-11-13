import { useCallback, useEffect, useRef, useState } from "react";
import type { Meta } from "../types";
import type { CalEvent } from "../v3/model";
import { PlanTime } from "../plan/time";
import { buildContext, captureScreenshot, type FeedbackContext } from "./feedbackCapture";
import { sendFeedback, flushFeedbackQueue } from "./feedbackApi";
import { feedbackHoldDown, feedbackHoldMove, feedbackHoldReady, feedbackHoldUp, type FeedbackHoldState } from "./feedbackGesture";
import { feedbackSentOnce, markFeedbackSentOnce } from "./feedbackStore";
import { headsUpForMove, blockOutsideHours } from "./hours";
import type { HoursPayload } from "./hoursTypes";
import { slice2Enabled } from "./slice2";

export interface TrayMsg {
  message: string;
  line2?: string;
  undo?: (() => Promise<void>) | null;
  retry?: (() => Promise<void>) | null;
  feedback?: boolean;
}

export function useSlice2Integration(input: {
  meta: Meta | null;
  hours: HoursPayload | null;
  mode: "day" | "week";
  anchor: string;
  planActive: boolean;
  stagedCount: number;
  overlayKind: string | null;
  openEventId: string | null;
  events: CalEvent[];
  onOpenFeedback: (ctx: FeedbackContext, shot: string | null) => void;
}) {
  const enabled = slice2Enabled(input.meta);
  const [trayMsg, setTrayMsg] = useState<TrayMsg | null>(null);
  const [outsideIds, setOutsideIds] = useState<Set<string>>(new Set());
  const hold = useRef<FeedbackHoldState>({ pointers: [], armed: false, startedAt: null });

  useEffect(() => {
    if (!enabled) return;
    void flushFeedbackQueue();
    const onVis = () => {
      if (document.visibilityState === "visible") void flushFeedbackQueue();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !input.hours) {
      setOutsideIds(new Set());
      return;
    }
    const next = new Set<string>();
    for (const event of input.events) {
      if (
        blockOutsideHours(
          input.hours,
          event.domain,
          PlanTime.weekdayIndex(event.dayKey),
          event.startHour,
          event.endHour,
        )
      ) {
        next.add(event.id);
      }
    }
    setOutsideIds(next);
  }, [enabled, input.hours, input.events]);

  const pushTray = useCallback((msg: TrayMsg) => {
    setTrayMsg(msg);
  }, []);

  const dragHeadsUp = useCallback(
    (domain: string, weekday: number, startHour: number, endHour: number) =>
      enabled ? headsUpForMove(input.hours, domain, weekday, startHour, endHour) : null,
    [enabled, input.hours],
  );

  const onRootPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || overlayKindIsBlocking(input.overlayKind)) return;
      const stamp = event.timeStamp > 0 ? event.timeStamp : Date.now();
      hold.current = feedbackHoldDown(hold.current, event.pointerId, event.clientX, event.clientY, stamp);
    },
    [enabled, input.overlayKind],
  );

  const onRootPointerMove = useCallback((event: React.PointerEvent) => {
    if (!enabled) return;
    hold.current = feedbackHoldMove(hold.current, event.pointerId, event.clientX, event.clientY);
    const stamp = event.timeStamp > 0 ? event.timeStamp : Date.now();
    if (feedbackHoldReady(hold.current, stamp)) {
      hold.current = { pointers: [], armed: false, startedAt: null };
      void openFeedbackCapture();
    }
  }, [enabled, input]);

  const onRootPointerUp = useCallback((event: React.PointerEvent) => {
    if (!enabled) return;
    hold.current = feedbackHoldUp(hold.current, event.pointerId);
  }, [enabled]);

  async function openFeedbackCapture() {
    const selected = input.openEventId
      ? input.events.find((row) => row.id === input.openEventId) ?? null
      : null;
    const ctx = buildContext({
      view: input.mode === "day" ? "Day" : "Week",
      sheet: input.overlayKind ?? "none",
      dateLabel: input.anchor,
      selectedTitle: selected?.title ?? null,
      selectedId: selected?.id ?? null,
      planMode: input.planActive,
      stagedCount: input.stagedCount,
      version: input.meta?.version,
    });
    const shotDefault = Boolean(input.meta?.features?.feedback_screenshot_default);
    const shot = await captureScreenshot(shotDefault);
    input.onOpenFeedback(ctx, shot);
  }

  const openFeedbackFromMenu = useCallback(() => {
    void openFeedbackCapture();
  }, [input]);

  async function submitFeedback(note: string, ctx: FeedbackContext, screenshot: string | null) {
    const result = await sendFeedback(note, ctx, screenshot);
    markFeedbackSentOnce();
    if (result.status === "sent" && result.issue_number) {
      pushTray({ message: `Feedback sent · #${result.issue_number}`, feedback: true });
      return;
    }
    if (result.status === "not_configured") {
      pushTray({ message: "Saved · GitHub not configured on server", feedback: true });
      return;
    }
    pushTray({ message: "Saved · sends when you're back online", feedback: true });
  }

  return {
    enabled,
    trayMsg,
    setTrayMsg,
    pushTray,
    outsideIds,
    dragHeadsUp,
    feedbackSubtitle: enabled && !feedbackSentOnce() ? "Or hold two fingers anywhere" : undefined,
    onRootPointerDown,
    onRootPointerMove,
    onRootPointerUp,
    openFeedbackFromMenu,
    submitFeedback,
  };
}

function overlayKindIsBlocking(kind: string | null): boolean {
  return kind === "feedback";
}
