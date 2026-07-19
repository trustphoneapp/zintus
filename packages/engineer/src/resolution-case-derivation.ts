import type { Database } from "bun:sqlite";
import type { RunState } from "./contracts.js";
import { sha256 } from "./hash.js";
import { MODEL_ROUTING_POLICY_VERSION } from "./model-routing.js";
import type { CanonicalBlocker } from "./resolution-case.js";
import { reverifyBlockerReasonCode } from "./resolution-case.js";
import { ResolutionDeskError, type CaseCreationInput } from "./resolution-desk.js";
import { OPENAI_GPT56_PRICING_2026_07_14 } from "./runtime-budget.js";
import { isTerminalState } from "./state-machine.js";

// ---------------------------------------------------------------------------
// P7 server-side case-creation derivation (Day 3 pair 3 — the final gate).
//
// This is the safety-critical adapter that turns a DURABLE TERMINAL engineer run
// into the full `CaseCreationInput` the Resolution Desk consumes. It is a PURE
// function over the desk's shared SQLite connection (the same connection the
// ledger writes and the desk fences on — see resolution-desk.ts / factory), so
// every classification is deterministically testable exactly like the desk and
// factory. It NEVER runs in a model or sandbox context: it reads only durable
// authority tables and returns a plan; the signing secret and dispatch stay in
// the gateway process.
//
// The load-bearing rule is the blocker classification. `kind` (BLOCKING vs
// ADVISORY) plus `reasonCode` drive correctionEligible and reverify eligibility
// (see resolution-case.ts `classifyReason` / `evaluateReverifyEligibility`). A
// mis-downgrade to ADVISORY, or a false transient typing, is the dangerous
// direction — it would authorize a wrong correction/reverify and, through the
// directive, a wrong replacement. So this module FAILS CLOSED everywhere it
// cannot prove a safe downgrade: every failure record is BLOCKING; a security
// finding that is not provably informational is BLOCKING; a terminal non-success
// run that produced no blocking durable record still gets a synthetic BLOCKING
// blocker from its terminal state; only an explicit low/info severity ever
// becomes ADVISORY, and only a durably-typed transient cause is ever transient.
//
// FULL blocker-source -> classification mapping (implemented below):
//   failure_records                -> BLOCKING; reasonCode = record reason_code,
//                                     except SECURITY_FAILURE -> SECURITY_FAILURE
//                                     (never transient) and a generic
//                                     PHASE3_UNEXPECTED_FAILURE surfaces its typed
//                                     transient underlying_cause via
//                                     reverifyBlockerReasonCode (the ONLY transient
//                                     path). classifyReason then decides
//                                     TRANSIENT / NON_RECOVERABLE / CORRECTABLE.
//   security_findings (OPEN)       -> severity LOW/INFO => ADVISORY(SECURITY_FINDING);
//                                     else BLOCKING(SECURITY_FINDING) [CORRECTABLE].
//                                     RESOLVED / ACCEPTED_RISK are not blockers.
//   review_findings (OPEN)         -> severity LOW/INFO => ADVISORY(REVIEW_ADVISORY);
//                                     else BLOCKING(REVIEW_CHANGE_REQUIRED)
//                                     [CORRECTABLE]. RESOLVED / REJECTED skip.
//   terminal-state backstop        -> if NO blocking blocker was derived above and
//                                     the run is terminal-non-success, one synthetic
//                                     BLOCKING blocker from the terminal state
//                                     (RETRY_BUDGET_EXHAUSTED stays non-recoverable;
//                                     every other terminal maps CORRECTABLE). This
//                                     is the fail-closed floor for source (f).
// ---------------------------------------------------------------------------

const MICRO = 1_000_000;
const ADVISORY_SEVERITIES: ReadonlySet<string> = new Set(["LOW", "INFO"]);
const MAX_DESCRIPTION = 2_000;
const MAX_ANCESTOR_DEPTH = 256;

