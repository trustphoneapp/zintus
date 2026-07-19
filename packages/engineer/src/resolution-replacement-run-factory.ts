import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "./hash.js";
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
// event) plus a FRESH manifest freeze derived from the source manifest hash and
// the directive's open blockers. Nothing is inherited from the source run: the
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

/**
 * Deterministically derive the replacement run's fresh manifest hash from the
 * source manifest and the directive's open blockers. It is a NEW freeze (never
 * equal to the source manifest for a non-empty correction), so the replacement
 * plans against its own corrected scope rather than rehydrating the source's.
 */
export function deriveReplacementManifestHash(plan: ReplacementRunCreationPlan): `sha256:${string}` {
  return sha256({
    replacementManifestOf: plan.sourceManifestHash,
    directiveId: plan.directiveId,
    kind: plan.kind,
    blockers: plan.blockers,
  });
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
    // manifest_hash yet on the run row (freeze lives in task_manifest_versions).
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

    // Fresh manifest freeze derived from the source manifest + open blockers.
    const manifestHash = deriveReplacementManifestHash(plan);
    const manifestJson = canonicalJson({
      derivedFromSourceManifest: plan.sourceManifestHash,
      requiredLaneContractHash: plan.requiredLaneContractHash,
      directiveId: plan.directiveId,
      kind: plan.kind,
      blockers: plan.blockers,
    });
    db.query(`INSERT INTO task_manifest_versions (id, run_id, version, manifest_hash, manifest_json, created_at)
        VALUES (?, ?, 1, ?, ?, ?)`)
      .run(`tmv-${plan.replacementRunId}`, plan.replacementRunId, manifestHash, manifestJson, at);

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
        manifestHash,
      }), at);
  }
}
