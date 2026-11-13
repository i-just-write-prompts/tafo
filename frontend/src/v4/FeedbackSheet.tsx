import { useEffect, useRef, useState } from "react";
import type { FeedbackContext } from "./feedbackCapture";
import { contextLine } from "./feedbackCapture";

export function FeedbackSheet(props: {
  context: FeedbackContext;
  screenshot: string | null;
  screenshotDefault: boolean;
  onCancel: () => void;
  onSend: (note: string, screenshot: string | null) => void;
}) {
  const [note, setNote] = useState("");
  const [shot, setShot] = useState<string | null>(props.screenshotDefault ? props.screenshot : null);
  const [discardAsk, setDiscardAsk] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const close = () => {
    if (!note.trim()) {
      props.onCancel();
      return;
    }
    setDiscardAsk(true);
  };

  return (
    <div className="sheet feedback-sheet" role="dialog" aria-label="Send feedback" data-testid="feedback-sheet">
      <div className="sheet-grip" />
      <div className="feedback-top">
        <button type="button" className="quiet" data-testid="feedback-cancel" onClick={close}>Cancel</button>
        <strong>Send feedback</strong>
        <button
          type="button"
          className="quiet"
          data-testid="feedback-send"
          disabled={!note.trim()}
          onClick={() => props.onSend(note, shot)}
        >
          Send
        </button>
      </div>
      <p className="sub feedback-context" data-testid="feedback-context">{contextLine(props.context)}</p>
      <div className="feedback-shot-row">
        {shot ? (
          <>
            <img src={shot} alt="Screenshot preview" className="feedback-thumb" data-testid="feedback-thumb" />
            <button type="button" className="quiet" data-testid="feedback-remove-shot" aria-label="Remove screenshot" onClick={() => setShot(null)}>×</button>
          </>
        ) : (
          <button type="button" className="quiet" data-testid="feedback-add-shot" onClick={() => setShot(props.screenshot)}>
            Add screenshot
          </button>
        )}
      </div>
      <label className="feedback-field-label">What happened?</label>
      <textarea
        ref={field}
        className="feedback-field"
        data-testid="feedback-note"
        aria-label="What happened?"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={4}
      />
      <p className="why">Goes to the team with this screen and build.</p>
      {discardAsk ? (
        <div className="sheet discard-sheet" role="dialog" aria-label="Discard note?">
          <p>Discard note?</p>
          <div className="pair">
            <button type="button" className="no" data-testid="feedback-discard" onClick={props.onCancel}>Discard</button>
            <button type="button" className="yes" data-testid="feedback-keep-writing" onClick={() => setDiscardAsk(false)}>Keep writing</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