export interface DeriveCaseCreationOptions {
  /**
   * The server's CURRENT pricing-policy digest (S1). The case exposes it and a
   * corrected-run budget must echo it back (`409 PRICING_POLICY_DRIFT` on
   * drift). Defaults to `serverPricingPolicyDigest()`; the gateway passes the
   * same value so the durable case and the live server agree.
   */
  readonly pricingPolicyDigest?: `sha256:${string}`;
}

/**
 * Canonical digest of the server's current pricing + routing policy. Stable and
 * server-authoritative (never client-supplied); the value the resolution case
 * pins and the UI echoes back on a corrected-run budget.
 */
export function serverPricingPolicyDigest(): `sha256:${string}` {
  return sha256({
    kind: "engineer-resolution-pricing-policy",
    routingPolicyVersion: MODEL_ROUTING_POLICY_VERSION,
    pricing: OPENAI_GPT56_PRICING_2026_07_14,
  });
}

interface RunRow {
  id: string;
  user_id: string;
  repository_id: string;
  base_commit_sha: string;
  manifest_hash: string | null;
  state: string;
  state_version: number;
}

/**
 * Build the full `CaseCreationInput` from a durable TERMINAL run. Throws a
 * `ResolutionDeskError` (so the gateway maps it to the right HTTP status) when
 * the run is missing (`404`) or is not terminal (`409`) — a case may only be
 * opened for a run whose durable authority is frozen.
 */
export function deriveCaseCreationInput(
  db: Database,
  runId: string,
  options: DeriveCaseCreationOptions = {},
): CaseCreationInput {
  const run = db.query(
    "SELECT id,user_id,repository_id,base_commit_sha,manifest_hash,state,state_version FROM engineer_runs WHERE id=?",
  ).get(runId) as RunRow | null;
  if (!run) throw new ResolutionDeskError("DERIVATION_RUN_NOT_FOUND", "resolution source run not found", 404);
  if (!isTerminalState(run.state as RunState)) {
    throw new ResolutionDeskError(
      "DERIVATION_RUN_NOT_TERMINAL",
      `a resolution case may only be opened for a terminal run; run ${runId} is ${run.state}`,
      409,
      { state: run.state },
    );
  }

  const blockers = deriveBlockers(db, runId, run.state);
  const sourceClassExcluded = isOptionalHardeningOrV2Source(db, runId);
  const preVerificationCandidateDigest = latestVerifiedCandidateDigest(db, runId);
  const spend = deriveSpend(db, run);
  const requiredLaneContractHash = latestRequiredLaneContractHash(db, run);
  const pricingPolicyDigest = options.pricingPolicyDigest ?? serverPricingPolicyDigest();

  return {
    sourceRunId: run.id,
    ownerUserId: run.user_id,
    repositoryId: run.repository_id,
    sourceState: run.state,
    sourceStateVersion: run.state_version,
    baseCommitSha: run.base_commit_sha,
    manifestHash: run.manifest_hash ?? sha256({ noManifest: run.id }),
    requiredLaneContractHash,
    blockers,
    preVerificationCandidateDigest,
    sourceActualMicrousd: spend.sourceActualMicrousd,
    priorReplacementActualMicrousd: spend.priorReplacementActualMicrousd,
    ambiguousLiabilityMicrousd: spend.ambiguousLiabilityMicrousd,
    cumulativeCeilingMicrousd: spend.cumulativeCeilingMicrousd,
    pricingPolicyDigest,
    sourceClassExcluded,
  };
}

// --- Blocker classification (the safety-critical mapping) ------------------

function truncate(text: string): string {
  return text.length <= MAX_DESCRIPTION ? text : text.slice(0, MAX_DESCRIPTION);
}

