import type { Database } from "bun:sqlite";
import { canonicalJson, sha256 } from "./hash.js";
import {
  buildCaseAuthority,
  budgetMaxCostMicrousd,
  type CanonicalBlocker,
  CanonicalBlockerSchema,
  type CaseAuthorityInput,
  type DirectiveRequest,
  DirectiveRequestSchema,
  isWithinCumulativeCeiling,
  RESOLUTION_DIRECTIVE_TTL_SECONDS,
  RESOLUTION_EVENT_POLICY_VERSION,
  RESOLUTION_REPLACEMENT_POLICY_VERSION,
  RESOLUTION_SCHEMA_VERSION,
  type ReverifyEligibility,
  signDirective,
  type SignedDirective,
} from "./resolution-case.js";

// ---------------------------------------------------------------------------
// P7 Developer Resolution Desk — durable persistence + orchestration.
//
// A thin, self-contained service over the v31 authority tables. It owns the
// case-creation transaction (which installs the source freeze by writing the
// case row), signed directive creation with case + source CAS versions, exact
// replay / conflict, the root/case cumulative ceiling, and the fenced
// PREPARING -> READY | FAILED replacement scaffold. It never creates the
// executable replacement run itself (that is the supervisor integration seam);
// it links the deterministic replacement run id and fences its own scaffold so
// no crash can expose an orphan executable run.
// ---------------------------------------------------------------------------

export class ResolutionDeskError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly detail?: unknown) {
    super(message);
    this.name = "ResolutionDeskError";
  }
}

export interface CaseCreationInput {
  readonly sourceRunId: string;
  readonly ownerUserId: string;
  readonly repositoryId: string;
  readonly sourceState: string;
  readonly sourceStateVersion: number;
  readonly baseCommitSha: string;
  readonly manifestHash: string;
  readonly requiredLaneContractHash: string;
  readonly blockers: readonly CanonicalBlocker[];
  readonly preVerificationCandidateDigest: `sha256:${string}` | null;
  readonly sourceActualMicrousd: number;
  readonly priorReplacementActualMicrousd: number;
  readonly ambiguousLiabilityMicrousd: number;
  readonly cumulativeCeilingMicrousd: number;
  readonly pricingPolicyDigest: `sha256:${string}`;
  readonly sourceClassExcluded: boolean;
}

/**
 * The immutable plan handed to the executable-replacement factory. The factory
 * must create a real engineer run at its start state with a fresh manifest
 * freeze derived from the source manifest + these open blockers, a fresh budget
 * from the directive's ReplacementBudget, and nothing inherited from the source
 * (no prior evidence, review, approval, or publication row). Lineage is durably
 * captured by the `resolution_replacements` row (case -> directive ->
 * replacementRunId) plus the source binding on the case.
 */
export interface ReplacementRunCreationPlan {
  readonly replacementRunId: string;
  readonly sourceRunId: string;
  readonly caseId: string;
  readonly directiveId: string;
  readonly kind: "CORRECTED" | "REVERIFY";
  readonly ownerUserId: string;
  readonly repositoryId: string;
  readonly baseCommitSha: string;
  readonly sourceManifestHash: string;
  readonly requiredLaneContractHash: string;
  readonly blockers: CanonicalBlocker[];
  readonly budget: { maxCostMicrousd: number; maxTokens: number; maxActiveSeconds: number; pricingPolicyDigest: string };
}

/**
 * The executable-replacement dispatch seam. The desk calls
 * `createReplacementRun` on ITS OWN open connection/transaction, strictly
 * between the fenced `PREPARING` insert and the `READY` flip, so run creation is
 * atomic with the scaffold: a crash before commit rolls back the run, the
 * scaffold, and the case transition together — no executable orphan can outlive
 * it. The factory must be idempotent on `plan.replacementRunId` and must throw
 * to abort the whole apply.
 */
