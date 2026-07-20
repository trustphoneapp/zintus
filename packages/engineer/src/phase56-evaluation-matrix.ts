import { z } from "zod";
import { sha256 } from "./hash.js";

export const PHASE56_EVALUATION_POLICY_VERSION = "engineer-phase56-evaluation-v2";

const ScenarioSchema = z.object({
  scenarioId: z.string().regex(/^[a-z0-9_]+$/),
  category: z.enum(["PLANNING", "BUDGET", "CACHE", "OBSERVABILITY", "RECOVERY", "STORAGE", "ISOLATION", "HUMAN_FLOW"]),
  expectedOutcome: z.string().min(1).max(500),
  testFile: z.enum(["planning.test.ts", "budget.test.ts", "runtime-budget.test.ts", "supervisor.test.ts", "hardening.test.ts", "execution.test.ts", "verification.test.ts", "publication.test.ts", "resolution-case-derivation.test.ts", "engineer.test.ts", "handler.test.ts"]),
  testName: z.string().min(1).max(500),
}).strict();

export const Phase56EvaluationMatrixSchema = z.object({
  policyVersion: z.literal(PHASE56_EVALUATION_POLICY_VERSION),
  scenarios: z.array(ScenarioSchema).min(16),
  matrixHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().superRefine((matrix, context) => {
  if (new Set(matrix.scenarios.map((item) => item.scenarioId)).size !== matrix.scenarios.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Phase 5/6 scenario IDs must be unique", path: ["scenarios"] });
  }
  const { matrixHash, ...content } = matrix;
  if (sha256(content) !== matrixHash) context.addIssue({ code: z.ZodIssueCode.custom, message: "Phase 5/6 evaluation matrix hash mismatch", path: ["matrixHash"] });
});

const scenarios = [
  { scenarioId: "grounded_structured_plan", category: "PLANNING", expectedOutcome: "TERRA emits a persisted structured plan bound to exact context while deterministic policy owns risk.", testFile: "planning.test.ts", testName: "uses TERRA for a persisted plan while deterministic rules assign risk" },
  { scenarioId: "mandatory_question_now", category: "HUMAN_FLOW", expectedOutcome: "All foreseeable mandatory unknowns are collected in one planning pass and the durable run replans once after every human answer.", testFile: "planning.test.ts", testName: "batches mandatory questions and performs one compact replan after every answer" },
  { scenarioId: "prompt_injected_plan_rejected", category: "ISOLATION", expectedOutcome: "Repository text cannot expand the command allow-list or mutate planning state.", testFile: "planning.test.ts", testName: "rejects a prompt-injected command before any planning state mutation" },
  { scenarioId: "missing_context_blocks", category: "PLANNING", expectedOutcome: "Planning cannot proceed without the exact-base context manifest.", testFile: "planning.test.ts", testName: "blocks planning before any mutation when exact-base context is missing" },
  { scenarioId: "budget_dimensions_bounded", category: "BUDGET", expectedOutcome: "Time, token, model-call, cost, artifact, command, and concurrency budgets stop independently.", testFile: "runtime-budget.test.ts", testName: "hard-stops each bounded resource independently" },
  { scenarioId: "cache_pricing_versioned", category: "CACHE", expectedOutcome: "Cached reads and cache writes use the versioned GPT-5.6 price catalog and invalid usage fails closed.", testFile: "runtime-budget.test.ts", testName: "uses the versioned SOL/TERRA/LUNA catalog and rejects unknown or malformed usage" },
  { scenarioId: "reservation_reconciled", category: "BUDGET", expectedOutcome: "Worst-case model spend is reserved before a call and reconciled to measured cached-token usage.", testFile: "supervisor.test.ts", testName: "atomically reserves worst-case model spend and reconciles it to actual usage" },
  { scenarioId: "infinite_repair_stops", category: "RECOVERY", expectedOutcome: "Repeated equivalent failures exhaust the deterministic repair bound.", testFile: "hardening.test.ts", testName: "infinite repair loops stop at the deterministic same-failure bound" },
  { scenarioId: "builder_discovery_bounded", category: "BUDGET", expectedOutcome: "Unique read-only discovery is bounded across pause and resume, and an exhausted checkpoint cannot purchase another model call.", testFile: "execution.test.ts", testName: "rejects an exhausted legacy discovery checkpoint before another paid call" },
  { scenarioId: "paused_topup_single_use", category: "BUDGET", expectedOutcome: "New allowance is accepted only while paused, remains idempotent, and exposes a durable pending-resume signal.", testFile: "budget.test.ts", testName: "rejects new allowance while active but permits an exact replay after resume" },
  { scenarioId: "flake_never_passes", category: "RECOVERY", expectedOutcome: "Mixed repeated outcomes are quarantined and cannot become authoritative success.", testFile: "hardening.test.ts", testName: "mixed repeated outcomes are quarantined and never count as a pass" },
  { scenarioId: "cas_single_writer", category: "RECOVERY", expectedOutcome: "Concurrent supervisors allow exactly one state writer.", testFile: "hardening.test.ts", testName: "concurrent supervisors use compare-and-swap so exactly one writer advances" },
  { scenarioId: "private_storage", category: "STORAGE", expectedOutcome: "Ledger, artifact, and warm-pool storage is owner-only and rejects symlink substitution.", testFile: "hardening.test.ts", testName: "local storage repairs private modes and rejects symlink substitution" },
  { scenarioId: "warm_pool_quarantine", category: "STORAGE", expectedOutcome: "Expired, corrupt, and excess warm entries are quarantined and never reused.", testFile: "hardening.test.ts", testName: "warm-pool health sweep quarantines expired, corrupt, and excess entries" },
  { scenarioId: "warm_claim_once", category: "ISOLATION", expectedOutcome: "A warm workspace is atomically claimed once and never returned to the pool.", testFile: "execution.test.ts", testName: "atomically claims a validated warm workspace once and never returns it to the pool" },
  { scenarioId: "reviewer_workspace_stale", category: "ISOLATION", expectedOutcome: "Workspace mutation invalidates the isolated Reviewer decision.", testFile: "verification.test.ts", testName: "rejects a Reviewer decision when the workspace changes during review" },
  { scenarioId: "stale_base_adopts_advanced_head", category: "RECOVERY", expectedOutcome: "A stranded stale-base run is adopted by the Resolution Desk onto the durably-observed advanced branch HEAD, never the stale recorded base, so recovery cannot immediately re-strand (R8-3: the direct stale-base synchronize/recover bypass is removed).", testFile: "resolution-case-derivation.test.ts", testName: "R8-3 FINDING 1: an adopted BASE_BRANCH_STALE run targets the advanced branch HEAD, not the stale recorded base" },
  { scenarioId: "canonical_base_cas", category: "RECOVERY", expectedOutcome: "Only the base SHA may advance and concurrent or identity-changing recovery is rejected.", testFile: "engineer.test.ts", testName: "advances only the canonical base after a credentialed stale-base recovery" },
  { scenarioId: "durable_operations_snapshot", category: "OBSERVABILITY", expectedOutcome: "Authenticated run reads expose durable run health and operation counters without invented values.", testFile: "handler.test.ts", testName: "Engineer run intake and reads use the gateway bearer boundary" },
] as const;

const content = { policyVersion: PHASE56_EVALUATION_POLICY_VERSION, scenarios } as const;
export const MANDATORY_PHASE56_EVALUATION_MATRIX = Phase56EvaluationMatrixSchema.parse({ ...content, matrixHash: sha256(content) });
