/**
 * CalendarClient is the only door to calendar reads and saves.
 *
 * Callers pass blocks, proposals, and ranges. They get typed results.
 * This file owns the URLs, the propose-then-approve sequence, version
 * numbers, idempotency keys, the actor header (via the shared api
 * transport), and the confirmation read with its retries.
 */
import { api } from "../api";
import type { CalendarBlock, OutboxOperation, Proposal } from "../types";

export interface CalendarRange {
  /** Inclusive window start, ISO-8601. */
  start: string;
  /** Exclusive window end, ISO-8601. */
  end: string;
}

/** The server lists every block. Pass this when the screen still shows the whole mirror. */
export const ENTIRE_CALENDAR: CalendarRange = {
  start: "0001-01-01T00:00:00.000Z",
  end: "9999-12-31T23:59:59.999Z",
};

export interface TimeSpan {
  start: string;
  end: string;
}

export interface CalendarSnapshot {
  blocks: CalendarBlock[];
  proposals: Proposal[];
}

export interface MoveRequest {
  kind: "block" | "proposal";
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  acknowledgeFixed?: boolean;
  block?: CalendarBlock;
  proposal?: Proposal;
}

export interface CalendarOutbox {
  id?: string;
  status?: string;
}

export interface MoveResult {
  outcome: "saved" | "not_synced";
  block: CalendarBlock | null;
  proposal: Proposal | null;
  idempotentReplay: boolean;
  outbox: CalendarOutbox | null;
}

export interface UndoRequest {
  kind: "block";
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  acknowledgeFixed?: boolean;
  /** Block returned by the move being undone. */
  block: CalendarBlock;
}

export interface PlanMoveInput {
  blockId: string;
  expectedVersion: number;
  startsAt: string;
  endsAt: string;
  idempotencyKey: string;
  title: string;
  acknowledgeFixedMove: boolean;
}

export interface PlanApprovalInput {
  proposalId: string;
  expectedVersion: number;
  startsAt?: string;
  endsAt?: string;
}

export interface PlanCommitItem {
  id: string;
  title: string;
  saved: boolean;
  outcome: "saved" | "not_synced";
  idempotentReplay: boolean;
  outbox: CalendarOutbox | null;
}

export interface RetryOutboxResult {
  operation: CalendarOutbox | null;
  block: CalendarBlock | null;
}

export interface PlanCommitResult {
  moves: PlanCommitItem[];
  approvals: PlanCommitItem[];
  /** False when every confirmation read failed. The write itself may still have landed. */
  confirmed: boolean;
}

export interface DecideResult {
  proposal: Proposal | null;
  block: CalendarBlock | null;
  outbox: CalendarOutbox | null;
  idempotentReplay: boolean;
}

export interface SuggestRequest {
  taskId?: string;
  durationMinutes?: number;
}

export interface SuggestedSlot {
  startsAt: string;
  endsAt: string;
  startsLocal: string;
  endsLocal: string;
  avoidedKnownConflicts: boolean;
  outlookGap: string;
}

export type SuggestResult =
  | { status: "open"; slot: SuggestedSlot }
  | { status: "blocked"; reason: "not_these" };

export interface CalendarClient {
  load(range: CalendarRange): Promise<CalendarSnapshot>;
  move(input: MoveRequest): Promise<MoveResult>;
  undo(input: UndoRequest): Promise<MoveResult>;
  commitPlan(input: { moves: PlanMoveInput[]; approvals: PlanApprovalInput[] }): Promise<PlanCommitResult>;
  decide(proposal: Proposal, action: "approve" | "deny"): Promise<DecideResult>;
  suggest(input: SuggestRequest, options: { notThese: TimeSpan[] }): Promise<SuggestResult>;
  retryOutbox(outboxId: string): Promise<RetryOutboxResult>;
  listOutbox(): Promise<OutboxOperation[]>;
  /** Opaque token stored on a staged move. The same target keeps `previous`. */
  saveKey(prefix: string, previous?: string, sameTarget?: boolean): string;
}

