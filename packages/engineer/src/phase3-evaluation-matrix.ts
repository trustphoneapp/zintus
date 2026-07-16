import { z } from "zod";
import { sha256 } from "./hash.js";

export const PHASE3_EVALUATION_POLICY_VERSION = "engineer-phase3-evaluation-v2";

const ScenarioSchema = z.object({
  scenarioId: z.string().regex(/^[a-z0-9_]+$/),
  category: z.enum(["SUCCESS", "COVERAGE", "FAILURE", "SECURITY", "ISOLATION", "REPAIR", "RECOVERY", "BUDGET", "ROUTING"]),
  expectedOutcome: z.string().min(1).max(500),
  authority: z.enum(["EXECUTOR", "SYSTEM", "REVIEWER"]),
  testFile: z.literal("verification.test.ts"),
  testName: z.string().min(1).max(500),
}).strict();

export const Phase3EvaluationMatrixSchema = z.object({
  policyVersion: z.literal(PHASE3_EVALUATION_POLICY_VERSION),
  scenarios: z.array(ScenarioSchema).min(1),
  matrixHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().superRefine((matrix, context) => {
  const scenarioIds = new Set(matrix.scenarios.map((scenario) => scenario.scenarioId));
  if (scenarioIds.size !== matrix.scenarios.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Phase 3 evaluation scenario IDs must be unique", path: ["scenarios"] });
  }
  const { matrixHash, ...content } = matrix;
  if (sha256(content) !== matrixHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Phase 3 evaluation matrix hash mismatch", path: ["matrixHash"] });
  }
});

const scenarios = [
  { scenarioId: "approved_happy_path", category: "SUCCESS", expectedOutcome: "Independent evidence plus isolated review reaches REVIEW_APPROVED.", authority: "REVIEWER", testFile: "verification.test.ts", testName: "uses Terra advisories and a fresh Sol review to produce a hash-bound evidence bundle" },
  { scenarioId: "missing_must_coverage", category: "COVERAGE", expectedOutcome: "An uncovered MUST criterion fails before command execution.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "fails closed before execution when a MUST criterion lacks an executable verification row" },
  { scenarioId: "unrelated_evidence_rejected", category: "ISOLATION", expectedOutcome: "Evidence for another criterion cannot certify a claim.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "never receives Builder narrative and rejects tampered diff or evidence" },
  { scenarioId: "high_risk_security_gate_missing", category: "SECURITY", expectedOutcome: "HIGH/CRITICAL work without an executable security gate escalates.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "requires an executable security gate for HIGH and CRITICAL manifests" },
  { scenarioId: "flaky_test_quarantine", category: "FAILURE", expectedOutcome: "Mixed repeated outcomes cannot enter Builder repair.", authority: "EXECUTOR", testFile: "verification.test.ts", testName: "quarantines mixed outcomes instead of sending a flaky check to Builder repair" },
  { scenarioId: "security_command_failure", category: "SECURITY", expectedOutcome: "A failed security command escalates without repair.", authority: "EXECUTOR", testFile: "verification.test.ts", testName: "escalates a failed security check instead of sending it to Builder repair" },
  { scenarioId: "blocking_deterministic_finding", category: "SECURITY", expectedOutcome: "HIGH deterministic findings block model review.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "blocks HIGH deterministic findings before model review" },
  { scenarioId: "stable_required_repair", category: "REPAIR", expectedOutcome: "A stable required failure persists one bounded repair and resumes without repeating its paid failure probe.", authority: "EXECUTOR", testFile: "verification.test.ts", testName: "persists and resumes a stable required-test repair without rerunning its paid failure probe" },
  { scenarioId: "identical_patch_stop", category: "REPAIR", expectedOutcome: "A no-progress repair exhausts the loop deterministically.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "stops a stable required-test repair loop when the Builder makes an identical patch" },
  { scenarioId: "adversarial_gap_approval_block", category: "COVERAGE", expectedOutcome: "A manifest-grounded MUST adversarial gap makes approval structurally unavailable until repaired.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "cannot approve a MUST-level adversarial gap and requires an evidence-bound repair finding" },
  { scenarioId: "reviewer_change_repair", category: "REPAIR", expectedOutcome: "A concurrency counterexample triggers bounded repair and a fresh full verification/review pass.", authority: "REVIEWER", testFile: "verification.test.ts", testName: "honors a Sol Reviewer change request, runs a bounded repair, then fully reverifies in a fresh session" },
  { scenarioId: "hash_tampering", category: "ISOLATION", expectedOutcome: "Diff or evidence mutation invalidates Reviewer input.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "never receives Builder narrative and rejects tampered diff or evidence" },
  { scenarioId: "workspace_mutation_during_review", category: "ISOLATION", expectedOutcome: "Concurrent workspace mutation makes the Reviewer decision stale.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "rejects a Reviewer decision when the workspace changes during review" },
  { scenarioId: "interrupted_verification_recovery", category: "RECOVERY", expectedOutcome: "Retained state is validated and verification restarts from FAST_CHECKS.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "reconstructs a retained sandbox and restarts interrupted verification from FAST_CHECKS" },
  { scenarioId: "runtime_budget_stop", category: "BUDGET", expectedOutcome: "Admission failure pauses before provider dispatch.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "pauses safely before dispatch when model admission exceeds the runtime budget" },
  { scenarioId: "luna_advisory_only", category: "ROUTING", expectedOutcome: "LUNA summarizes deterministic failure without changing authority.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "uses LUNA only for non-authoritative triage after deterministic failure classification" },
  { scenarioId: "terra_advisory_risk_floor", category: "ROUTING", expectedOutcome: "Raw TERRA output cannot certify acceptance; only a manifest-grounded system report may raise the review floor.", authority: "SYSTEM", testFile: "verification.test.ts", testName: "uses Terra advisories and a fresh Sol review to produce a hash-bound evidence bundle" },
] as const;

const content = { policyVersion: PHASE3_EVALUATION_POLICY_VERSION, scenarios } as const;

export const MANDATORY_PHASE3_EVALUATION_MATRIX = Phase3EvaluationMatrixSchema.parse({
  ...content,
  matrixHash: sha256(content),
});

export type Phase3EvaluationMatrix = z.infer<typeof Phase3EvaluationMatrixSchema>;
