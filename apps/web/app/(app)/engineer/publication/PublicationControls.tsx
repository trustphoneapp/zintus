"use client";

import type { EngineerBudgetSnapshot } from "@/lib/engineer";
import type { EngineerPublication, PublicationCandidate, PublicationState } from "@/lib/engineer-resolution";
import { RunBudgetSpendSummary } from "../resolution/ResolutionDeskControls";
import { ActionErrorNotice, type ActionErrorDetail } from "../EngineerActionErrorNotice";

/** Kept as an alias so existing imports of this screen's original names keep working. */
export type PublicationErrorDetail = ActionErrorDetail;
export const PublicationErrorNotice = ActionErrorNotice;

export function LineageBadge({ candidate }: { candidate: PublicationCandidate }) {
  const label = candidate.lineage === "ORIGINAL" ? "Original" : "P7 replacement";
  return (
    <span className={`engineer-chip engineer-publication-lineage engineer-publication-lineage--${candidate.lineageVerified ? "verified" : "unverified"}`}>
      {label} · {candidate.lineageVerified ? "Verified" : "Unverified lineage"}
    </span>
  );
}

export function PublicationCandidateList({ candidates, selectedCheckpointId, onSelect }: {
  candidates: PublicationCandidate[];
  selectedCheckpointId: string | null;
  onSelect: (candidate: PublicationCandidate) => void;
}) {
  if (!candidates.length) return <p className="engineer-muted">No eligible publication candidates for this run.</p>;
  return (
    <div className="engineer-list" role="list" aria-label="Publication candidates">
      {candidates.map((candidate) => (
        <button
          type="button"
          key={candidate.checkpointId}
          role="listitem"
          aria-pressed={selectedCheckpointId === candidate.checkpointId}
          className={selectedCheckpointId === candidate.checkpointId ? "selected" : undefined}
          onClick={() => onSelect(candidate)}
        >
          <LineageBadge candidate={candidate} />
          <div><strong>{candidate.checkpointId}</strong><code>{candidate.checkpointHash}</code></div>
        </button>
      ))}
    </div>
  );
}

export function SELF_APPROVAL_ERROR(): PublicationErrorDetail {
  return {
    message: "You cannot approve your own request.",
    cause: "The server derived the same identity for both the requester and the approver.",
    nextAction: "Ask a different authorized approver to review this candidate.",
    spent: "Nothing — no publish attempt occurred.",
    code: "SELF_APPROVAL",
  };
}

export function PREFLIGHT_MISMATCH_ERROR(): PublicationErrorDetail {
  return {
    message: "The branch or base moved since this candidate was approved.",
    cause: "Preflight re-validates branch/base/repository immediately before any Git effect, and it no longer matches.",
    nextAction: "The approval was invalidated automatically. Get the candidate re-approved on its current base before retrying.",
    spent: "Nothing — preflight is checked before any Git effect, so no remote change was made.",
    code: "PREFLIGHT_MISMATCH",
  };
}

export function ApprovalRationaleControls({ pendingAction, disabled, rationale, onRationaleChange, selfApprovalError, onApprove, onReject }: {
  pendingAction: string | null;
  disabled: boolean;
  rationale: string;
  onRationaleChange: (value: string) => void;
  selfApprovalError: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <>
      <label>Rationale
        <textarea value={rationale} onChange={(event) => onRationaleChange(event.target.value)} rows={3} disabled={disabled} placeholder="Why this candidate is (or is not) safe to publish" />
      </label>
      {selfApprovalError ? <PublicationErrorNotice {...SELF_APPROVAL_ERROR()} /> : null}
      <div className="engineer-actions">
        <button type="button" className="engineer-primary" disabled={disabled} onClick={onApprove}>{pendingAction === "approval:approve" ? "Approving…" : "Approve"}</button>
        <button type="button" className="danger" disabled={disabled} onClick={onReject}>{pendingAction === "approval:reject" ? "Rejecting…" : "Reject"}</button>
      </div>
    </>
  );
}

const TIMELINE_STAGES: PublicationState[] = ["PREFLIGHT", "DISPATCHED", "RECEIPTED"];
const STAGE_LABEL: Record<PublicationState, string> = {
  PREFLIGHT: "Preflight",
  DISPATCHED: "Dispatched",
  RECEIPTED: "Receipted",
  RECONCILING: "Reconciling",
  FAILED: "Failed",
};

/**
 * Real discrete stages only — never a synthetic percentage. RECONCILING and
 * FAILED are rendered as their own explanatory sections (not a step on the
 * happy-path line) because neither is a point on a linear progress bar: a
 * publication reaches RECONCILING when its remote outcome is unknown, and
 * FAILED is a terminal outcome independent of how far the linear path got.
 */
export function PublicationStateTimeline({ state, receipt, reconciliation, budget }: {
  state: PublicationState;
  receipt?: EngineerPublication["receipt"];
  reconciliation?: EngineerPublication["reconciliation"];
  budget?: EngineerBudgetSnapshot | null;
}) {
  if (state === "RECONCILING") {
    return (
      <section className="engineer-card engineer-gate" role="status" aria-live="polite" aria-labelledby="publication-reconciling-heading">
        <div>
          <span className="engineer-kicker">Publication</span>
          <h2 id="publication-reconciling-heading">Reconciling — remote outcome unknown</h2>
          <p>
            Zintus does not know whether this publish operation completed on the remote repository — a branch, commit, or
            pull request may or may not exist there, and any provider spend tied to this run may still be uncertain.
            Zintus will not automatically retry the publish: retrying an operation with an unknown outcome could create a
            duplicate. A human must check the repository directly before taking any further publish action.
          </p>
          {reconciliation ? <p><code>{reconciliation.reason}</code> · observed remote state <code>{reconciliation.observedRemoteState}</code></p> : null}
        </div>
        {budget ? <RunBudgetSpendSummary budget={budget} /> : null}
      </section>
    );
  }

  if (state === "FAILED") {
    return (
      <PublicationErrorNotice
        message="Publication failed."
        cause="The publish operation did not complete successfully."
        nextAction="Review the run's evidence, then get a fresh approval and retry publication."
        spent="Unknown from this screen alone. If this publication ever reached DISPATCHED, check the repository directly before retrying."
      />
    );
  }

  return (
    <section className="engineer-card" aria-labelledby="publication-timeline-heading">
      <span className="engineer-kicker">Publication</span>
      <h2 id="publication-timeline-heading">Progress</h2>
      <ol className="engineer-publication-timeline" aria-label="Publication progress">
        {TIMELINE_STAGES.map((stage, index) => {
          const currentIndex = TIMELINE_STAGES.indexOf(state);
          const status = index < currentIndex ? "complete" : index === currentIndex ? "current" : "pending";
          return <li key={stage} data-status={status} aria-current={status === "current" ? "step" : undefined}>{STAGE_LABEL[stage]}</li>;
        })}
      </ol>
      {state === "RECEIPTED" && receipt ? <p><a href={receipt.prUrl} target="_blank" rel="noreferrer">{receipt.prUrl}</a> · <code>{receipt.commitSha}</code></p> : null}
    </section>
  );
}

export function PublicationEmptyState() {
  return <section className="engineer-card"><p className="engineer-muted">No eligible publication candidates for this run yet.</p></section>;
}

export function PublicationErrorState({ message }: { message: string }) {
  return <section className="engineer-card"><p className="engineer-error" role="alert">{message}</p></section>;
}
