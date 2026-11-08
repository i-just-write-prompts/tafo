import { PlanConfig } from "./sync";
import type { Meta } from "../types";

export function SettingsStub({ meta, onClose }: { meta: Meta; onClose: () => void }) {
  const own = PlanConfig.autoApprove(meta.human_edits_auto_approve);
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        className="popover settings-stub"
        role="dialog"
        aria-labelledby="settings-title"
        data-testid="settings-stub"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="settings-title">Settings</h2>
        <ul className="settings-list">
          <li>{own ? "My own edits: approved right away" : "My own edits: wait for my approval"}</li>
          <li>Agent changes: need my approval</li>
          <li>Coming week: approval required</li>
          <li>Work↔home crossing: approval required</li>
        </ul>
        <p className="hint">Shown here for now. Editing these comes later.</p>
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