function deriveBlockers(db: Database, runId: string, state: string): CanonicalBlocker[] {
  const blockers: CanonicalBlocker[] = [];

  // 1. Durable failure records — always BLOCKING. reasonCode drives the class.
  //    A SECURITY_FAILURE can never be transient (forced reasonCode). A generic
  //    PHASE3_UNEXPECTED_FAILURE surfaces its typed transient underlying_cause —
  //    the ONLY path to a transient blocker — via the reverify bridge; anything
  //    untyped stays PHASE3_UNEXPECTED_FAILURE (reverify-ineligible).
  const failures = db.query(
    "SELECT id,failure_class,reason_code,underlying_cause FROM failure_records WHERE run_id=? ORDER BY rowid",
  ).all(runId) as Array<{ id: string; failure_class: string; reason_code: string; underlying_cause: string | null }>;
  for (const failure of failures) {
    const reasonCode = failure.failure_class === "SECURITY_FAILURE"
      ? "SECURITY_FAILURE"
      : reverifyBlockerReasonCode({ reasonCode: failure.reason_code, underlyingCause: failure.underlying_cause ?? undefined });
    blockers.push({
      blockerId: failure.id,
      kind: "BLOCKING",
      reasonCode,
      description: truncate(`${failure.failure_class}: ${failure.reason_code}`),
      sourceRef: `failure_records:${failure.id}`,
    });
  }

  // 2. Open security findings. LOW/INFO -> ADVISORY; everything else (incl. any
  //    unrecognized severity) FAILS CLOSED to BLOCKING. Correction-eligible
  //    (SECURITY_FINDING is never in the transient allowlist).
  const securityFindings = db.query(
    "SELECT id,severity,category,description FROM security_findings WHERE run_id=? AND status='OPEN' ORDER BY rowid",
  ).all(runId) as Array<{ id: string; severity: string; category: string; description: string }>;
  for (const finding of securityFindings) {
    const kind = ADVISORY_SEVERITIES.has(finding.severity) ? "ADVISORY" : "BLOCKING";
    blockers.push({
      blockerId: finding.id,
      kind,
      reasonCode: "SECURITY_FINDING",
      description: truncate(`[${finding.severity}] ${finding.category}: ${finding.description}`),
      sourceRef: `security_findings:${finding.id}`,
    });
  }

  // 3. Open reviewer findings. LOW/INFO -> ADVISORY; else BLOCKING correctable.
  const reviewFindings = db.query(
    `SELECT f.id AS id,f.severity AS severity,f.category AS category,f.description AS description
     FROM review_findings f JOIN reviewer_sessions s ON s.id=f.reviewer_session_id
     WHERE s.run_id=? AND f.status='OPEN' ORDER BY f.rowid`,
  ).all(runId) as Array<{ id: string; severity: string; category: string; description: string }>;
  for (const finding of reviewFindings) {
    const advisory = ADVISORY_SEVERITIES.has(finding.severity);
    blockers.push({
      blockerId: finding.id,
      kind: advisory ? "ADVISORY" : "BLOCKING",
      reasonCode: advisory ? "REVIEW_ADVISORY" : "REVIEW_CHANGE_REQUIRED",
      description: truncate(`[${finding.severity}] ${finding.category}: ${finding.description}`),
      sourceRef: `review_findings:${finding.id}`,
    });
  }

  // 4. Terminal-state backstop (fail-closed floor). If the run stopped in a
  //    non-success terminal state yet no BLOCKING blocker was derived above, we
  //    do NOT leave it blocker-free (which would silently read as "no defect").
  //    We synthesize exactly one BLOCKING blocker from the terminal state.
  const hasBlocking = blockers.some((blocker) => blocker.kind === "BLOCKING");
  if (!hasBlocking && state !== "COMPLETED") {
    blockers.push(terminalStateBackstop(runId, state));
  }

  return blockers;
}

/**
 * Deterministic terminal-state -> BLOCKING reasonCode floor. Only
 * RETRY_BUDGET_EXHAUSTED keeps its non-recoverable (reject-only) class; every
 * other terminal maps to a CORRECTABLE reasonCode so correction — never a
 * silent reverify — is the authorized path when the durable cause is unknown.
 */
