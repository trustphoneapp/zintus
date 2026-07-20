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

/**
 * Finding #6 (legacy-run migration completeness). The R5F-2 retirement made the
 * legacy human-gate approval lane an honest `410 GONE` (see the gateway's
 * `LegacyApprovalLaneRetiredError`), which points stranded runs at the
 * Developer Resolution Desk. But a HISTORICAL run parked at either non-terminal
 * legacy gate — `HUMAN_APPROVAL_PENDING` (a verified candidate waiting on a
 * human approval that the retired lane can no longer deliver) or
 * `BASE_BRANCH_STALE` (a candidate whose base moved) — could neither use the
 * retired path (410) NOR open a case (the desk required a TERMINAL run), leaving
 * it readable-but-unrecoverable.
 *
 * These two states are ADOPTABLE by the desk because they are exclusively
 * legacy: only the retired `EngineerPublicationManager` ever transitioned a run
 * INTO them (the current P8 `git-publication-mechanics` publication path never
 * does). So any run found in one of these states is necessarily a stranded
 * legacy run, and adopting it cannot hijack a live run. Case creation installs
 * the source freeze (the v31 freeze triggers key off the case row's existence),
 * which is the durable-authority freeze the terminal-only rule otherwise gave us
 * for free — so an adopted legacy run is frozen exactly like a terminal one from
 * the moment its case exists. Every OTHER non-terminal state stays refused.
 *
 * Adoption derives an honest, CORRECTABLE terminal-style blocker (see
 * `strandedStateBackstop`), so the operator's recovery is a real corrected run
 * that re-verifies and can publish through the current surface — never a
 * fabricated defect on unrelated durable evidence, never a raw state mutation.
 */
const ADOPTABLE_LEGACY_STATES: ReadonlySet<string> = new Set([
  "HUMAN_APPROVAL_PENDING",
  "BASE_BRANCH_STALE",
]);

function isAdoptableLegacyState(state: string): boolean {
  return ADOPTABLE_LEGACY_STATES.has(state);
}

/**
 * FINDING B (Luna F-R7-2, INFO → STRUCTURAL guard). Legacy adoption of a run
 * parked in `HUMAN_APPROVAL_PENDING` / `BASE_BRANCH_STALE` rests on the invariant
 * that ONLY the retired `EngineerPublicationManager` ever transitioned a run INTO
 * those states — the live P8 `git-publication-mechanics` path never does. Rather
 * than trust that WIRING argument, we assert it against durable state: a run that
 * carries ANY live P8 publication artifact (a `publication_candidate_selections_v33`
 * row or a `publication_git_operations_v33` row) is NOT a stranded legacy run, so
 * a future re-wiring that let P8 reach an adoptable state could never let case
 * creation hijack a live-P8 publication. Read-only.
 */
