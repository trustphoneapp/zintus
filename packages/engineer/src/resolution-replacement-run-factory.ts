import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "./hash.js";
import type { ReplacementRunCreationPlan, ReplacementRunFactory } from "./resolution-desk.js";

// ---------------------------------------------------------------------------
// P7 P1-B: the real executable-replacement factory (Day 3 pair 3).
//
// The ResolutionDesk owns the fenced PREPARING -> READY scaffold and calls this
// factory strictly between the PREPARING insert and the READY flip, ON ITS OWN
// open connection/transaction. This factory therefore does RAW inserts on the
// passed `db` and NEVER opens a transaction of its own: run creation is atomic
// with the scaffold (a crash before the desk commits rolls the run, the
// scaffold, and the case transition back together — no executable orphan can
// outlive a PREPARING row). Sharing the desk's single connection is load-bearing;
// going through a separately-connected supervisor would create the run in an
// independent transaction and break that atomicity.
//
// The row shape is the ledger `createRun` equivalent (engineer_runs at the
// REQUEST_RECEIVED start state, an ACTIVE run_budgets row, a RUN_CREATED audit
// event). It deliberately does NOT insert task_manifest_versions: the ordinary
// Supervisor normalize -> plan -> freeze lifecycle owns manifest v1 and its
// Required Lane contract. Nothing is inherited from the source run: the
// replacement run id is brand new, so it has zero agent_executions, failures,
// approvals, git operations, checkpoints, evidence, or reservations. Lineage is
// carried entirely by the `resolution_replacements` row the desk writes
// (case -> directive -> replacementRunId); engineer_runs has no lineage column.
// ---------------------------------------------------------------------------

export interface ResolutionReplacementRunFactoryOptions {
  /** Injected clock, shared with the desk so the scaffold and the run agree. */
  readonly now?: () => Date;
}

interface SourceRunRow {
  base_branch: string;
  request_original: string;
  risk_tier: string;
  human_gate_required: number;
}

export class ResolutionReplacementRunFactory implements ReplacementRunFactory {
  private readonly now: () => Date;

  constructor(options: ResolutionReplacementRunFactoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  createReplacementRun(db: Database, plan: ReplacementRunCreationPlan): void {
    const at = this.now().toISOString();

    // Idempotent on the deterministic replacement run id: a replay of the same
    // apply must not double-insert (the desk already dedupes by directive, but
    // the factory guards its own writes so it is safe under any re-entry).
    const existing = db.query("SELECT id FROM engineer_runs WHERE id=?").get(plan.replacementRunId) as { id: string } | null;
    if (existing) return;

    // Inherit the source run's request text, base branch, and risk gating — the
    // replacement is the SAME work under a corrected scope, not a new intake.
    const source = db.query("SELECT base_branch,request_original,risk_tier,human_gate_required FROM engineer_runs WHERE id=?")
      .get(plan.sourceRunId) as SourceRunRow | null;
    if (!source) throw new Error(`resolution replacement factory: source run ${plan.sourceRunId} is missing`);

    // engineer_runs at the state-machine start (REQUEST_RECEIVED, version 0). No
    // manifest exists until the ordinary planner freezes a valid TaskManifest v1.
    db.query(`INSERT INTO engineer_runs
        (id, user_id, repository_id, base_branch, base_commit_sha,
         request_original, request_normalized, state, state_version,
         manifest_hash, risk_tier, human_gate_required, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '', 'REQUEST_RECEIVED', 0, NULL, ?, ?, ?, ?)`)
      .run(
        plan.replacementRunId, plan.ownerUserId, plan.repositoryId, source.base_branch, plan.baseCommitSha,
        source.request_original, source.risk_tier, source.human_gate_required, at, at,
      );

    // Fresh budget from the directive's ReplacementBudget (NOT the source's spend).
    const costLimitUsd = plan.budget.maxCostMicrousd / 1_000_000;
    const tokenLimit = plan.budget.maxTokens;
    const timeLimit = plan.budget.maxActiveSeconds;
    db.query(`INSERT INTO run_budgets
        (run_id, cost_limit_usd, token_limit, time_limit_seconds,
         lifetime_cost_limit_usd, lifetime_token_limit, lifetime_time_limit_seconds,
         status, active_since, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`)
      .run(
        plan.replacementRunId, costLimitUsd, tokenLimit, timeLimit,
        costLimitUsd, tokenLimit, timeLimit, at, at, at,
      );

    // Audit trail, mirroring ledger.createRun's RUN_CREATED row so the durable
    // history shows a real run-creation, tagged with its resolution lineage.
    db.query(`INSERT INTO audit_events (id, run_id, action, actor_type, actor_id, details_json, created_at)
        VALUES (?, ?, 'RUN_CREATED', 'SYSTEM', 'engineer-resolution-desk', ?, ?)`)
      .run(randomUUID(), plan.replacementRunId, canonicalJson({
        repositoryId: plan.repositoryId,
        baseCommitSha: plan.baseCommitSha,
        resolutionCaseId: plan.caseId,
        resolutionDirectiveId: plan.directiveId,
        resolutionKind: plan.kind,
        sourceManifestHash: plan.sourceManifestHash,
        sourceRequiredLaneContractHash: plan.requiredLaneContractHash,
        correctionBlockerIds: plan.blockers.map((blocker) => blocker.blockerId),
        manifestLifecycle: "SUPERVISOR_PLAN_FREEZE_V1",
      }), at);
  }
}
