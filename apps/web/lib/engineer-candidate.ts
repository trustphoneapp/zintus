import type { EngineerApproval, EngineerApprovalAuthority, VerifiedCandidateSummary } from "./engineer";

export function candidateMatchesApproval(
  candidate: VerifiedCandidateSummary | null,
  authority: EngineerApprovalAuthority | null,
): boolean {
  return Boolean(candidate && authority &&
    candidate.checkpointId === authority.expectedVerifiedCheckpointId &&
    candidate.checkpointHash === authority.expectedVerifiedCheckpointHash);
}

export function candidateConflictAppliesToRun(staleRunId: string | null, runId: string | null): boolean {
  return staleRunId !== null && runId !== null && staleRunId === runId;
}

export function engineerTrustState(input: {
  runState: string;
  candidate: VerifiedCandidateSummary | null;
  approval: EngineerApproval | null;
  authority: EngineerApprovalAuthority | null;
}): "UNVERIFIED" | "MACHINE_VERIFIED" | "HUMAN_APPROVAL_PENDING" | "HUMAN_APPROVED" {
  const matches = candidateMatchesApproval(input.candidate, input.authority);
  if (matches && input.approval?.status === "APPROVED" && /^(HUMAN_APPROVED|PR_|COMPLETED)/.test(input.runState)) return "HUMAN_APPROVED";
  if (matches && input.approval?.status === "PENDING" && input.runState === "HUMAN_APPROVAL_PENDING") return "HUMAN_APPROVAL_PENDING";
  return input.candidate ? "MACHINE_VERIFIED" : "UNVERIFIED";
}
