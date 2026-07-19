import { z } from "zod";
import { sha256 } from "./hash.js";

export const PHASE4_EVALUATION_POLICY_VERSION = "engineer-phase4-evaluation-v1";

const ScenarioSchema = z.object({
  scenarioId: z.string().regex(/^[a-z0-9_]+$/),
  category: z.enum(["AUTHORITY", "APPROVAL", "PUBLICATION", "SECURITY", "RECOVERY", "CANCELLATION"]),
  expectedOutcome: z.string().min(1).max(500),
  testFile: z.enum(["verification.test.ts", "publication.test.ts", "git-service.test.ts", "engineer.test.ts", "handler.test.ts"]),
  testName: z.string().min(1).max(500),
}).strict();

export const Phase4EvaluationMatrixSchema = z.object({
  policyVersion: z.literal(PHASE4_EVALUATION_POLICY_VERSION),
  scenarios: z.array(ScenarioSchema).min(10),
  matrixHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().superRefine((matrix, context) => {
  if (new Set(matrix.scenarios.map((item) => item.scenarioId)).size !== matrix.scenarios.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Phase 4 scenario IDs must be unique", path: ["scenarios"] });
  }
  const { matrixHash, ...content } = matrix;
  if (sha256(content) !== matrixHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "Phase 4 evaluation matrix hash mismatch", path: ["matrixHash"] });
});

const scenarios = [
  { scenarioId: "stable_server_identity", category: "AUTHORITY", expectedOutcome: "Authority is stable across restart and separated across installations.", testFile: "engineer.test.ts", testName: "persists install identity across restarts and separates installs" },
  { scenarioId: "forged_principal_rejected", category: "AUTHORITY", expectedOutcome: "A caller-selected principal cannot mutate a run or publication decision.", testFile: "engineer.test.ts", testName: "rechecks publication authority and rejects every forged principal mutation" },
  { scenarioId: "request_actor_ignored", category: "AUTHORITY", expectedOutcome: "Request-body actor fields cannot select run ownership or cancellation authority.", testFile: "handler.test.ts", testName: "Engineer run intake and reads use the gateway bearer boundary" },
  { scenarioId: "assigned_reviewer_only", category: "APPROVAL", expectedOutcome: "Only the server-assigned reviewer can approve the hash-bound result.", testFile: "verification.test.ts", testName: "uses Terra advisories and a fresh Sol review to produce a hash-bound evidence bundle" },
  { scenarioId: "approval_timeout", category: "APPROVAL", expectedOutcome: "An overdue approval fails closed and records a durable failure.", testFile: "publication.test.ts", testName: "expires a pending approval fail-closed and records the terminal human-review state" },
  { scenarioId: "owner_cancellation", category: "CANCELLATION", expectedOutcome: "Only the owner can request cancellation; the Supervisor persists the stop intent and the fenced run owner performs cleanup before terminal cancellation.", testFile: "verification.test.ts", testName: "cancellation is Supervisor-controlled and leaves terminalization to the fenced run owner" },
  { scenarioId: "stale_base_no_mutation", category: "SECURITY", expectedOutcome: "A changed base branch blocks all remote mutation and requires re-verification.", testFile: "verification.test.ts", testName: "honors a Sol Reviewer change request, runs a bounded repair, then fully reverifies in a fresh session" },
  { scenarioId: "token_not_in_argv", category: "SECURITY", expectedOutcome: "Git credentials remain in an ephemeral askpass boundary and never enter argv.", testFile: "git-service.test.ts", testName: "uses an ephemeral askpass token without placing the credential in argv" },
  { scenarioId: "strict_branch_policy", category: "SECURITY", expectedOutcome: "Publication requires reviews, strict checks, admin enforcement, and immutable history.", testFile: "git-service.test.ts", testName: "requires reviews, stale-approval invalidation, strict checks, admin enforcement, and immutable history" },
  { scenarioId: "weak_branch_policy", category: "SECURITY", expectedOutcome: "Missing required checks makes branch protection insufficient.", testFile: "git-service.test.ts", testName: "fails the protection verdict when required status checks are absent" },
  { scenarioId: "existing_pr_recovered", category: "RECOVERY", expectedOutcome: "A crash after remote PR creation is recovered without a duplicate POST.", testFile: "git-service.test.ts", testName: "recovers an already-created pull request instead of posting a duplicate" },
  { scenarioId: "publication_retry", category: "RECOVERY", expectedOutcome: "A durable PR failure resumes and completed Git operations are not duplicated.", testFile: "verification.test.ts", testName: "uses Terra advisories and a fresh Sol review to produce a hash-bound evidence bundle" },
] as const;

const content = { policyVersion: PHASE4_EVALUATION_POLICY_VERSION, scenarios } as const;
export const MANDATORY_PHASE4_EVALUATION_MATRIX = Phase4EvaluationMatrixSchema.parse({ ...content, matrixHash: sha256(content) });
