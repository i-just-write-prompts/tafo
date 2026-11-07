import { useState } from "react";
import { api } from "../api";

export function PairingPrompt({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="scrim">
      <form
        className="popover"
        data-testid="pairing-prompt"
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          setError(null);
          api("/api/ui/pair", { method: "POST", body: JSON.stringify({ code }) })
            .then(() => onPaired())
            .catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : "Could not pair");
              setPending(false);
            });
        }}
      >
        <h2>Pair this browser</h2>
        <p>Enter the pairing code printed in the server console when TAFO started.</p>
        <label>
          <span>Pairing code</span>
          <input
            data-testid="pairing-code"
            value={code}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={pending}>Pair</button>
      </form>
    </div>
  );
}