export interface ReplacementRunFactory {
  createReplacementRun(db: Database, plan: ReplacementRunCreationPlan): void;
}

export interface ResolutionCaseView {
  caseId: string;
  runId: string;
  caseVersion: number;
  state: string;
  blockers: CanonicalBlocker[];
  correctionEligible: boolean;
  reverifyEligibility: ReverifyEligibility;
  spending: {
    sourceActualUsd: number;
    priorReplacementActualUsd: number;
    ambiguousLiabilityUsd: number;
    cumulativeCeilingUsd: number;
  };
  pricingPolicyDigest: string;
  preVerificationCandidate?: { present: true; digest: string };
  createdAt: string;
  expiresAt: string;
}

interface CaseRow {
  id: string; source_run_id: string; owner_user_id: string; case_hash: string;
  source_state_version: number; case_version: number; state: string;
  blockers_json: string; correction_eligible: number; reverify_eligible: number; reverify_reason: string;
  pre_verification_candidate_present: number; pre_verification_candidate_digest: string | null;
  source_actual_microusd: number; prior_replacement_actual_microusd: number;
  ambiguous_liability_microusd: number; cumulative_ceiling_microusd: number;
  pricing_policy_digest: string;
  created_at: string; expires_at: string;
}

const MICRO = 1_000_000;

export class ResolutionDesk {
  constructor(
    private readonly db: Database,
    private readonly signingSecret: string,
    private readonly signingKeyId: string,
    private readonly now: () => Date = () => new Date(),
    private readonly replacementRunFactory?: ReplacementRunFactory,
  ) {
    if (!signingSecret) throw new ResolutionDeskError("SIGNING_AUTHORITY_UNAVAILABLE", "resolution directive signing authority is unavailable", 500);
  }

  // --- Case creation (installs the source freeze) --------------------------

  /**
   * Create the canonical case for a terminal source run in one transaction. The
   * case row IS the ledger-wide source freeze (the v31 freeze triggers key off
   * its existence), so a competing path can never race in after this commits.
   * Creation is idempotent on the source run: a second call returns the
   * existing case rather than a second freeze.
   */
  createCase(input: CaseCreationInput): ResolutionCaseView {
    for (const blocker of input.blockers) CanonicalBlockerSchema.parse(blocker);
    const createdAtDate = this.now();
    const createdAt = createdAtDate.toISOString();
    const expiresAt = new Date(createdAtDate.getTime() + 14 * 24 * 3_600 * 1_000).toISOString();
    const caseId = sha256({ resolutionCase: input.sourceRunId, owner: input.ownerUserId });
    const authorityInput: CaseAuthorityInput = {
      caseId,
      sourceRunId: input.sourceRunId,
      ownerUserId: input.ownerUserId,
      repositoryId: input.repositoryId,
      sourceState: input.sourceState,
      sourceStateVersion: input.sourceStateVersion,
      baseCommitSha: input.baseCommitSha,
      manifestHash: input.manifestHash,
      requiredLaneContractHash: input.requiredLaneContractHash,
      blockers: input.blockers,
      preVerificationCandidateDigest: input.preVerificationCandidateDigest,
      spendingMicrousd: {
        sourceActual: input.sourceActualMicrousd,
        priorReplacementActual: input.priorReplacementActualMicrousd,
        ambiguousLiability: input.ambiguousLiabilityMicrousd,
        cumulativeCeiling: input.cumulativeCeilingMicrousd,
      },
      pricingPolicyDigest: input.pricingPolicyDigest,
      sourceClassExcluded: input.sourceClassExcluded,
      createdAt,
      expiresAt,
    };
    const authority = buildCaseAuthority(authorityInput);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.query("SELECT id FROM resolution_cases WHERE source_run_id=?").get(input.sourceRunId) as { id: string } | null;
      if (existing) {
        this.db.exec("COMMIT");
        return this.getCase(existing.id);
      }
      this.db.query(`INSERT INTO resolution_cases
        (id,case_hash,schema_version,policy_version,source_run_id,owner_user_id,repository_id,source_state,source_state_version,
         base_commit_sha,manifest_hash,required_lane_contract_hash,blockers_json,blocker_count,correction_eligible,reverify_eligible,
         reverify_reason,pre_verification_candidate_present,pre_verification_candidate_digest,source_actual_microusd,
         prior_replacement_actual_microusd,ambiguous_liability_microusd,cumulative_ceiling_microusd,pricing_policy_digest,case_version,state,case_json,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'OPEN',?,?,?)`).run(
        authority.caseId, authority.caseHash, RESOLUTION_SCHEMA_VERSION, "engineer-resolution-case-v1",
        input.sourceRunId, input.ownerUserId, input.repositoryId, input.sourceState, input.sourceStateVersion,
        input.baseCommitSha, input.manifestHash, input.requiredLaneContractHash, authority.blockersJson, input.blockers.length,
        authority.correctionEligible ? 1 : 0, authority.reverifyEligibility.eligible ? 1 : 0, authority.reverifyEligibility.reason,
        input.preVerificationCandidateDigest !== null ? 1 : 0, input.preVerificationCandidateDigest,
        input.sourceActualMicrousd, input.priorReplacementActualMicrousd, input.ambiguousLiabilityMicrousd, input.cumulativeCeilingMicrousd,
        input.pricingPolicyDigest, authority.json, createdAt, expiresAt);
      this.appendEvent(authority.caseId, 1, null, "CASE_OPENED", 0, null, "SYSTEM", "engineer-resolution-desk", { caseHash: authority.caseHash });
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
    return this.getCase(authority.caseId);
  }

