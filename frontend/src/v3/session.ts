/** Plan mode keeps moves on the device until Approve all or Revert. */

export interface Span {
  start: string;
  end: string;
}

export interface StagedMove {
  id: string;
  kind: "block" | "proposal";
  title: string;
  version: number;
  key: string;
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
  const kept: StagedMove = same
    ? {
        ...move,
        title: same.title || move.title,
        version: same.version,
        from: same.from,
        fromDayKey: same.fromDayKey,
        key: same.to.start === move.to.start && same.to.end === move.to.end ? same.key : move.key,
      }
    : move;
  const unchanged = kept.from.start === kept.to.start && kept.from.end === kept.to.end && kept.fromDayKey === kept.dayKey;
  const moves = session.moves.filter((item) => item.id !== move.id);
  if (!unchanged) moves.push(kept);
  return { ...session, moves };
}

export function retainMoves(session: PlanSession, ids: string[]): PlanSession {
  const keep = new Set(ids);
  const moves = session.moves.filter((move) => keep.has(move.id));
  if (moves.length === 0) return initialPlan();
  return { active: true, moves, skipped: session.skipped.filter((id) => keep.has(id)) };
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

const PLAN_KEY = "tafo.v3.plan.v2";
const PLAN_KEY_V1 = "tafo.v3.plan";

function storedMove(value: unknown): StagedMove | null {
  if (!value || typeof value !== "object") return null;
  const move = value as Partial<StagedMove>;
  if (typeof move.id !== "string" || (move.kind !== "block" && move.kind !== "proposal")) return null;
  if (typeof move.title !== "string" || typeof move.version !== "number" || typeof move.key !== "string") return null;
  if (!move.from || !move.to || typeof move.fromDayKey !== "string" || typeof move.dayKey !== "string") return null;
  return move as StagedMove;
}

export function loadPlan(): PlanSession {
  try {
    globalThis.localStorage?.removeItem(PLAN_KEY_V1);
    const raw = globalThis.localStorage?.getItem(PLAN_KEY);
    if (!raw) return initialPlan();
    const parsed = JSON.parse(raw) as Partial<PlanSession>;
    if (!parsed || !Array.isArray(parsed.moves)) return initialPlan();
    const moves = parsed.moves.map(storedMove).filter((move): move is StagedMove => move !== null);
    if (moves.length === 0) return initialPlan();
    return {
      active: Boolean(parsed.active),
      moves,
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped.filter((id) => typeof id === "string") : [],
    };
  } catch {
    return initialPlan();
  }
}

export function savePlan(session: PlanSession): void {
  try {
    if (!session.active && session.moves.length === 0) {
      globalThis.localStorage?.removeItem(PLAN_KEY);
      globalThis.localStorage?.removeItem(PLAN_KEY_V1);
      return;
    }
    globalThis.localStorage?.setItem(PLAN_KEY, JSON.stringify(session));
  } catch {
    /* Private mode can refuse the write. The in-memory session still works. */
  }
}

/** A proposal Mike has already moved is his decision, not a second suggestion. */
export function pendingProposalIds(proposalIds: string[], moves: { id: string }[]): string[] {
  const moved = new Set(moves.map((move) => move.id));
  return proposalIds.filter((id) => !moved.has(id));
}

export function includedIds(proposalIds: string[], skipped: string[]): string[] {
  const skip = new Set(skipped);
  return proposalIds.filter((id) => !skip.has(id));
}

export function approveDisabled(moves: number, included: number): boolean {
  return moves === 0 && included === 0;
}

export function sameInstant(left: string, right: string): boolean {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && a === b;
}

export interface PlanSaveSplit {
  savedMoveIds: string[];
  savedProposalIds: string[];
  unsavedMoveIds: string[];
}

/** Splits a plan by what a follow-up read actually shows as saved. */
export function splitPlanSave(
  moves: Array<{ id: string; kind: "block" | "proposal"; to: Span }>,
  extraProposalIds: string[],
  blocks: Array<{ id: string; starts_at: string; ends_at: string }>,
  proposals: Array<{ id: string; status: string; starts_at?: string; ends_at?: string }>,
): PlanSaveSplit {
  const savedMoveIds: string[] = [];
  const unsavedMoveIds: string[] = [];
  for (const move of moves) {
    if (move.kind === "block") {
      const block = blocks.find((item) => item.id === move.id);
      if (block && sameInstant(block.starts_at, move.to.start) && sameInstant(block.ends_at, move.to.end)) savedMoveIds.push(move.id);
      else unsavedMoveIds.push(move.id);
      continue;
    }
    const proposal = proposals.find((item) => item.id === move.id);
    if (
      proposal?.status === "approved"
      && proposal.starts_at
      && proposal.ends_at
      && sameInstant(proposal.starts_at, move.to.start)
      && sameInstant(proposal.ends_at, move.to.end)
    ) savedMoveIds.push(move.id);
    else unsavedMoveIds.push(move.id);
  }
  const moved = new Set(moves.map((move) => move.id));
  const savedProposalIds = extraProposalIds.filter((id) => !moved.has(id) && proposals.some((item) => item.id === id && item.status === "approved"));
  return { savedMoveIds, savedProposalIds, unsavedMoveIds };
}

export function conflictingMoveIds(
  moves: Array<Pick<StagedMove, "id" | "kind" | "version" | "from" | "to">>,
  blocks: Array<{ id: string; version: number; starts_at: string; ends_at: string }>,
  proposals: Array<{ id: string; version: number; status: string; starts_at?: string; ends_at?: string }>,
): string[] {
  return moves.filter((move) => {
    if (move.kind === "block") {
      const block = blocks.find((item) => item.id === move.id);
      if (!block || block.version !== move.version) return true;
      return !sameInstant(block.starts_at, move.from.start) || !sameInstant(block.ends_at, move.from.end);
    }
    const proposal = proposals.find((item) => item.id === move.id);
    if (!proposal) return true;
    if (proposal.status === "approved") {
      if (!proposal.starts_at || !proposal.ends_at) return true;
      return !sameInstant(proposal.starts_at, move.to.start) || !sameInstant(proposal.ends_at, move.to.end);
    }
    if (proposal.status !== "pending" || proposal.version !== move.version) return true;
    if (!proposal.starts_at || !proposal.ends_at) return true;
    return !sameInstant(proposal.starts_at, move.from.start) || !sameInstant(proposal.ends_at, move.from.end);
  }).map((move) => move.id);
}

export function clearPlanStorage(): void {
  try {
    globalThis.localStorage?.removeItem(PLAN_KEY);
    globalThis.localStorage?.removeItem(PLAN_KEY_V1);
  } catch {
    /* Private mode can refuse the write. */
  }
}

export function proposalsOnDays<T extends { id: string; dayKey: string; state: string }>(
  events: T[],
  dayKeys: string[],
): T[] {
  const wanted = new Set(dayKeys);
  return events.filter((event) => event.state === "proposed" && wanted.has(event.dayKey));
}
