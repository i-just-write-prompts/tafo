import { useEffect } from "react";
import { CheckGlyph } from "../v3/icons";

export interface TrayMessageProps {
  line1: string;
  line2?: string;
  undo?: (() => void) | null;
  feedback?: boolean;
  onDone: () => void;
  onLiftCollapse?: () => void;
}

const SHOW_MS = 4000;

export function TrayMessage(props: TrayMessageProps) {
  useEffect(() => {
    const timer = window.setTimeout(props.onDone, SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [props.line1, props.line2, props.onDone]);

  return (
    <div className={`tray-message${props.line2 ? " heads-up" : ""}`} data-testid="tray-message">
      <div className="tray-message-pill">
        {props.feedback ? <CheckGlyph /> : <i className="toast-dot ok" aria-hidden="true" />}
        <p>
          <span data-testid="tray-message-line1">{props.line1}</span>
          {props.line2 ? <span className="tray-heads-up" data-testid="tray-message-line2">{props.line2}</span> : null}
        </p>
        {props.undo ? (
          <button type="button" data-testid="tray-undo" onClick={() => { props.onLiftCollapse?.(); void props.undo?.(); }}>
            Undo
          </button>
        ) : null}
      </div>
    </div>
  );
}
