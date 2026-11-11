interface Props {
  label: string;
  pending: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteControl({ label, pending, onAsk, onCancel, onConfirm }: Props) {
  if (!pending) {
    return (
      <button type="button" className="tiny danger" aria-label={`Delete ${label}`} onClick={onAsk}>
        Delete
      </button>
    );
  }
  return (
    <span className="confirm-delete" role="group" aria-label={`Confirm delete ${label}`}>
      <span>Delete {label}?</span>
      <button type="button" className="tiny danger" aria-label={`Confirm delete ${label}`} onClick={onConfirm}>
        Delete
      </button>
      <button type="button" className="tiny" aria-label={`Keep ${label}`} onClick={onCancel}>
        Keep
      </button>
    </span>
  );
}