  // --- Directive creation (signed, CAS, replay / conflict) -----------------

  /**
   * Issue a signed directive. Server-side canonicalization + gateway-held HMAC
   * signing; case + source compare-and-swap versions; fixed TTL. An exact
   * byte-identical replay (same idempotency key, same request fingerprint)
   * returns the original response; a different request under the same key is a
   * `409 conflict`. Corrected directives select every open blocker; reverify /
   * reject select none.
   */
  issueDirective(caseId: string, rawRequest: unknown, idempotencyKey: string): { directive: SignedDirective; case: ResolutionCaseView } {
    const request = DirectiveRequestSchema.parse(rawRequest) as DirectiveRequest;
    if (!idempotencyKey || idempotencyKey.length > 200) throw new ResolutionDeskError("IDEMPOTENCY_KEY_INVALID", "an Idempotency-Key is required", 400);
    const fingerprint = sha256({
      caseId, type: request.type, caseVersion: request.caseVersion,
      sourceRunVersion: request.sourceRunVersion, budget: request.budget ?? null,
    });

    this.db.exec("BEGIN IMMEDIATE");
    this.db.exec("PRAGMA defer_foreign_keys=ON");
    try {
      const replay = this.db.query("SELECT request_fingerprint,response_json FROM resolution_directives WHERE case_id=? AND idempotency_key=?")
        .get(caseId, idempotencyKey) as { request_fingerprint: string; response_json: string } | null;
      if (replay) {
        this.db.exec("COMMIT");
        if (replay.request_fingerprint !== fingerprint) {
          throw new ResolutionDeskError("IDEMPOTENCY_CONFLICT", "a different directive was already recorded for this Idempotency-Key", 409);
        }
        const response = JSON.parse(replay.response_json) as { directive: SignedDirective; case: ResolutionCaseView };
        return response;
      }
      const caseRow = this.requireCaseRow(caseId);
      if (caseRow.state !== "OPEN") throw new ResolutionDeskError("CASE_NOT_OPEN", `case is ${caseRow.state}, not OPEN`, 409);
      if (request.caseVersion !== caseRow.case_version) {
        throw new ResolutionDeskError("CASE_VERSION_CONFLICT", "case version compare-and-swap failed", 409,
          { expected: request.caseVersion, actual: caseRow.case_version });
      }
      if (request.sourceRunVersion !== caseRow.source_state_version) {
        throw new ResolutionDeskError("SOURCE_VERSION_CONFLICT", "source run version compare-and-swap failed", 409,
          { expected: request.sourceRunVersion, actual: caseRow.source_state_version });
      }
      // Directive-type gating against the case's eligibility.
      const blockers = (JSON.parse(caseRow.blockers_json) as CanonicalBlocker[]);
      if (request.type === "CREATE_CORRECTED_RUN" && caseRow.correction_eligible !== 1) {
        throw new ResolutionDeskError("NOT_CORRECTION_ELIGIBLE", "case has no correction-eligible blockers", 409);
      }
      if (request.type === "CREATE_REVERIFY_RUN" && caseRow.reverify_eligible !== 1) {
        throw new ResolutionDeskError("NOT_REVERIFY_ELIGIBLE", `reverify is ineligible: ${caseRow.reverify_reason}`, 409, { reason: caseRow.reverify_reason });
      }
      if (request.type === "CREATE_CORRECTED_RUN" && request.budget) {
        if (request.budget.pricingPolicyDigest !== caseRow.pricing_policy_digest) {
          throw new ResolutionDeskError("PRICING_POLICY_DRIFT", "replacement budget pricing-policy digest does not match the case's current pricing policy", 409,
            { expected: caseRow.pricing_policy_digest, actual: request.budget.pricingPolicyDigest });
        }
        const newCap = budgetMaxCostMicrousd(request.budget);
        if (!isWithinCumulativeCeiling({
          priorReplacementActualMicrousd: caseRow.prior_replacement_actual_microusd,
          ambiguousLiabilityMicrousd: caseRow.ambiguous_liability_microusd,
          newCapMicrousd: newCap,
          cumulativeCeilingMicrousd: caseRow.cumulative_ceiling_microusd,
        })) {
          throw new ResolutionDeskError("CEILING_EXCEEDED", "replacement budget exceeds the root/case cumulative ceiling", 409);
        }
      }

      const createdAtDate = this.now();
      const createdAt = createdAtDate.toISOString();
      const expiresAt = new Date(createdAtDate.getTime() + RESOLUTION_DIRECTIVE_TTL_SECONDS * 1_000).toISOString();
      const directive = signDirective({
        caseId,
        caseHash: caseRow.case_hash as `sha256:${string}`,
        type: request.type,
        expectedCaseVersion: caseRow.case_version,
        expectedSourceRunVersion: caseRow.source_state_version,
        selectedBlockers: request.type === "CREATE_CORRECTED_RUN" ? blockers : [],
        budget: request.budget ?? null,
        createdAt,
        expiresAt,
      }, this.signingSecret, this.signingKeyId);

      // Advance the case: OPEN -> DIRECTIVE_ISSUED (and -> REJECTED_CLOSED for reject).
      const afterIssue = caseRow.case_version + 1;
      this.transitionCase(caseRow, "DIRECTIVE_ISSUED", afterIssue);
      this.appendEventForCase(caseId, "DIRECTIVE_ISSUED", afterIssue, directive.directiveId, { type: request.type });
      if (request.type === "REJECT_AND_CLOSE") {
        const refreshed = this.requireCaseRow(caseId);
        const rejectedVersion = afterIssue + 1;
        this.transitionCase(refreshed, "REJECTED_CLOSED", rejectedVersion);
        this.appendEventForCase(caseId, "CASE_REJECTED", rejectedVersion, directive.directiveId, {});
      }

      const directiveJson = this.directiveJson(directive);
      const view = this.getCaseWithin(caseId);
      const response = { directive, case: view };
      this.db.query(`INSERT INTO resolution_directives
        (id,directive_hash,schema_version,policy_version,case_id,case_hash,type,expected_case_version,expected_source_run_version,
         selected_blockers_json,budget_max_cost_microusd,budget_max_tokens,budget_max_active_seconds,budget_pricing_policy_digest,
         signature_algorithm,signature_key_id,signature,directive_json,idempotency_key,request_fingerprint,response_json,ttl_seconds,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        directive.directiveId, directive.directiveHash, RESOLUTION_SCHEMA_VERSION, "engineer-resolution-directive-v1",
        caseId, directive.caseHash, directive.type, directive.expectedCaseVersion, directive.expectedSourceRunVersion,
        canonicalJson(directive.selectedBlockers),
        directive.budget?.maxCostMicrousd ?? null, directive.budget?.maxTokens ?? null,
        directive.budget?.maxActiveSeconds ?? null, directive.budget?.pricingPolicyDigest ?? null,
        directive.signature.algorithm, directive.signature.keyId, directive.signature.value,
        directiveJson, idempotencyKey, fingerprint, JSON.stringify(response),
        RESOLUTION_DIRECTIVE_TTL_SECONDS, createdAt, expiresAt);
      this.db.exec("COMMIT");
      return response;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  // --- Directive application (fenced replacement scaffold) ------------------

  /**
   * Apply a corrected / reverify directive: scaffold the replacement through the
   * fenced PREPARING -> READY protocol, atomically link the replacement run id,
   * and resolve the case. Concurrent applies resolve to exactly one replacement
   * (UNIQUE(case_id)); the loser replays the winner's result. Reject directives
   * have nothing to apply.
   */
  applyDirective(directiveId: string, idempotencyKey: string): { replacementRunId: string; state: string } {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new ResolutionDeskError("IDEMPOTENCY_KEY_INVALID", "an Idempotency-Key is required", 400);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const directiveRow = this.db.query("SELECT id,case_id,directive_hash,type,expires_at,budget_max_cost_microusd,budget_max_tokens,budget_max_active_seconds,budget_pricing_policy_digest FROM resolution_directives WHERE id=?")
        .get(directiveId) as {
          id: string; case_id: string; directive_hash: string; type: string; expires_at: string;
          budget_max_cost_microusd: number | null; budget_max_tokens: number | null;
          budget_max_active_seconds: number | null; budget_pricing_policy_digest: string | null;
        } | null;
      if (!directiveRow) throw new ResolutionDeskError("DIRECTIVE_NOT_FOUND", "directive not found", 404);
      if (directiveRow.type === "REJECT_AND_CLOSE") throw new ResolutionDeskError("DIRECTIVE_NOT_APPLICABLE", "reject directives have no replacement to apply", 409);

      const existing = this.db.query("SELECT replacement_run_id,state FROM resolution_replacements WHERE directive_id=?")
        .get(directiveId) as { replacement_run_id: string; state: string } | null;
      if (existing) {
        this.db.exec("COMMIT");
        return { replacementRunId: existing.replacement_run_id, state: existing.state };
      }
      if (new Date(directiveRow.expires_at).getTime() <= this.now().getTime()) {
        throw new ResolutionDeskError("DIRECTIVE_EXPIRED", "the directive has expired", 410);
      }

      const kind = directiveRow.type === "CREATE_CORRECTED_RUN" ? "CORRECTED" : "REVERIFY";
      // Fresh replacement budget: corrected directives carry it; reverify inherits
      // no allowance and runs under a zero-cost verification-only ceiling.
      const budget = {
        maxCostMicrousd: directiveRow.budget_max_cost_microusd ?? 0,
        maxTokens: directiveRow.budget_max_tokens ?? 0,
        maxActiveSeconds: directiveRow.budget_max_active_seconds ?? 3_600,
        pricingPolicyDigest: directiveRow.budget_pricing_policy_digest ?? sha256({ reverify: "verification-only" }),
      };
      const replacementRunId = `resolution-${sha256({ directiveId, kind }).slice("sha256:".length, "sha256:".length + 24)}`;
      const replacementId = sha256({ replacement: directiveId });
      const createdAt = this.now().toISOString();
      const replacementJson = canonicalJson({
        replacementId, caseId: directiveRow.case_id, directiveId, kind, replacementRunId, budget,
        policyVersion: RESOLUTION_REPLACEMENT_POLICY_VERSION, schemaVersion: RESOLUTION_SCHEMA_VERSION,
      });
      const replacementHash = sha256({ replacementJson });

      // 1. Advance case DIRECTIVE_ISSUED -> APPLYING.
      const caseRow = this.requireCaseRow(directiveRow.case_id);
      if (caseRow.state !== "DIRECTIVE_ISSUED") throw new ResolutionDeskError("CASE_NOT_DIRECTIVE_ISSUED", `case is ${caseRow.state}`, 409);
      const applyingVersion = caseRow.case_version + 1;
      this.transitionCase(caseRow, "APPLYING", applyingVersion);
      this.appendEventForCase(directiveRow.case_id, "REPLACEMENT_PREPARING", applyingVersion, directiveId, { replacementRunId });

      // 2. Scaffold the replacement in PREPARING (no orphan executable run can
      //    outlive a crash: the row is PREPARING until the run is linked READY).
      this.db.query(`INSERT INTO resolution_replacements
        (id,replacement_hash,schema_version,policy_version,case_id,directive_id,directive_hash,kind,replacement_run_id,state,
         budget_max_cost_microusd,budget_max_tokens,budget_max_active_seconds,budget_pricing_policy_digest,replacement_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'PREPARING', ?,?,?,?,?,?,?)`).run(
        replacementId, replacementHash, RESOLUTION_SCHEMA_VERSION, RESOLUTION_REPLACEMENT_POLICY_VERSION,
        directiveRow.case_id, directiveId, directiveRow.directive_hash, kind, replacementRunId,
        budget.maxCostMicrousd, budget.maxTokens, budget.maxActiveSeconds, budget.pricingPolicyDigest,
        replacementJson, createdAt, createdAt);

      // 3. Executable replacement dispatch (atomic with the fence). When a
      //    factory is wired, create the REAL replacement engineer run here —
      //    between the PREPARING insert and the READY flip, on this same open
      //    transaction — with a fresh manifest freeze derived from the source
      //    manifest + open blockers, a fresh budget from the directive, and zero
      //    inherited evidence/review/approval/publication rows. A crash before
      //    commit rolls the run + scaffold + case transition back together, so no
      //    executable orphan can outlive a PREPARING row.
      if (this.replacementRunFactory) {
        const planRow = this.db.query(
          "SELECT source_run_id,owner_user_id,repository_id,base_commit_sha,manifest_hash,required_lane_contract_hash,blockers_json FROM resolution_cases WHERE id=?",
        ).get(directiveRow.case_id) as {
          source_run_id: string; owner_user_id: string; repository_id: string; base_commit_sha: string;
          manifest_hash: string; required_lane_contract_hash: string; blockers_json: string;
        };
        this.replacementRunFactory.createReplacementRun(this.db, {
          replacementRunId, sourceRunId: planRow.source_run_id, caseId: directiveRow.case_id, directiveId, kind,
          ownerUserId: planRow.owner_user_id, repositoryId: planRow.repository_id, baseCommitSha: planRow.base_commit_sha,
          sourceManifestHash: planRow.manifest_hash, requiredLaneContractHash: planRow.required_lane_contract_hash,
          blockers: JSON.parse(planRow.blockers_json) as CanonicalBlocker[], budget,
        });
      }

      // 4. Fence PREPARING -> READY (only once the run above is linked).
      const readyAt = this.now().toISOString();
      this.db.query("UPDATE resolution_replacements SET state='READY', updated_at=? WHERE id=? AND state='PREPARING'")
        .run(readyAt, replacementId);

      // 5. Resolve the case APPLYING -> RESOLVED_*.
      const resolvedState = kind === "CORRECTED" ? "RESOLVED_CORRECTED" : "RESOLVED_REVERIFIED";
      const resolvedVersion = applyingVersion + 1;
      const applyingRow = this.requireCaseRow(directiveRow.case_id);
      this.transitionCase(applyingRow, resolvedState, resolvedVersion);
      this.appendEventForCase(directiveRow.case_id, "REPLACEMENT_READY", resolvedVersion, directiveId, { replacementRunId });

      this.db.exec("COMMIT");
      return { replacementRunId, state: "READY" };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  // --- Crash recovery (fenced PREPARING orphan resolution) -----------------

  /**
   * Resolve any committed `PREPARING` replacement to `FAILED` (fail closed) and
   * mark its linked engineer run terminal so it can never execute. The happy
   * apply path is a single atomic transaction, so a crash mid-apply rolls back
   * with no committed PREPARING row; this sweep is the deterministic backstop for
   * any PREPARING scaffold that did become durable (e.g. a partially-committed
   * multi-phase future, or a manual/partial state) — it never resurrects a run
   * or completes an unverified replacement. Returns the replacement run ids it
   * resolved.
   */
  recoverPreparingReplacements(): { resolved: string[] } {
    const rows = this.db.query("SELECT id,replacement_run_id FROM resolution_replacements WHERE state='PREPARING'")
      .all() as Array<{ id: string; replacement_run_id: string }>;
    const resolved: string[] = [];
    for (const row of rows) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const at = this.now().toISOString();
        const flipped = this.db.query("UPDATE resolution_replacements SET state='FAILED', updated_at=? WHERE id=? AND state='PREPARING'")
          .run(at, row.id);
        if (flipped.changes !== 1) { this.db.exec("ROLLBACK"); continue; }
        const run = this.db.query("SELECT id,state FROM engineer_runs WHERE id=?")
          .get(row.replacement_run_id) as { id: string; state: string } | null;
        if (run && run.state !== "FAILED") {
          this.db.query("UPDATE engineer_runs SET state='FAILED', last_error='resolution replacement recovery: PREPARING orphan failed closed', terminal_at=?, updated_at=? WHERE id=?")
            .run(at, at, run.id);
        }
        this.db.exec("COMMIT");
        resolved.push(row.replacement_run_id);
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
        throw error;
      }
    }
    return { resolved };
  }

  // --- Reads ---------------------------------------------------------------

  getCase(caseId: string): ResolutionCaseView { return this.getCaseWithin(caseId); }

  listCases(sourceRunId: string): ResolutionCaseView[] {
    const rows = this.db.query("SELECT id FROM resolution_cases WHERE source_run_id=? ORDER BY created_at DESC,id")
      .all(sourceRunId) as Array<{ id: string }>;
    return rows.map((row) => this.getCaseWithin(row.id));
  }

  // --- internals -----------------------------------------------------------

  private getCaseWithin(caseId: string): ResolutionCaseView {
    const row = this.requireCaseRow(caseId);
    const reverifyEligibility: ReverifyEligibility = row.reverify_eligible === 1
      ? { eligible: true, reason: row.reverify_reason as never }
      : { eligible: false, reason: row.reverify_reason as never };
    const view: ResolutionCaseView = {
      caseId: row.id,
      runId: row.source_run_id,
      caseVersion: row.case_version,
      state: row.state,
      blockers: JSON.parse(row.blockers_json) as CanonicalBlocker[],
      correctionEligible: row.correction_eligible === 1,
      reverifyEligibility,
      spending: {
        sourceActualUsd: row.source_actual_microusd / MICRO,
        priorReplacementActualUsd: row.prior_replacement_actual_microusd / MICRO,
        ambiguousLiabilityUsd: row.ambiguous_liability_microusd / MICRO,
        cumulativeCeilingUsd: row.cumulative_ceiling_microusd / MICRO,
      },
      pricingPolicyDigest: row.pricing_policy_digest,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
    if (row.pre_verification_candidate_present === 1 && row.pre_verification_candidate_digest) {
      view.preVerificationCandidate = { present: true, digest: row.pre_verification_candidate_digest };
    }
    return view;
  }

  private requireCaseRow(caseId: string): CaseRow {
    const row = this.db.query(`SELECT id,source_run_id,owner_user_id,case_hash,source_state_version,case_version,state,blockers_json,
      correction_eligible,reverify_eligible,reverify_reason,pre_verification_candidate_present,pre_verification_candidate_digest,
      source_actual_microusd,prior_replacement_actual_microusd,ambiguous_liability_microusd,cumulative_ceiling_microusd,pricing_policy_digest,created_at,expires_at
      FROM resolution_cases WHERE id=?`).get(caseId) as CaseRow | null;
    if (!row) throw new ResolutionDeskError("CASE_NOT_FOUND", "resolution case not found", 404);
    return row;
  }

  private transitionCase(row: CaseRow, nextState: string, nextVersion: number): void {
    const result = this.db.query("UPDATE resolution_cases SET state=?, case_version=? WHERE id=? AND state=? AND case_version=?")
      .run(nextState, nextVersion, row.id, row.state, row.case_version);
    if (result.changes !== 1) throw new ResolutionDeskError("CASE_TRANSITION_RACE", "case transition lost a race", 409);
  }

  private appendEventForCase(caseId: string, eventType: string, caseVersion: number, directiveId: string | null, extra: Record<string, unknown>): void {
    const last = this.db.query("SELECT sequence,event_hash FROM resolution_events WHERE case_id=? ORDER BY sequence DESC LIMIT 1")
      .get(caseId) as { sequence: number; event_hash: string } | null;
    const sequence = (last?.sequence ?? 0) + 1;
    this.appendEvent(caseId, sequence, last?.event_hash ?? null, eventType, caseVersion, directiveId, "SYSTEM", "engineer-resolution-desk", extra);
  }

  private appendEvent(
    caseId: string, sequence: number, previousEventHash: string | null, eventType: string,
    caseVersion: number, directiveId: string | null, actorType: string, actorId: string, extra: Record<string, unknown>,
  ): void {
    const createdAt = this.now().toISOString();
    const base = {
      caseId, sequence, previousEventHash, eventType, caseVersion,
      directiveId, actorType, actorId, createdAt,
      policyVersion: RESOLUTION_EVENT_POLICY_VERSION, schemaVersion: RESOLUTION_SCHEMA_VERSION, ...extra,
    };
    const eventHash = sha256(base);
    const eventId = sha256({ eventHash, sequence });
    const payload = canonicalJson({ ...base, eventId, eventHash });
    this.db.query(`INSERT INTO resolution_events
      (id,event_hash,schema_version,policy_version,case_id,sequence,previous_event_hash,event_type,case_version,directive_id,actor_type,actor_id,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      eventId, eventHash, RESOLUTION_SCHEMA_VERSION, RESOLUTION_EVENT_POLICY_VERSION, caseId, sequence,
      previousEventHash, eventType, caseVersion, directiveId, actorType, actorId, payload, createdAt);
  }

  private directiveJson(directive: SignedDirective): string {
    return canonicalJson({
      directiveId: directive.directiveId,
      directiveHash: directive.directiveHash,
      schemaVersion: directive.schemaVersion,
      policyVersion: directive.policyVersion,
      caseId: directive.caseId,
      caseHash: directive.caseHash,
      type: directive.type,
      expectedCaseVersion: directive.expectedCaseVersion,
      expectedSourceRunVersion: directive.expectedSourceRunVersion,
      selectedBlockers: directive.selectedBlockers,
      budget: directive.budget,
      ttlSeconds: directive.ttlSeconds,
      createdAt: directive.createdAt,
      expiresAt: directive.expiresAt,
    });
  }
}
