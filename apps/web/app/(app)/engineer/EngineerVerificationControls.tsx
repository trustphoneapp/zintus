"use client";

import type { EngineerPublicationReadiness, VerifiedCandidateSummary } from "@/lib/engineer";

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="engineer-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function compactIdentifier(value: string) {
  return value.length > 25 ? `${value.slice(0, 14)}…${value.slice(-8)}` : value;
}

function FocusableIdentifier({ label, value }: { label: string; value: string }) {
  return <div>
    <span>{label}</span>
    <code tabIndex={0} aria-label={`${label}: ${value}`} title={value}>{compactIdentifier(value)}</code>
  </div>;
}

export function VerifiedCandidateCard({ candidate }: { candidate: VerifiedCandidateSummary }) {
  return <section className="engineer-card engineer-verified-candidate" aria-labelledby="machine-verified-heading">
    <div className="engineer-card-heading"><div><span className="engineer-kicker">Verified candidate</span><h2 id="machine-verified-heading">Machine verified</h2></div><span className="engineer-chip">{candidate.classificationResult.replaceAll("_", " ")}</span></div>
    <div className="engineer-verified-candidate-grid">
      <Metric label="Required tests" value={`${candidate.requiredTestCount} passed`} />
      <Metric label="Blocking critical findings" value={String(candidate.openBlockingCriticalCount)} />
      <FocusableIdentifier label="Checkpoint hash" value={candidate.checkpointHash} />
      <FocusableIdentifier label="Result commit" value={candidate.resultCommitSha} />
      <FocusableIdentifier label="Environment" value={candidate.environmentDigest} />
      <div><span>Checkpoint ID</span><small className="engineer-candidate-id" title={candidate.checkpointId}>{compactIdentifier(candidate.checkpointId)}</small></div>
      <div><span>Verified</span><time dateTime={candidate.createdAt}>{new Date(candidate.createdAt).toLocaleString()}</time></div>
    </div>
  </section>;
}

interface ApprovalDecisionControlsProps {
  disabled: boolean;
  candidateChanged: boolean;
  pendingAction: string | null;
  onApprove: () => void;
  onRequestChanges: () => void;
  onExtend: () => void;
  onReject: () => void;
}

export function ApprovalDecisionControls({ disabled, candidateChanged, pendingAction, onApprove, onRequestChanges, onExtend, onReject }: ApprovalDecisionControlsProps) {
  return <>
    {candidateChanged ? <p className="engineer-candidate-warning" role="status" aria-live="polite">Candidate changed—refresh before deciding.</p> : null}
    <div className="engineer-actions">
      <button className="engineer-primary" disabled={disabled} onClick={onApprove}>{pendingAction === "approval:approve" ? "Publishing…" : "Approve and publish"}</button>
      <button disabled={disabled} onClick={onRequestChanges}>{pendingAction === "approval:request-changes" ? "Requesting changes…" : "Request changes"}</button>
      <button disabled={disabled} onClick={onExtend}>{pendingAction === "approval:extend" ? "Applying extension…" : "Give me 24 hours"}</button>
      <button className="danger" disabled={disabled} onClick={onReject}>{pendingAction === "approval:reject" ? "Rejecting…" : "Reject"}</button>
    </div>
  </>;
}

/**
 * R3 (Blocker 3): the primary-run entry point into the authoritative P8
 * publication lane. A REVIEW_APPROVED run's machine-verified candidate is
 * publishable; this hands the human off to the Approval and publication screen
 * scoped to the run (select candidate → approve → publish → dispatch). It
 * replaces the old dead-end "not configured" notice, which was reachable only
 * by typing the URL.
 */
export function PublicationEntryNotice({ runId, readiness }: { runId: string; readiness: EngineerPublicationReadiness | null }) {
  const canPublish = readiness?.state === "READY";
  return <section className="engineer-card engineer-gate" aria-labelledby="publication-entry-heading">
    <div>
      <span className="engineer-kicker">Machine verified · {canPublish ? "ready for approval" : "local verification complete"}</span>
      <h2 id="publication-entry-heading">{canPublish ? "Approve and publish this verified candidate" : "Verified candidate retained locally"}</h2>
      <p>{canPublish
        ? "The signed candidate passed deterministic verification. Open the Approval and publication screen to record the human approval and dispatch the credentialed branch and pull request."
        : readiness?.message ?? "Checking whether this gateway is authorized to publish. No publication action is available until the server confirms it."}</p>
    </div>
    <div className="engineer-actions">
      {canPublish ? <a className="engineer-primary" href={`/engineer/publication?run=${encodeURIComponent(runId)}`}>Open Approval and publication</a> : <span className="engineer-chip">No publication authority</span>}
    </div>
  </section>;
}
