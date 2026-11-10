/** Plan mode keeps moves on the device until Approve all or Revert. */

export interface Span {
  start: string;
  end: string;
}

export interface StagedMove {
  id: string;
  kind: "block" | "proposal";
  from: Span;
  to: Span;
  fromDayKey: string;
  dayKey: string;
}

export interface PlanSession {
  active: boolean;
  moves: StagedMove[];
  skipped: string[];
}

export function initialPlan(): PlanSession {
  return { active: false, moves: [], skipped: [] };
}

export function enterPlan(): PlanSession {
  return { active: true, moves: [], skipped: [] };
}

export function exitPlan(): PlanSession {
  return initialPlan();
}

export function stageMove(session: PlanSession, move: StagedMove): PlanSession {
  const same = session.moves.find((item) => item.id === move.id);
  const unchanged = move.from.start === move.to.start && move.from.end === move.to.end && move.fromDayKey === move.dayKey;
  const moves = session.moves.filter((item) => item.id !== move.id);
  if (!unchanged) moves.push(same ? { ...move } : move);
  return { ...session, moves };
}

export function toggleSkip(session: PlanSession, proposalId: string): PlanSession {
  const skipped = session.skipped.includes(proposalId)
    ? session.skipped.filter((id) => id !== proposalId)
    : [...session.skipped, proposalId];
  return { ...session, skipped };
}

export function revertMoves(session: PlanSession): PlanSession {
  return { ...session, moves: [] };
}

export function includedIds(proposalIds: string[], skipped: string[]): string[] {
  const skip = new Set(skipped);
  return proposalIds.filter((id) => !skip.has(id));
}

export function approveDisabled(moves: number, included: number): boolean {
  return moves === 0 && included === 0;
}

export function proposalsOnDays<T extends { id: string; dayKey: string; state: string }>(
  events: T[],
  dayKeys: string[],
): T[] {
  const wanted = new Set(dayKeys);
  return events.filter((event) => event.state === "proposed" && wanted.has(event.dayKey));
}