function hasLiveP8Publication(db: Database, runId: string): boolean {
  const selection = db
    .query("SELECT 1 FROM publication_candidate_selections_v33 WHERE run_id=? LIMIT 1")
    .get(runId);
  if (selection) return true;
  const operation = db
    .query("SELECT 1 FROM publication_git_operations_v33 WHERE run_id=? LIMIT 1")
    .get(runId);
  return operation !== null;
}

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
  // A case may be opened for a run whose durable authority is frozen: either a
  // TERMINAL run, or a stranded LEGACY-gate run (HUMAN_APPROVAL_PENDING /
  // BASE_BRANCH_STALE) whose only entry path — the retired legacy publication
  // manager — no longer exists, and whose case row installs the source freeze.
  // Every other non-terminal state (a genuinely live run) stays refused.
  if (!isTerminalState(run.state as RunState) && !isAdoptableLegacyState(run.state)) {
    throw new ResolutionDeskError(
      "DERIVATION_RUN_NOT_TERMINAL",
      `a resolution case may only be opened for a terminal or stranded-legacy run; run ${runId} is ${run.state}`,
      409,
      { state: run.state },
    );
  }
  // FINDING B: an adoptable legacy state is only genuinely stranded when NO live
  // P8 publication exists for the run. A run in such a state that ALSO carries a
  // P8 selection/operation is a live-P8 run (a re-wiring hazard, not a legacy
  // remnant) and must NOT be adopted — its authority is not frozen by a case row.
  if (!isTerminalState(run.state as RunState) && hasLiveP8Publication(db, runId)) {
    throw new ResolutionDeskError(
      "DERIVATION_RUN_NOT_TERMINAL",
      `run ${runId} is in a legacy-adoptable state but carries a live P8 publication; it is not a stranded legacy run and cannot be adopted`,
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
  const baseCommitSha = adoptionBaseCommitSha(db, run);

  return {
    sourceRunId: run.id,
    ownerUserId: run.user_id,
    repositoryId: run.repository_id,
    sourceState: run.state,
    sourceStateVersion: run.state_version,
    baseCommitSha,
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

// --- Adoption base commit (R8-3 FINDING 1) ---------------------------------

const COMMIT_SHA = /^[0-9a-f]{40,64}$/i;

/**
 * The base commit the ADOPTED corrected run must plan against.
 *
 * For every state except BASE_BRANCH_STALE the recorded `base_commit_sha` is
 * correct. For a BASE_BRANCH_STALE run it is stale BY DEFINITION — the branch
 * advanced past it — so adopting a corrected run onto it would re-strand at
 * publish (the deleted stale-base bypass re-synced to the advanced HEAD; the
 * desk path must give the same equivalence). The staleness-detecting
 * INSPECT_BASE git operation durably recorded the observed current branch HEAD
 * in its `remote_reference` (see EngineerPublicationManager's base inspection),
 * so we adopt the corrected run onto THAT advanced HEAD.
 *
 * Pure over the durable git_operations table (never a live git call), consistent
 * with the rest of this module. Falls back to the recorded base only when no
 * such durable HEAD observation exists — which is exactly the case that cannot
 * have a guaranteed-stale base to fix (the branch was never re-observed as
 * advanced), so the fallback never re-introduces the regression.
 */
function adoptionBaseCommitSha(db: Database, run: RunRow): string {
  if (run.state !== "BASE_BRANCH_STALE") return run.base_commit_sha;
  const inspected = db.query(
    `SELECT remote_reference FROM git_operations
     WHERE run_id=? AND operation_type='INSPECT_BASE' AND remote_reference IS NOT NULL
     ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  ).get(run.id) as { remote_reference: string } | null;
  const head = inspected?.remote_reference;
  return head && COMMIT_SHA.test(head) ? head : run.base_commit_sha;
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

  // 4. Stranded-state backstop (fail-closed floor). If the run stopped in a
  //    non-success terminal state — OR is a stranded adoptable legacy gate
  //    (HUMAN_APPROVAL_PENDING / BASE_BRANCH_STALE) — yet no BLOCKING blocker was
  //    derived above, we do NOT leave it blocker-free (which would silently read
  //    as "no defect"). We synthesize exactly one BLOCKING blocker from the state.
  const hasBlocking = blockers.some((blocker) => blocker.kind === "BLOCKING");
  if (!hasBlocking && state !== "COMPLETED") {
    blockers.push(strandedStateBackstop(runId, state));
  }

  return blockers;
}

/**
 * Deterministic run-state -> BLOCKING reasonCode floor. Only
 * RETRY_BUDGET_EXHAUSTED keeps its non-recoverable (reject-only) class; every
 * other state maps to a CORRECTABLE reasonCode so correction — never a silent
 * reverify — is the authorized path when the durable cause is unknown. The two
 * adoptable legacy gates map to honest, distinguishable legacy reason codes so
 * the case reads as "stranded at a retired gate, recover by correction" rather
 * than fabricating a defect on the (possibly perfectly good) candidate.
 */
function strandedStateBackstop(runId: string, state: string): CanonicalBlocker {
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
    HUMAN_APPROVAL_PENDING: "LEGACY_HUMAN_APPROVAL_GATE_RETIRED",
    BASE_BRANCH_STALE: "LEGACY_BASE_BRANCH_STALE",
  };
  const reasonCode = reasonByState[state] ?? "RUN_TERMINAL_UNCLASSIFIED";
  const description = isAdoptableLegacyState(state)
    ? truncate(`stranded legacy run state ${state}: the retired legacy approval lane can no longer advance it; adopted as a correctable blocker`)
    : truncate(`terminal run state ${state} with no durable blocker record; failed closed to a blocking correction`);
  return {
    blockerId: `terminal:${runId}:${state}`,
    kind: "BLOCKING",
    reasonCode,
    description,
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