function terminalStateBackstop(runId: string, state: string): CanonicalBlocker {
  const reasonByState: Record<string, string> = {
    FAILED: "RUN_FAILED",
    REJECTED: "RUN_REJECTED",
    CANCELLED: "RUN_CANCELLED",
    TIMED_OUT: "RUN_TIMED_OUT",
    RETRY_BUDGET_EXHAUSTED: "RETRY_BUDGET_EXHAUSTED",
    BLOCKED_BY_ENVIRONMENT: "BLOCKED_BY_ENVIRONMENT",
    BLOCKED_BY_EXTERNAL_DEPENDENCY: "BLOCKED_BY_EXTERNAL_DEPENDENCY",
    SECURITY_ESCALATION: "SECURITY_ESCALATION",
    VERIFICATION_INCOMPLETE: "VERIFICATION_INCOMPLETE",
    ROLLED_BACK: "RUN_ROLLED_BACK",
  };
  const reasonCode = reasonByState[state] ?? "RUN_TERMINAL_UNCLASSIFIED";
  return {
    blockerId: `terminal:${runId}:${state}`,
    kind: "BLOCKING",
    reasonCode,
    description: truncate(`terminal run state ${state} with no durable blocker record; failed closed to a blocking correction`),
    sourceRef: `engineer_runs:${runId}`,
  };
}

// --- Source class (optional-hardening / v2 exclusion) ----------------------

/**
 * Optional-hardening / v2 sources are reverify-EXCLUDED (S2: reverify returns
 * `SOURCE_CLASS_EXCLUDED`). A run is such a source iff it is the child of an
 * optional-hardening lineage edge. Fails closed on excluded: presence => true.
 */
function isOptionalHardeningOrV2Source(db: Database, runId: string): boolean {
  const lineage = db.query("SELECT 1 AS present FROM engineer_run_lineage WHERE child_run_id=? LIMIT 1").get(runId) as
    | { present: number }
    | null;
  return lineage !== null;
}

// --- Pre-verification candidate --------------------------------------------

function latestVerifiedCandidateDigest(db: Database, runId: string): `sha256:${string}` | null {
  const row = db.query(
    "SELECT checkpoint_hash FROM verified_candidate_checkpoints WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
  ).get(runId) as { checkpoint_hash: string } | null;
  return row ? (row.checkpoint_hash as `sha256:${string}`) : null;
}

// --- Required-lane contract ------------------------------------------------

function latestRequiredLaneContractHash(db: Database, run: RunRow): string {
  const byManifest = run.manifest_hash
    ? db.query(
      "SELECT contract_hash FROM required_lane_contracts WHERE run_id=? AND manifest_hash=? ORDER BY created_at DESC LIMIT 1",
    ).get(run.id, run.manifest_hash) as { contract_hash: string } | null
    : null;
  if (byManifest) return byManifest.contract_hash;
  const byRun = db.query(
    "SELECT contract_hash FROM required_lane_contracts WHERE run_id=? ORDER BY created_at DESC LIMIT 1",
  ).get(run.id) as { contract_hash: string } | null;
  return byRun ? byRun.contract_hash : sha256({ noRequiredLaneContract: run.id });
}

// --- Spend / ceiling (fail-closed) -----------------------------------------

interface DerivedSpend {
  sourceActualMicrousd: number;
  priorReplacementActualMicrousd: number;
  ambiguousLiabilityMicrousd: number;
  cumulativeCeilingMicrousd: number;
}

/**
 * Derive spend from the real cost/budget records:
 *   sourceActual        = the source run's settled spend (informational).
 *   priorReplacement    = sum of every RESOLUTION ANCESTOR run's settled spend,
 *                         so a chain of replacements can never, in total, exceed
 *                         the root ceiling (0 for a first-generation source).
 *   ambiguousLiability  = source + ancestor unsettled provider-outcome cost
 *                         (fail-closed: all uncertain liability counts).
 *   cumulativeCeiling   = the ROOT run's lifetime cost cap.
 * The desk enforces prior + ambiguous + newCap <= ceiling, so folding all
 * already-spent ancestor actual + uncertain liability in is the fail-closed
 * (never over-authorize) direction.
 */
