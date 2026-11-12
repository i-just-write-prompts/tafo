import { useCallback, useEffect, useState } from "react";
import { OFFLINE_MESSAGE, api } from "./api";
import { ENTIRE_CALENDAR, calendar } from "./calendar/client";
import { CalendarShell } from "./v3/Shell";
import type { CalendarBlock, Meta, OutboxOperation, Proposal, Task } from "./types";

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [blocks, setBlocks] = useState<CalendarBlock[]>([]);
  const [outbox, setOutbox] = useState<OutboxOperation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [nextMeta, taskBody, snapshot, outboxBody] = await Promise.all([
        api<Meta>("/api/meta"),
        api<{ tasks: Task[] }>("/api/tasks?view=all&scope=all"),
        calendar.load(ENTIRE_CALENDAR),
        calendar.listOutbox(),
      ]);
      setMeta(nextMeta);
      setTasks(taskBody.tasks);
      setProposals(snapshot.proposals);
      setBlocks(snapshot.blocks);
      setOutbox(outboxBody);
      setError(null);
      setLoading(false);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not load TAFO";
      setError(message === OFFLINE_MESSAGE ? OFFLINE_MESSAGE : message);
      setLoading(false);
      throw reason;
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh().catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <CalendarShell
      meta={meta}
      tasks={tasks}
      blocks={blocks}
      proposals={proposals}
      outbox={outbox}
      loading={loading && !meta}
      error={error}
      onRefresh={refresh}
    />
  );
}
