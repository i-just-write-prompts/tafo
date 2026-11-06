import { useState } from "react";
import { api, formatWhen, payloadOf } from "../api";
import type { Meta, Proposal } from "../types";

interface Props {
  proposals: Proposal[];
  meta: Meta;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  onApproved: () => void;
}

export function Inbox({ proposals, meta, onRefresh, onError, onApproved }: Props) {
  const [acks, setAcks] = useState<Record<string, boolean>>({});

  async function run(action: () => Promise<void>, after?: () => void) {
    try {
      await action();
      await onRefresh();
      after?.();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Something went wrong");
    }
  }

  const pending = proposals.filter((item) => item.status === "pending");
  return (
    <div className="stack">
      <p className="hint">Agents can only leave proposals here. Approving is a human decision, and it is the only way a calendar block is queued.</p>
      {pending.length === 0 && <article className="card">The inbox is clear.</article>}
      {pending.map((proposal) => {
        const payload = payloadOf(proposal);
        const touches = Boolean(payload.touches_fixed);
        return (
          <article key={proposal.id} className="slip" data-testid="proposal-card">
            <div className="row">
              <span className="badge">{proposal.kind.replaceAll("_", " ")}</span>
              <span className="hint">{proposal.source}</span>
            </div>
            <h2>{proposal.explanation}</h2>
            <p className="meta">
              {typeof payload.title === "string" && <span>{payload.title}</span>}
              {typeof payload.starts_at === "string" && <span>{formatWhen(payload.starts_at, meta.display_timezone)}</span>}
              {typeof payload.ends_at === "string" && <span>to {formatWhen(payload.ends_at, meta.display_timezone)}</span>}
            </p>
            {proposal.availability && (
              <p className="hint">
                Known busy items: {proposal.availability.external_busy.length}. Mirrored copies hidden: {proposal.availability.suppressed_mirrors.length}.
                {proposal.availability.read_error ? ` Busy read failed: ${proposal.availability.read_error}` : ""}
              </p>
            )}
            {touches && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={Boolean(acks[proposal.id])}
                  onChange={(event) => setAcks({ ...acks, [proposal.id]: event.target.checked })}
                />
                I mean to change this fixed appointment
              </label>
            )}
            <div className="actions">
              <button
                className="primary"
                type="button"
                onClick={() =>
                  void run(
                    () =>
                      api(`/api/decisions/${proposal.id}/approve`, {
                        method: "POST",
                        body: JSON.stringify({
                          expected_version: proposal.version,
                          confirmed: true,
                          acknowledge_fixed_move: Boolean(acks[proposal.id]),
                        }),
                      }).then(() => undefined),
                    proposal.kind.startsWith("calendar") ? onApproved : undefined,
                  )
                }
              >
                Approve
              </button>
              <button
                className="ghost"
                type="button"
                onClick={() =>
                  void run(() =>
                    api(`/api/decisions/${proposal.id}/reject`, {
                      method: "POST",
                      body: JSON.stringify({ expected_version: proposal.version, confirmed: true, note: "Not now" }),
                    }).then(() => undefined),
                  )
                }
              >
                Reject
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
