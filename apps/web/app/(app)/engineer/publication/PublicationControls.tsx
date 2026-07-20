"use client";

import { useState } from "react";
import type { EngineerBudgetSnapshot } from "@/lib/engineer";
import { ResolutionApiError } from "@/lib/engineer-resolution";
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

// ---------------------------------------------------------------------------
// R7-3 (finding #4) — RECONCILING operator controls (control-logic seam)
// ---------------------------------------------------------------------------

/** The honest headline for the R7-1 server binding rejection (surfaced verbatim). */
export const RECONCILIATION_BINDING_REJECTED =
  "The receipt does not match this publication's verified candidate, or no open-draft pull request could be confirmed.";

/** A commitSha is only submittable when it is a 40- or 64-char hex digest. */
const COMMIT_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/**
 * Client-side PRE-gate for the VERIFIED RECEIPT form: both fields present and the
 * commitSha well-shaped. This NEVER substitutes for the server binding check
 * (R7-1) — it only avoids a submit the server would reject on shape alone. A
 * well-shaped-but-unbound receipt still round-trips to the server and is rejected
 * there (surfaced by `reconciliationErrorDetail`).
 */
export function canSubmitVerifiedReceipt(input: { prUrl: string; commitSha: string }): boolean {
  return input.prUrl.trim().length > 0 && COMMIT_SHA_RE.test(input.commitSha.trim());
}

/**
 * Maps a reconcile failure to an honest ActionErrorDetail — cause, safe next
 * action, and whether anything was spent — never a bare failure string. The
 * server's typed rejection is presented FAITHFULLY: a `PUBLICATION_RECEIPT_BINDING`
 * (R7-1) is shown as "receipt does not match the verified candidate / no confirmed
 * PR", not a fake success and not a generic error.
 */
export function reconciliationErrorDetail(cause: unknown): ActionErrorDetail {
  const code = cause instanceof ResolutionApiError ? cause.code : null;
  const serverMessage = cause instanceof Error ? cause.message : String(cause);
  if (code === "PUBLICATION_RECEIPT_BINDING") {
    return {
      message: RECONCILIATION_BINDING_REJECTED,
      cause:
        "The server binds every receipt to THIS publication: the commit must equal the run's verified candidate result commit, and provider discovery must confirm the exact open-draft pull request. This receipt did not bind.",
      nextAction:
        "Confirm the real pull request and its commit in the repository, then submit the exact open-draft PR URL and that commit — or use Remote recheck to let the server auto-confirm. If it never landed, mark the publication failed.",
      spent: "Nothing changed — the publication is still reconciling; no state transition was applied.",
      code,
    };
  }
  if (code === "PUBLICATION_RECONCILIATION_RECEIPT_REQUIRED") {
    return {
      message: "A verified receipt needs a pull-request URL and a valid commit SHA.",
      cause: "A RECEIPTED resolution must carry a real receipt: a pull-request URL and a 40- or 64-character hex commit SHA.",
      nextAction: "Enter the open-draft pull request URL and its full commit SHA, then submit again.",
      spent: "Nothing changed — the publication is still reconciling.",
      code,
    };
  }
  if (code === "PUBLICATION_RECONCILIATION_INVALID") {
    return {
      message: "That resolution is not allowed.",
      cause: "A reconciliation resolution must be either a verified receipt (RECEIPTED) or a mark-failed (FAILED).",
      nextAction: "Use Remote recheck, Verified receipt, or Mark failed.",
      spent: "Nothing changed — the publication is still reconciling.",
      code,
    };
  }
  if (code === "CANDIDATE_NOT_FOUND") {
    return {
      message: "This publication could not be found for your account.",
      cause: "The publication is unknown or is owned by a different account; the server never reveals which.",
      nextAction: "Return to the run and reopen the publication screen.",
      spent: "Nothing changed.",
      code,
    };
  }
  return {
    message: "The reconciliation action could not be completed.",
    cause: serverMessage || "The server did not accept the request.",
    nextAction: "Retry Remote recheck. If it keeps failing, verify the pull request in the repository directly before any further action.",
    spent: "Unknown from this action alone — no state transition is applied unless the server confirms one.",
    code,
  };
}

