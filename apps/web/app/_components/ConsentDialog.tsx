"use client";

import { DATA_FLOW } from "@/lib/consent";

/**
 * Shared pre-send consent dialog (Apple 5.1.2(i) / good practice). Every surface
 * that sends prompts/files to a provider — chat, compare, research, terminal —
 * gates the first send through this so the data-destination disclosure can't be
 * silently skipped on a secondary screen.
 */
export function ConsentDialog({
  open,
  onCancel,
  onGrant,
}: {
  open: boolean;
  onCancel: () => void;
  onGrant: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="consent-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div className="consent-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="consent-title">Before your first send</h2>
        <p className="consent-body">
          Your message goes to the AI provider you choose, routed through your own
          gateway. Here&apos;s exactly where data travels:
        </p>
        <div className="consent-flow">
          {DATA_FLOW.map((item) => (
            <div key={item.data} className="consent-flow-item">
              <span className="consent-flow-dest">{item.dest}</span>
              <span className="consent-flow-data">{item.data}</span>
              <span className="consent-flow-detail">{item.detail}</span>
            </div>
          ))}
        </div>
        <div className="consent-actions">
          <button type="button" className="chat-tool-toggle" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="chat-tool-toggle" onClick={onGrant}>
            Got it — send
          </button>
        </div>
      </div>
    </div>
  );
}
