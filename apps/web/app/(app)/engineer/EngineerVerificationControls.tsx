"use client";

import type { VerifiedCandidateSummary } from "@/lib/engineer";

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

export function PublicationUnavailableNotice() {
  return <section className="engineer-card engineer-gate">
    <span className="engineer-kicker">Machine verified</span>
    <h2>Publication is not configured locally</h2>
    <p>The signed candidate passed deterministic verification; no human approval or publication has occurred.</p>
  </section>;
}