/**
 * The three operator controls for a RECONCILING publication (finding #4): a
 * read-only Remote recheck, a Verified receipt entry, and Mark failed. Every
 * action surfaces its own pending state and typed error; the resulting UI state
 * follows the durable server response the parent hydrates back in — no control
 * ever fakes a success.
 */
export function PublicationReconcilingControls({
  disabled,
  pendingAction,
  error,
  onRecheck,
  onSubmitReceipt,
  onMarkFailed,
}: {
  disabled: boolean;
  pendingAction: string | null;
  error: ActionErrorDetail | null;
  onRecheck: () => void;
  onSubmitReceipt: (input: { prUrl: string; commitSha: string; detail: string }) => void;
  onMarkFailed: (detail: string) => void;
}) {
  const [prUrl, setPrUrl] = useState("");
  const [commitSha, setCommitSha] = useState("");
  const [receiptDetail, setReceiptDetail] = useState("");
  const [failReason, setFailReason] = useState("");

  const receiptReady = canSubmitVerifiedReceipt({ prUrl, commitSha });

  return (
    <section className="engineer-card engineer-gate" aria-labelledby="publication-reconcile-controls-heading">
      <div>
        <span className="engineer-kicker">Human reconciliation</span>
        <h2 id="publication-reconcile-controls-heading">Resolve this reconciling publication</h2>
        <p>
          A human must establish the true remote state, then resolve this publication. Nothing here retries the publish:
          Remote recheck is a read-only re-discovery, Verified receipt records a confirmed pull request, and Mark failed
          records that it never landed. The server validates and is the sole authority — the screen only reflects the
          durable outcome it returns.
        </p>
      </div>

      {error ? <PublicationErrorNotice {...error} /> : null}

      <div className="engineer-actions">
        <button type="button" disabled={disabled} onClick={onRecheck}>
          {pendingAction === "reconcile:recheck" ? "Rechecking…" : "Remote recheck"}
        </button>
      </div>

      <fieldset className="engineer-fieldset" disabled={disabled}>
        <legend>Verified receipt</legend>
        <p className="engineer-muted">
          The server accepts this only if the commit matches this publication's verified candidate AND provider discovery
          confirms the exact open-draft pull request. A mismatched or unconfirmed receipt is rejected — nothing is stored.
        </p>
        <label>Pull request URL
          <input type="url" value={prUrl} onChange={(event) => setPrUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" />
        </label>
        <label>Commit SHA
          <input type="text" value={commitSha} onChange={(event) => setCommitSha(event.target.value)} placeholder="40- or 64-character hex commit" spellCheck={false} />
        </label>
        <label>Note (optional)
          <input type="text" value={receiptDetail} onChange={(event) => setReceiptDetail(event.target.value)} placeholder="Where you confirmed the pull request" />
        </label>
        <div className="engineer-actions">
          <button
            type="button"
            className="engineer-primary"
            disabled={disabled || !receiptReady}
            onClick={() => onSubmitReceipt({ prUrl: prUrl.trim(), commitSha: commitSha.trim(), detail: receiptDetail.trim() })}
          >
            {pendingAction === "reconcile:receipt" ? "Submitting…" : "Submit verified receipt"}
          </button>
        </div>
      </fieldset>

      <fieldset className="engineer-fieldset" disabled={disabled}>
        <legend>Mark failed</legend>
        <label>Reason
          <textarea value={failReason} onChange={(event) => setFailReason(event.target.value)} rows={2} placeholder="Why this publication did not land" />
        </label>
        <div className="engineer-actions">
          <button
            type="button"
            className="danger"
            disabled={disabled || failReason.trim().length === 0}
            onClick={() => onMarkFailed(failReason.trim())}
          >
            {pendingAction === "reconcile:mark-failed" ? "Marking failed…" : "Mark failed"}
          </button>
        </div>
      </fieldset>
    </section>
  );
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