export interface CalendarTransport {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

export interface CalendarDeps {
  transport?: CalendarTransport;
  sleep?: (ms: number) => Promise<void>;
  mintKey?: (prefix: string) => string;
}

const CONFIRM_WAITS = [0, 200, 500];

interface WireDecision {
  proposal?: Proposal | null;
  outbox?: { status?: string } | null;
  block?: CalendarBlock | null;
  idempotent_replay?: boolean;
}

interface WireCommitItem {
  saved?: boolean;
  outcome?: string;
  item_id?: string;
  item_title?: string;
  idempotent_replay?: boolean;
  outbox?: { id?: string; status?: string } | null;
}

interface WireSuggestion {
  starts_at?: string;
  ends_at?: string;
  starts_local?: string;
  ends_local?: string;
  avoided_known_conflicts?: boolean;
  outlook_gap?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultMint(prefix: string): string {
  const raw = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const cleaned = raw.replace(/[^A-Za-z0-9_.:-]/g, "");
  return `${prefix}.${cleaned}`.slice(0, 120);
}

function overlaps(start: unknown, end: unknown, range: CalendarRange): boolean {
  if (typeof start !== "string" || typeof end !== "string") return true;
  const left = Date.parse(start);
  const right = Date.parse(end);
  const rangeStart = Date.parse(range.start);
  const rangeEnd = Date.parse(range.end);
  if (![left, right, rangeStart, rangeEnd].every(Number.isFinite)) return true;
  return left < rangeEnd && right > rangeStart;
}

function proposalTimes(proposal: Proposal): { start: unknown; end: unknown } {
  const payload = proposal.edited_payload ?? proposal.payload;
  return { start: payload.starts_at, end: payload.ends_at };
}

function payloadOf(proposal: Proposal): Record<string, unknown> {
  return { ...(proposal.edited_payload ?? proposal.payload) };
}

function fromDecision(body: WireDecision): MoveResult {
  const status = body.outbox?.status;
  const sync = body.block?.sync_state;
  const notSynced = sync === "not_synced" || (status != null && status !== "simulated" && status !== "synced");
  return {
    outcome: notSynced ? "not_synced" : "saved",
    block: body.block ?? null,
    proposal: body.proposal ?? null,
    idempotentReplay: Boolean(body.idempotent_replay),
    outbox: body.outbox ?? null,
  };
}

function fromCommitItem(raw: WireCommitItem): PlanCommitItem {
  const saved = raw.saved === true;
  return {
    id: raw.item_id ?? "",
    title: raw.item_title ?? "",
    saved,
    outcome: saved && raw.outcome !== "not_synced" ? "saved" : "not_synced",
    idempotentReplay: Boolean(raw.idempotent_replay),
    outbox: raw.outbox ?? null,
  };
}

export function createCalendarClient(deps: CalendarDeps = {}): CalendarClient {
  const transport = deps.transport ?? { request: api };
  const sleep = deps.sleep ?? defaultSleep;
  const mintKey = deps.mintKey ?? defaultMint;

  async function readSnapshot(range: CalendarRange): Promise<CalendarSnapshot> {
    const [blockBody, proposalBody] = await Promise.all([
      transport.request<{ blocks?: CalendarBlock[] } | null>("/api/calendar/blocks"),
      transport.request<{ proposals?: Proposal[] } | null>("/api/hermes/proposals"),
    ]);
    const blocks = blockBody?.blocks ?? [];
    const proposals = proposalBody?.proposals ?? [];
    return {
      blocks: blocks.filter((block) => overlaps(block.starts_at, block.ends_at, range)),
      proposals: proposals.filter((proposal) => {
        const times = proposalTimes(proposal);
        return overlaps(times.start, times.end, range);
      }),
    };
  }

  async function confirmRead(): Promise<boolean> {
    for (let attempt = 0; attempt < CONFIRM_WAITS.length; attempt += 1) {
      const wait = CONFIRM_WAITS[attempt] ?? 0;
      if (wait > 0) await sleep(wait);
      try {
        await readSnapshot(ENTIRE_CALENDAR);
        return true;
      } catch {
        if (attempt === CONFIRM_WAITS.length - 1) return false;
      }
    }
    return false;
  }

  async function proposeUpdate(block: CalendarBlock, input: MoveRequest, key: string): Promise<Proposal> {
    return transport.request<Proposal>("/api/hermes/proposals", {
      method: "POST",
      body: JSON.stringify({
        source: "plan",
        source_kind: "human",
        kind: "calendar_update",
        explanation: `Moved ${input.title}.`,
        idempotency_key: key,
        payload: {
          event_key: block.id,
          task_id: block.task_id,
          domain: block.domain,
          starts_at: input.startsAt,
          ends_at: input.endsAt,
          timezone: input.timeZone,
          allow_custom_title: true,
          title: input.title,
        },
      }),
    });
  }

  async function approveProposal(proposal: Proposal, acknowledgeFixed: boolean): Promise<MoveResult> {
    const body = await transport.request<WireDecision>(`/api/decisions/${proposal.id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: proposal.version,
        confirmed: true,
        acknowledge_fixed_move: acknowledgeFixed,
      }),
    });
    return fromDecision(body);
  }

  async function editProposal(proposal: Proposal, version: number, startsAt: string, endsAt: string): Promise<Proposal> {
    return transport.request<Proposal>(`/api/decisions/${proposal.id}/edit`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: version,
        confirmed: true,
        payload: { ...payloadOf(proposal), starts_at: startsAt, ends_at: endsAt },
      }),
    });
  }

  const client: CalendarClient = {
    load(range) {
      return readSnapshot(range);
    },

    async move(input) {
      if (input.kind === "proposal") {
        if (!input.proposal) throw new Error("A proposal move needs the proposal.");
        const edited = await editProposal(input.proposal, input.proposal.version, input.startsAt, input.endsAt);
        return approveProposal(edited, input.acknowledgeFixed === true);
      }
      if (!input.block) throw new Error("A block move needs the block.");
      const proposal = await proposeUpdate(input.block, input, mintKey("move"));
      return approveProposal(proposal, input.acknowledgeFixed === true);
    },

    async undo(input) {
      return client.move({
        kind: "block",
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timeZone: input.timeZone,
        acknowledgeFixed: input.acknowledgeFixed,
        block: input.block,
      });
    },

    async commitPlan(input) {
      const body = await transport.request<{ moves?: WireCommitItem[]; approvals?: WireCommitItem[] }>(
        "/api/decisions/plan/commit",
        {
          method: "POST",
          body: JSON.stringify({
            confirmed: true,
            moves: input.moves.map((move) => ({
              block_id: move.blockId,
              expected_version: move.expectedVersion,
              starts_at: move.startsAt,
              ends_at: move.endsAt,
              idempotency_key: move.idempotencyKey,
              title: move.title,
              acknowledge_fixed_move: move.acknowledgeFixedMove,
            })),
            approvals: input.approvals.map((approval) => {
              const row: Record<string, unknown> = {
                proposal_id: approval.proposalId,
                expected_version: approval.expectedVersion,
              };
              if (approval.startsAt && approval.endsAt) {
                row.starts_at = approval.startsAt;
                row.ends_at = approval.endsAt;
              }
              return row;
            }),
          }),
        },
      );
      const confirmed = await confirmRead();
      return {
        moves: (body?.moves ?? []).map(fromCommitItem),
        approvals: (body?.approvals ?? []).map(fromCommitItem),
        confirmed,
      };
    },

    async decide(proposal, action) {
      if (action === "deny") {
        const denied = await transport.request<Proposal>(`/api/decisions/${proposal.id}/reject`, {
          method: "POST",
          body: JSON.stringify({
            expected_version: proposal.version,
            confirmed: true,
            note: "Denied",
          }),
        });
        return { proposal: denied, block: null, outbox: null, idempotentReplay: false };
      }
      const approved = await approveProposal(proposal, false);
      return {
        proposal: approved.proposal,
        block: approved.block,
        outbox: approved.outbox,
        idempotentReplay: approved.idempotentReplay,
      };
    },

    async retryOutbox(outboxId) {
      const body = await transport.request<{ operation?: CalendarOutbox | null; block?: CalendarBlock | null }>(
        `/api/calendar/outbox/${outboxId}/retry`,
        { method: "POST" },
      );
      return { operation: body?.operation ?? null, block: body?.block ?? null };
    },

    async listOutbox() {
      const body = await transport.request<{ operations?: OutboxOperation[] } | null>("/api/calendar/outbox");
      return body?.operations ?? [];
    },

    async suggest(input, options) {
      const params = new URLSearchParams();
      if (input.taskId) params.set("task_id", input.taskId);
      if (input.durationMinutes != null) params.set("duration_minutes", String(input.durationMinutes));
      const query = params.toString();
      const path = query ? `/api/calendar/suggestion?${query}` : "/api/calendar/suggestion";
      const body = await transport.request<WireSuggestion>(path);
      const slot: SuggestedSlot = {
        startsAt: body?.starts_at ?? "",
        endsAt: body?.ends_at ?? "",
        startsLocal: body?.starts_local ?? "",
        endsLocal: body?.ends_local ?? "",
        avoidedKnownConflicts: Boolean(body?.avoided_known_conflicts),
        outlookGap: body?.outlook_gap ?? "",
      };
      const blocked = options.notThese.some((span) => overlaps(slot.startsAt, slot.endsAt, { start: span.start, end: span.end }));
      if (blocked) return { status: "blocked", reason: "not_these" };
      return { status: "open", slot };
    },

    saveKey(prefix, previous, sameTarget = false) {
      if (sameTarget && previous) return previous;
      return mintKey(prefix);
    },
  };

  return client;
}

export const calendar = createCalendarClient();
