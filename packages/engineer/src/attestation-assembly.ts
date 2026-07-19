import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  createProvenanceAttestation,
  type DsseEnvelope,
  type ProvenanceAttestationInput,
  type ProvenanceSigner,
  type ProvenanceStatement,
} from "./attestation.js";
import {
  VerifiedCandidateCheckpointVersionedSchema,
  type VerifiedCandidateCheckpoint,
  type VerifiedHardeningCandidateCheckpoint,
} from "./verified-candidate-checkpoint.js";
import { EngineerNotFoundError } from "./errors.js";

/**
 * P11 LIVE assembly — build a provenance attestation for an already-persisted
 * verified-candidate checkpoint from the run's REAL durable records:
 *
 *   - subject + contract/commit/test/security/scope digests  ← verified_candidate_checkpoints.checkpoint_json
 *   - roles {role, agentExecutionId, modelTier}              ← agent_executions
 *   - budget {costMicrousd, tokensConsumed, activeSeconds}   ← run_budgets
 *   - P7 replacement lineage (case/directive/replacement)    ← resolution_replacements ⋈ resolution_cases
 *
 * SEAMS (declared, not silently faked):
 *   - `approverUserId` is caller-supplied. At REVIEW_APPROVED promotion NO distinct
 *     human approver exists yet (approval is a later HUMAN_APPROVAL lane keyed to
 *     `approval_decisions.actor_id`). The predicate still HARD-REQUIRES a distinct
 *     approver, so this input must be the real human approver from that later lane;
 *     it is not invented here.
 *   - `resultTreeHash` is caller-supplied. The result git tree hash is NOT durably
 *     recorded for the verified candidate (only the hardening SEED persists a tree
 *     hash), so it must be recomputed from git or threaded by the caller.
 *   - `publicationReceipt` defaults to null. A v33 publication receipt does not
 *     exist until the downstream publish reaches RECEIPTED, so null is the honest
 *     value at/around promotion; a caller may override it once it exists.
 */

const CostRowSchema = z.object({
  used_cost_usd: z.number(),
  used_tokens: z.number().int().nonnegative(),
  used_time_seconds: z.number().int().nonnegative(),
});

export interface PromotionProvenanceOptions {
  /** Real distinct human approver (from the HUMAN_APPROVAL lane). MUST differ from requester. */
  approverUserId: string;
  /** Recomputed-or-threaded result tree hash (`sha256:...`). Not durably recorded — a seam. */
  resultTreeHash: string;
  createdAt: string;
  /** Optional v33 publication receipt once it exists; null/absent at promotion. */
  publicationReceipt?: ProvenanceAttestationInput["publicationReceipt"];
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
}

/**
 * Read the run's real records and shape them into a `ProvenanceAttestationInput`.
 * Throws `EngineerNotFoundError` if the checkpoint id is unknown.
 */
export function assemblePromotionProvenanceInput(
  db: Database,
  checkpointId: string,
  options: PromotionProvenanceOptions,
): ProvenanceAttestationInput {
  const checkpointRow = db
    .query("SELECT checkpoint_json, run_id FROM verified_candidate_checkpoints WHERE id=?")
    .get(checkpointId) as { checkpoint_json: string; run_id: string } | null;
  if (!checkpointRow) throw new EngineerNotFoundError("verified candidate checkpoint", checkpointId);

  const checkpoint: VerifiedCandidateCheckpoint | VerifiedHardeningCandidateCheckpoint =
    VerifiedCandidateCheckpointVersionedSchema.parse(JSON.parse(checkpointRow.checkpoint_json));
  const runId = checkpointRow.run_id;

  // Roles — real durable agent executions for this run.
  const roleRows = db
    .query("SELECT id, role, model_tier FROM agent_executions WHERE run_id=? ORDER BY role, id")
    .all(runId) as Array<{ id: string; role: string; model_tier: string }>;
  const roles = roleRows.map((row) => ({ role: row.role, agentExecutionId: row.id, modelTier: row.model_tier }));

  // Budget — run_budgets stores USD as REAL; convert to integer micro-USD.
  const budgetRow = db
    .query("SELECT used_cost_usd, used_tokens, used_time_seconds FROM run_budgets WHERE run_id=?")
    .get(runId) as Record<string, unknown> | null;
  const cost = budgetRow ? CostRowSchema.parse(budgetRow) : { used_cost_usd: 0, used_tokens: 0, used_time_seconds: 0 };
  const budget = {
    costMicrousd: Math.round(cost.used_cost_usd * 1_000_000),
    tokensConsumed: cost.used_tokens,
    activeSeconds: cost.used_time_seconds,
  };

  // P7 replacement lineage — present iff this run owns a resolution_replacements row.
  let isReplacement = false;
  let replacementLineage: ProvenanceAttestationInput["replacementLineage"] = null;
  if (tableExists(db, "resolution_replacements")) {
    const replacementRow = db
      .query(
        "SELECT id, replacement_hash, case_id, directive_id, directive_hash" +
          " FROM resolution_replacements WHERE replacement_run_id=?",
      )
      .get(runId) as
      | { id: string; replacement_hash: string; case_id: string; directive_id: string; directive_hash: string }
      | null;
    if (replacementRow) {
      const caseRow = db
        .query("SELECT case_hash FROM resolution_cases WHERE id=?")
        .get(replacementRow.case_id) as { case_hash: string } | null;
      if (!caseRow) throw new EngineerNotFoundError("resolution case", replacementRow.case_id);
      isReplacement = true;
      replacementLineage = {
        caseId: replacementRow.case_id,
        caseHash: caseRow.case_hash,
        directiveId: replacementRow.directive_id,
        directiveHash: replacementRow.directive_hash,
        replacementId: replacementRow.id,
        replacementHash: replacementRow.replacement_hash,
      };
    }
  }

  return {
    checkpoint,
    resultTreeHash: options.resultTreeHash,
    isReplacement,
    roles,
    budget,
    approverUserId: options.approverUserId,
    replacementLineage,
    publicationReceipt: options.publicationReceipt ?? null,
    createdAt: options.createdAt,
  };
}

/**
 * Assemble from real records and produce a signed DSSE-wrapped attestation. The
 * predicate schema enforces the distinct-approver control and the P7
 * carries-and-requires-lineage rule at construction time, so a bad approver or a
 * replacement missing lineage throws here rather than producing a bad envelope.
 */
export async function emitPromotionProvenanceAttestation(
  db: Database,
  checkpointId: string,
  options: PromotionProvenanceOptions,
  signer: ProvenanceSigner,
): Promise<{ statement: ProvenanceStatement; statementJson: string; envelope: DsseEnvelope }> {
  const input = assemblePromotionProvenanceInput(db, checkpointId, options);
  return createProvenanceAttestation(input, signer);
}
