import { useEffect } from "react";
import { TrayToastCopy, TrayToastIcon } from "./trayToastParts";

export interface TrayMessageProps {
  message: string;
  line2?: string;
  undo?: (() => Promise<void>) | null;
  retry?: (() => Promise<void>) | null;
  onDone: () => void;
}

const SHOW_MS = 4000;

export function TrayMessage(props: TrayMessageProps) {
  useEffect(() => {
    const timer = window.setTimeout(props.onDone, SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [props.message, props.line2, props.onDone]);

  return (
    <div
      className={`toast${props.line2 ? " tray-heads-up-toast" : ""}`}
      data-testid="plan-toast"
      role="status"
    >
      <TrayToastIcon message={props.message} />
      <TrayToastCopy message={props.message} line2={props.line2} />
      {props.undo ? (
        <button
          type="button"
          onClick={() => {
            props.onDone();
            void props.undo?.();
          }}
        >
          Undo
        </button>
      ) : null}
      {props.retry ? (
        <button
          type="button"
          onClick={() => {
            void props.retry?.();
          }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
