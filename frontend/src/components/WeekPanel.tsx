import { useEffect, useState } from "react";
import { api, reportFailure } from "../api";
import type { WeekSummary } from "../types";

interface Props {
  week: WeekSummary | null;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
}

export function WeekPanel({ week, onRefresh, onError }: Props) {
  const [bullets, setBullets] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setBullets(week?.bullets ?? "");
  }, [week]);

  if (!week) {
    return <article className="card">Loading the week.</article>;
  }

  return (
    <form
      className="card form"
      onSubmit={(event) => {
        event.preventDefault();
        api("/api/week", {
          method: "PUT",
          body: JSON.stringify({ week_start: week.week_start, expected_version: week.version, bullets }),
        })
          .then(() => onRefresh())
          .catch((error: unknown) => { void reportFailure(error, onRefresh, onError); });
      }}
    >
      <h2>Week of {week.week_start}</h2>
      <p className="hint">Completed tasks in {week.timezone}, as bullets you can edit and copy. Saving keeps your wording.</p>
      <textarea data-testid="week-bullets" value={bullets} onChange={(event) => setBullets(event.target.value)} />
      <div className="actions">
        <button className="primary" type="submit">Save bullets</button>
        <button
          className="ghost"
          type="button"
          onClick={() => {
            api("/api/week/regenerate", {
              method: "POST",
              body: JSON.stringify({ week_start: week.week_start, expected_version: week.version }),
            })
              .then(() => onRefresh())
              .catch((error: unknown) => { void reportFailure(error, onRefresh, onError); });
          }}
        >
          Regenerate from completed tasks
        </button>
        <button
          className="ghost"
          type="button"
          data-testid="copy-bullets"
          onClick={() => {
            navigator.clipboard
              .writeText(bullets)
              .then(() => setCopied(true))
              .catch(() => onError("Clipboard was blocked. The bullets stay selected in the box so you can copy them."));
          }}
        >
          {copied ? "Copied" : "Copy bullets"}
        </button>
      </div>
    </form>
  );
}