function deriveSpend(db: Database, run: RunRow): DerivedSpend {
  const source = runSpendMicrousd(db, run.id);
  const ancestors = collectResolutionAncestors(db, run.id);

  let priorReplacementActual = 0;
  let ambiguous = source.ambiguousMicrousd;
  for (const ancestorId of ancestors) {
    const ancestorSpend = runSpendMicrousd(db, ancestorId);
    priorReplacementActual += ancestorSpend.settledMicrousd;
    ambiguous += ancestorSpend.ambiguousMicrousd;
  }

  const rootRunId = ancestors.length > 0 ? ancestors[ancestors.length - 1]! : run.id;
  const cumulativeCeilingMicrousd = runLifetimeCeilingMicrousd(db, rootRunId);

  return {
    sourceActualMicrousd: source.settledMicrousd,
    priorReplacementActualMicrousd: priorReplacementActual,
    ambiguousLiabilityMicrousd: ambiguous,
    cumulativeCeilingMicrousd,
  };
}

/**
 * Settled and ambiguous spend for a run, computed directly from cost_records
 * (no mutation, unlike the ledger's lazy budget materialization). Mirrors the
 * ledger snapshot: settled = total recorded cost minus still-open (active or
 * ambiguous) model reservations; ambiguous = the ambiguous reservations.
 */
function runSpendMicrousd(db: Database, runId: string): { settledMicrousd: number; ambiguousMicrousd: number } {
  const total = db.query(
    "SELECT COALESCE(SUM(estimated_cost_usd),0) AS cost FROM cost_records WHERE run_id=?",
  ).get(runId) as { cost: number };
  const open = db.query(
    `SELECT COALESCE(SUM(estimated_cost_usd),0) AS reserved,
       COALESCE(SUM(CASE WHEN reservation_status='AMBIGUOUS_PROVIDER_OUTCOME' THEN estimated_cost_usd ELSE 0 END),0) AS ambiguous
     FROM cost_records WHERE run_id=? AND source_type='MODEL_RESERVATION'
       AND reservation_status IN ('ACTIVE','AMBIGUOUS_PROVIDER_OUTCOME')`,
  ).get(runId) as { reserved: number; ambiguous: number };
  const settled = Math.max(0, Math.round(Number(total.cost) * MICRO) - Math.round(Number(open.reserved) * MICRO));
  const ambiguous = Math.round(Number(open.ambiguous) * MICRO);
  return { settledMicrousd: settled, ambiguousMicrousd: ambiguous };
}

function runLifetimeCeilingMicrousd(db: Database, runId: string): number {
  const row = db.query("SELECT lifetime_cost_limit_usd FROM run_budgets WHERE run_id=?").get(runId) as
    | { lifetime_cost_limit_usd: number }
    | null;
  return row ? Math.round(Number(row.lifetime_cost_limit_usd) * MICRO) : 0;
}

/**
 * Walk the resolution lineage upward: the parent of run R is the source run of
 * the case whose replacement R is. Returns ancestors nearest-first, ending at
 * the root. Bounded depth guards against any malformed cycle.
 */
function collectResolutionAncestors(db: Database, runId: string): string[] {
  const ancestors: string[] = [];
  const seen = new Set<string>([runId]);
  let current = runId;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const parent = db.query(
      `SELECT c.source_run_id AS source_run_id
       FROM resolution_replacements rr JOIN resolution_cases c ON c.id=rr.case_id
       WHERE rr.replacement_run_id=? LIMIT 1`,
    ).get(current) as { source_run_id: string } | null;
    if (!parent) break;
    if (seen.has(parent.source_run_id)) break;
    ancestors.push(parent.source_run_id);
    seen.add(parent.source_run_id);
    current = parent.source_run_id;
  }
  return ancestors;
}
