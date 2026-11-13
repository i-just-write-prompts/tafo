import { CheckGlyph, InfoGlyph } from "../v3/icons";

export function toastKind(message: string): "info" | "plain" | "ok" {
  if (
    message.includes("still in plan")
    || message.includes(" changed")
    || message.includes("didn't move")
    || message.includes("not on calendar")
  ) return "info";
  if (message.startsWith("Reverted") || message.startsWith("Denied")) return "plain";
  return "ok";
}

export function TrayToastIcon({ message }: { message: string }) {
  const kind = toastKind(message);
  return (
    <span className={kind === "ok" ? "toast-icon" : `toast-icon ${kind}`} data-icon={kind} aria-hidden="true">
      {kind === "info" ? <InfoGlyph /> : <CheckGlyph />}
    </span>
  );
}

const STATUS_TAILS = [" still in plan", " not on calendar", " changed"];

function toastParts(message: string): { count: string; name: string; keep: string } | null {
  if (message.includes("changed, so nothing was saved")) return null;
  const tail = STATUS_TAILS.find((item) => message.endsWith(item));
  if (!tail) return null;
  const head = message.slice(0, -tail.length);
  const dot = head.lastIndexOf(" · ");
  if (dot < 0) return { count: "", name: head.trim(), keep: tail };
  const left = head.slice(0, dot).trim();
  const right = head.slice(dot + 3).trim();
  if (!right) return { count: "", name: left, keep: ` ·${tail}` };
  return { count: `${left} · `, name: right, keep: tail };
}

export function TrayToastCopy({ message, line2 }: { message: string; line2?: string }) {
  const parts = toastParts(message);
  if (line2) {
    return (
      <p>
        <span data-testid="tray-message-line1">{message}</span>
        <span className="tray-heads-up" data-testid="tray-message-line2">{line2}</span>
      </p>
    );
  }
  if (!parts) return <p><span data-testid="tray-message-line1">{message}</span></p>;
  return (
    <p className="partial-line">
      {parts.count ? <span className="partial-count">{parts.count}</span> : null}
      {parts.name ? <span className="partial-name">{parts.name}</span> : null}
      <span className="partial-keep" data-testid="toast-keep">{parts.keep}</span>
    </p>
  );
}
