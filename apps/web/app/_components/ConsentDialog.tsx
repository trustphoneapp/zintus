"use client";

import { useId, useRef } from "react";
import { DATA_FLOW } from "@/lib/consent";
import { useFocusTrap } from "@/app/_components/useFocusTrap";

/**
 * Shared pre-send consent dialog (Apple 5.1.2(i) / good practice). Every surface
 * that sends prompts/files to a provider — chat, compare, research, terminal —
 * gates the first send through this so the data-destination disclosure can't be
 * silently skipped on a secondary screen.
 *
 * a11y: labelled by its title, Escape cancels, focus is trapped inside and
 * restored to the trigger on close (see useFocusTrap).
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
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  // Escape cancels — same as Cancel / backdrop, so consent is never granted by
  // dismissal.
  useFocusTrap(open, cardRef, onCancel);
  if (!open) return null;
  return (
    <div className="consent-backdrop" onClick={onCancel}>
      <div
        ref={cardRef}
        className="consent-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="consent-title" id={titleId}>
          Before your first send
        </h2>
        <p className="consent-body" id={bodyId}>
          Your message goes to the AI provider you choose, routed through your
          own gateway. Here&apos;s exactly where data travels:
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
          <button
            type="button"
            className="chat-tool-toggle"
            data-autofocus
            onClick={onGrant}
          >
            Got it — send
          </button>
        </div>
      </div>
    </div>
  );
}
