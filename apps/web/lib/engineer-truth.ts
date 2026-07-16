import type { EngineerReviewBinding, RunEvent } from "./engineer";

export type EngineerDiffProvenance = "LIVE_UNVERIFIED" | "VERIFICATION_CANDIDATE" | "REVIEWED_HASH_BOUND" | "PUBLISHED";
export type EngineerSecurityStatus = "PENDING" | "UNAVAILABLE" | "NO_FINDINGS" | "FINDINGS";

const VERIFICATION_STATES = /^(FAST_CHECKS|UNIT_TESTING|INTEGRATION_TESTING|E2E_TESTING|FLAKE_|SECURITY_REVIEW|CODE_REVIEW|EVIDENCE_|REVIEW|HUMAN_|PR_|BASE_BRANCH|COMPLETED|REJECTED)/;
const DURABLY_REVIEWED_STATES = /^(REVIEW_APPROVED|REVIEW_CHANGES_REQUESTED|REVIEW_REJECTED|HUMAN_REVIEW_REQUIRED|HUMAN_APPROVAL_PENDING|HUMAN_APPROVED|PR_PREFLIGHT|PR_CREATING|PR_CREATED|PR_CREATION_FAILED|BASE_BRANCH_STALE|COMPLETED|REJECTED)$/;
const SECURITY_COMPLETION_STATES = new Set([
  "CODE_REVIEW", "EVIDENCE_SYNTHESIS", "REVIEWING", "REVIEW_APPROVED", "REVIEW_CHANGES_REQUESTED",
  "REVIEW_REJECTED", "HUMAN_REVIEW_REQUIRED", "HUMAN_APPROVAL_PENDING", "HUMAN_APPROVED",
  "PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "COMPLETED", "REJECTED",
]);

export interface DiffTruthInput {
  state: string;
  displayedDiffHash: string | null;
  reviewBinding: EngineerReviewBinding | null;
  evidenceBundles: Array<{ evidenceBundleId?: string; bundleHash?: string }>;
  approval?: { diffHash?: string; evidenceBundleHash?: string } | null;
  gitOperations: Array<{ operationType?: string; status?: string; evidenceBundleHash?: string | null; remoteReference?: string | null }>;
}

export async function engineerTextSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function bindingMatches(input: DiffTruthInput): boolean {
  const binding = input.reviewBinding;
  if (!binding || !binding.reviewerIsolationVerified || !input.displayedDiffHash) return false;
  if (input.displayedDiffHash !== binding.reviewerDiffHash) return false;
  if (!binding.reviewerEvidenceBundleHash.startsWith("sha256:")) return false;
  if (!input.evidenceBundles.some((bundle) =>
    bundle.evidenceBundleId === binding.evidenceBundleId && bundle.bundleHash === binding.evidenceBundleHash)) return false;
  if (input.approval && (
    input.approval.diffHash !== binding.reviewerDiffHash ||
    input.approval.evidenceBundleHash !== binding.evidenceBundleHash
  )) return false;
  return true;
}

export function deriveDiffProvenance(input: DiffTruthInput): EngineerDiffProvenance {
  const bound = bindingMatches(input);
  if (input.state === "COMPLETED" && bound && input.gitOperations.some((operation) =>
    operation.operationType === "CREATE_PR" && operation.status === "SUCCEEDED" &&
    operation.evidenceBundleHash === input.reviewBinding?.evidenceBundleHash &&
    Boolean(operation.remoteReference))) return "PUBLISHED";
  if (DURABLY_REVIEWED_STATES.test(input.state) && bound) return "REVIEWED_HASH_BOUND";
  return VERIFICATION_STATES.test(input.state) ? "VERIFICATION_CANDIDATE" : "LIVE_UNVERIFIED";
}

export const DIFF_PROVENANCE_PRESENTATION: Record<EngineerDiffProvenance, { title: string; description: string; verified: boolean }> = {
  LIVE_UNVERIFIED: {
    title: "Live diff",
    description: "Current workspace changes have not completed independent verification.",
    verified: false,
  },
  VERIFICATION_CANDIDATE: {
    title: "Verification candidate",
    description: "Verification has started, but the displayed diff is not yet bound to matching Reviewer and evidence hashes.",
    verified: false,
  },
  REVIEWED_HASH_BOUND: {
    title: "Reviewed diff",
    description: "The displayed diff matches the isolated Reviewer and durable evidence binding.",
    verified: true,
  },
  PUBLISHED: {
    title: "Published diff",
    description: "The reviewed hash-bound diff matches the successfully published pull request evidence.",
    verified: true,
  },
};

export function deriveSecurityStatus(input: {
  events: RunEvent[];
  findingCount: number;
  errors: Array<{ section: string }>;
}): { status: EngineerSecurityStatus; label: string } {
  if (input.errors.some((error) => error.section === "security")) return { status: "UNAVAILABLE", label: "Unavailable" };
  if (input.findingCount > 0) return { status: "FINDINGS", label: `${input.findingCount} ${input.findingCount === 1 ? "finding" : "findings"}` };
  const lastSecurityReview = input.events.reduce((latest, event, index) => event.nextState === "SECURITY_REVIEW" ? index : latest, -1);
  const completed = lastSecurityReview >= 0 && input.events.slice(lastSecurityReview + 1)
    .some((event) => SECURITY_COMPLETION_STATES.has(event.nextState));
  return completed ? { status: "NO_FINDINGS", label: "No findings" } : { status: "PENDING", label: "Pending" };
}
