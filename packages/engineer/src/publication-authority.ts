import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sha256 } from "./hash.js";
import type { CompanionLineageVerifierInput } from "./resolution-lineage.js";

/**
 * P8 publication authority (live, migration v33).
 *
 * This is the integrated form of the P8 publication-authority draft. The five
 * additive record families it operates on are created by
 * `ENGINEER_DATABASE_MIGRATION_33_SQL` in the live migration chain (no longer a
 * standalone `applyDraftMigration33`). The `CompanionLineageVerifier` seam is
 * filled by the real `ResolutionLineageVerifier` (packages/engineer/src/
 * resolution-lineage.ts), which the ledger already constructs at every authority
 * site; its `verifyReplacementLineage` method matches this seam byte-for-byte, so
 * a replacement-run candidate is never publishable without verified P7 lineage.
 *
 * Structural guarantees preserved from the draft (each proven RED-without-guard
 * in publication-authority.test.ts):
 *   - Single-use approvals: partial unique index on approval_id (rev-0) + an
 *     APPROVED->CONSUMED CAS in the same txn as publication creation.
 *   - Server-derived approver + selection-bound requester (no client actor fields).
 *   - Ambiguous remote outcome parks in RECONCILING with a durable record and is
 *     NEVER auto-redispatched.
 */
export const PUBLICATION_AUTHORITY_POLICY_VERSION = "engineer-publication-authority-v33";

// ---------------------------------------------------------------------------
// Frozen §3 API shapes
// ---------------------------------------------------------------------------

export type CandidateLineage = "ORIGINAL" | "P7_REPLACEMENT";
export type PublicationState = "PREFLIGHT" | "DISPATCHED" | "RECEIPTED" | "RECONCILING" | "FAILED";

/** §3 `GET /publication-candidates` element. */
export interface PublicationCandidate {
  readonly checkpointId: string;
  readonly checkpointHash: string;
  readonly lineage: CandidateLineage;
  readonly lineageVerified: boolean;
}

/** §3 `GET /publications/:publicationId`. */
export interface PublicationView {
  readonly publicationId: string;
  readonly state: PublicationState;
  readonly receipt?: { readonly prUrl: string; readonly commitSha: string };
  readonly reconciliation?: { readonly reason: string; readonly observedRemoteState: string };
}

// ---------------------------------------------------------------------------
// Seams the integrator fills. The real implementations drop in with zero
// changes to the call sites below.
// ---------------------------------------------------------------------------

/**
 * The companion-aware replacement-lineage verifier P7 ships
 * (`ResolutionLineageVerifier.verifyReplacementLineage`). This authority imports
 * it and NEVER re-implements it (§3). When it is absent, throws, or returns
 * `false`, the candidate is ineligible: there is NO fallback path. The input
 * shape is the real `CompanionLineageVerifierInput` so the real verifier binds
 * with no adapter.
 */
export interface CompanionLineageVerifier {
  verifyReplacementLineage(input: CompanionLineageVerifierInput): boolean | Promise<boolean>;
}

/**
 * Opaque GitHub publication credentials. These never enter model/sandbox
 * context and never touch candidate/selection/approval reads: the actuator is
 * the only holder, and only after approval validation (see `dispatch`).
 */
export interface PublicationCredentials {
  readonly token: string;
}

export interface PublicationCredentialProvider {
  /** Invoked only inside `dispatch`, after the approval is revalidated live. */
  getPublicationCredentials(input: {
    readonly approvalId: string;
    readonly repositoryId: string;
  }): PublicationCredentials | Promise<PublicationCredentials>;
}

/** Deterministic branch/base/repo probe used by preflight, immediately before Git effects. */
export interface RepositoryPreflightProbe {
  probe(input: {
    readonly repositoryId: string;
    readonly baseCommitSha: string;
  }): { repositoryId: string; baseCommitSha: string } | Promise<{ repositoryId: string; baseCommitSha: string }>;
}

export type ActuatorOutcome =
  | { readonly kind: "RECEIPT"; readonly prUrl: string; readonly commitSha: string }
  | { readonly kind: "AMBIGUOUS"; readonly observedRemoteState: string; readonly detail: string }
  | { readonly kind: "FAILED"; readonly detail: string };

/** Credentialed publication actuator. Credentials arrive ONLY here, post-approval. */
export interface PublicationActuator {
  createBranchPr(
    input: {
      readonly runId: string;
      readonly publicationId: string;
      readonly repositoryId: string;
      readonly baseCommitSha: string;
      readonly resultCommitSha: string;
      readonly idempotencyKey: string;
    },
    credentials: PublicationCredentials,
  ): Promise<ActuatorOutcome>;
}

// ---------------------------------------------------------------------------
// Errors (draft equivalents of the frozen HTTP statuses)
// ---------------------------------------------------------------------------

export class SelfApprovalError extends Error {
  readonly httpStatus = 403;
  readonly code = "SELF_APPROVAL";
  constructor() { super("requester and approver are the same actor identity"); this.name = "SelfApprovalError"; }
}
export class StaleCandidateError extends Error {
  readonly httpStatus = 409;
  readonly code = "STALE_CANDIDATE";
  constructor() { super("candidate checkpoint id/hash no longer matches an eligible selection"); this.name = "StaleCandidateError"; }
}
export class PreflightMismatchError extends Error {
  readonly httpStatus = 409;
  readonly code = "PREFLIGHT_MISMATCH";
  constructor() { super("branch/base/repo changed during preflight; approval invalidated"); this.name = "PreflightMismatchError"; }
}
export class ApprovalAuthorityInvalidError extends Error {
  readonly httpStatus = 409;
  readonly code = "APPROVAL_AUTHORITY_INVALID";
  constructor(message: string) { super(message); this.name = "ApprovalAuthorityInvalidError"; }
}
export class PublicationStateConflictError extends Error {
  readonly httpStatus = 409;
  readonly code = "PUBLICATION_STATE_CONFLICT";
  constructor(message: string) { super(message); this.name = "PublicationStateConflictError"; }
}
export class ApprovalConsumedError extends Error {
  readonly httpStatus = 409;
  readonly code = "APPROVAL_CONSUMED";
  constructor() { super("approval already authorized a publication; a new PR requires a new approval"); this.name = "ApprovalConsumedError"; }
}
export class PublicationIdempotencyConflictError extends Error {
  readonly httpStatus = 409;
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor() { super("Idempotency-Key was already used to bind a different approval"); this.name = "PublicationIdempotencyConflictError"; }
}

// ---------------------------------------------------------------------------
// Input schemas (frozen §3 bodies; server derives all authority)
// ---------------------------------------------------------------------------

const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const ActorSchema = z.string().min(1).max(200);

const SelectionInputSchema = z.object({
  runId: ActorSchema,
  candidateRunId: ActorSchema,
  requesterUserId: ActorSchema,
  repositoryId: ActorSchema,
  checkpointId: HashSchema,
  checkpointHash: HashSchema,
  resultCommitSha: CommitSchema,
  lineage: z.enum(["ORIGINAL", "P7_REPLACEMENT"]),
  parentSelectionId: z.string().min(1).max(200).nullable(),
}).strict();
export type SelectionInput = z.input<typeof SelectionInputSchema>;

/**
 * §3 request BODY for `POST /publication-candidates/:checkpointId/approvals`.
 * Carries ONLY the browser's choice. It deliberately contains NO actor identity
 * fields (finding A2): requester is derived from the selection row and approver
 * from the server-authenticated context — a client can no longer name either.
 */
const ApprovalDecisionBodySchema = z.object({
  checkpointHash: HashSchema,
  decision: z.enum(["APPROVE", "REJECT"]),
  policyVersion: z.literal(PUBLICATION_AUTHORITY_POLICY_VERSION),
  rationale: z.string().max(4000).nullable().optional(),
  // Present only to prove the self-approval check binds actor identity, not
  // role: role labels are intentionally ignored by the check.
  approverRole: z.string().optional(),
}).strict();
export type ApprovalDecisionBody = z.input<typeof ApprovalDecisionBodySchema>;

/**
 * Server-authenticated approval context. The gateway seam supplies this from
 * the authenticated request principal (`approverActorId`) and from run-derived
 * facts (`implementationActorId`, `evidenceRoot`, `expiresAt`). None of these
 * are client-writable. The gateway MUST NOT populate `approverActorId` from any
 * request body field — only from the verified session principal.
 */
const ApproverAuthContextSchema = z.object({
  approverActorId: ActorSchema,
  implementationActorId: ActorSchema,
  evidenceRoot: HashSchema,
  expiresAt: z.string().min(1),
}).strict();
export type ApproverAuthContext = z.input<typeof ApproverAuthContextSchema>;

const StartPublicationInputSchema = z.object({
  runId: ActorSchema,
  approvalId: ActorSchema,
  operation: z.literal("BRANCH_PR"),
  idempotencyKey: z.string().min(1).max(200),
}).strict();
export type StartPublicationInput = z.input<typeof StartPublicationInputSchema>;

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

interface SelectionRow {
  id: string; run_id: string; candidate_run_id: string; requester_user_id: string; repository_id: string;
  checkpoint_id: string; checkpoint_hash: string; result_commit_sha: string; lineage: CandidateLineage;
  lineage_verified: number; is_hardening_child: number; parent_selection_id: string | null;
}
interface ApprovalRow {
  approval_id: string; revision: number; run_id: string; selection_id: string; checkpoint_id: string;
  checkpoint_hash: string; requester_actor_id: string; approver_actor_id: string; implementation_actor_id: string;
  repository_id: string; base_commit_sha: string; decision: string; status: string; expires_at: string;
}
interface OperationRow {
  publication_id: string; revision: number; run_id: string; approval_id: string; idempotency_key: string;
  requester_actor_id: string; implementation_actor_id: string; repository_id: string; base_commit_sha: string;
  checkpoint_id: string; checkpoint_hash: string; state: PublicationState; resolution_type: string | null; detail: string | null;
}

/**
 * Defense-in-depth self-verify seam (P12 Finding F). Confirms that a selected
 * candidate's `(checkpointId, checkpointHash)` really is a PROMOTED verified
 * candidate in the ledger (`verified_candidate_checkpoints`) for the claimed
 * `candidateRunId` and `resultCommitSha` — so publication safety does NOT rest
 * solely on the gateway facade's pre-check. Absent => not enforced (dev/tests
 * that do not seed real checkpoints); the ledger factory always binds it in prod.
 */
export interface VerifiedCheckpointSelfVerifier {
  isPromotedVerifiedCandidate(input: {
    readonly runId: string;
    readonly candidateRunId: string;
    readonly checkpointId: string;
    readonly checkpointHash: string;
    readonly resultCommitSha: string;
  }): boolean;
}

export interface PublicationAuthorityDeps {
  readonly actuator: PublicationActuator;
  readonly preflight: RepositoryPreflightProbe;
  readonly credentialProvider: PublicationCredentialProvider;
  /** Absent => every P7_REPLACEMENT candidate is ineligible (fail closed). */
  readonly lineageVerifier?: CompanionLineageVerifier;
  /** Absent => the promoted-checkpoint self-verify is not enforced (bound in prod by the ledger factory). */
  readonly checkpointVerifier?: VerifiedCheckpointSelfVerifier;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

/**
 * Live publication authority. Operates directly on a database carrying the v33
 * slice. Mirrors the promotion CAS discipline in `ledger.ts`: every state change
 * is an append-only insert inside `BEGIN IMMEDIATE`, re-reading the current row
 * under the write lock before committing.
 */
export class PublicationAuthorityService {
  constructor(private readonly db: Database, private readonly deps: PublicationAuthorityDeps) {}

  private now(): string { return (this.deps.now ?? (() => new Date()))().toISOString(); }
  private id(): string { return (this.deps.idFactory ?? randomUUID)(); }

  // --- Candidate selection & listing ---------------------------------------

  /**
   * Records a candidate selection, computing `lineageVerified`. ORIGINAL is
   * self-verified. P7_REPLACEMENT is verified ONLY by the injected P7 verifier;
   * absent/throwing/false => `lineageVerified=false` (fail closed, ineligible).
   */
  async selectCandidate(rawInput: SelectionInput): Promise<PublicationCandidate> {
    const input = SelectionInputSchema.parse(rawInput);
    const isChild = input.lineage === "P7_REPLACEMENT";
    if (isChild === (input.parentSelectionId === null)) {
      throw new Error("P7_REPLACEMENT candidates require a parent selection; ORIGINAL candidates forbid one");
    }
    // Defense in depth (P12 Finding F): before recording ANY selection, confirm
    // the candidate checkpoint is a real PROMOTED verified candidate in the
    // ledger. This does not replace the facade pre-check — it ensures the service
    // itself never records a selection over a checkpoint that was never promoted,
    // so safety does not rest solely on the caller.
    if (this.deps.checkpointVerifier &&
        !this.deps.checkpointVerifier.isPromotedVerifiedCandidate({
          runId: input.runId, candidateRunId: input.candidateRunId,
          checkpointId: input.checkpointId, checkpointHash: input.checkpointHash,
          resultCommitSha: input.resultCommitSha,
        })) {
      throw new StaleCandidateError();
    }
    let lineageVerified: boolean;
    if (input.lineage === "ORIGINAL") {
      lineageVerified = true;
    } else {
      lineageVerified = await this.verifyReplacementLineageFailClosed({
        runId: input.runId, candidateRunId: input.candidateRunId,
        parentSelectionId: input.parentSelectionId!, checkpointId: input.checkpointId,
        checkpointHash: input.checkpointHash, resultCommitSha: input.resultCommitSha,
      });
    }
    const createdAt = this.now();
    const content = {
      schemaVersion: 1 as const, policyVersion: PUBLICATION_AUTHORITY_POLICY_VERSION,
      runId: input.runId, candidateRunId: input.candidateRunId, checkpointId: input.checkpointId,
      checkpointHash: input.checkpointHash, resultCommitSha: input.resultCommitSha,
      lineage: input.lineage, lineageVerified: lineageVerified ? 1 : 0,
      isHardeningChild: isChild ? 1 : 0, parentSelectionId: input.parentSelectionId, createdAt,
    };
    const selectionHash = sha256(content);
    const selectionId = sha256({ selectionHash, policyVersion: PUBLICATION_AUTHORITY_POLICY_VERSION });
    const selectionJson = JSON.stringify({ ...content, selectionId, selectionHash });
    this.db.query(`INSERT INTO publication_candidate_selections_v33
      (id, selection_hash, schema_version, policy_version, run_id, candidate_run_id, requester_user_id,
       repository_id, checkpoint_id, checkpoint_hash, result_commit_sha, lineage, lineage_verified,
       is_hardening_child, parent_selection_id, selection_json, created_at)
      VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        selectionId, selectionHash, PUBLICATION_AUTHORITY_POLICY_VERSION, input.runId, input.candidateRunId,
        input.requesterUserId, input.repositoryId, input.checkpointId, input.checkpointHash, input.resultCommitSha,
        input.lineage, lineageVerified ? 1 : 0, isChild ? 1 : 0, input.parentSelectionId, selectionJson, createdAt);
    return { checkpointId: input.checkpointId, checkpointHash: input.checkpointHash, lineage: input.lineage, lineageVerified };
  }

  private async verifyReplacementLineageFailClosed(input: CompanionLineageVerifierInput): Promise<boolean> {
    const verifier = this.deps.lineageVerifier;
    if (!verifier) return false; // no fallback path when the verifier is absent
    try {
      return (await verifier.verifyReplacementLineage(input)) === true;
    } catch {
      return false; // verifier failure => ineligible
    }
  }

  /**
   * §3: eligible candidates only. Hardening children are never listed directly
   * — only parent-linked upgraded candidates whose P7 lineage verified. Every
   * P7_REPLACEMENT requires `lineageVerified=1` (fail closed).
   */
  listPublicationCandidates(runId: string): PublicationCandidate[] {
    const rows = this.db.query(`SELECT * FROM publication_candidate_selections_v33
      WHERE run_id=? ORDER BY created_at DESC, id DESC`).all(runId) as unknown as SelectionRow[];
    return rows
      .filter((row) => {
        if (row.lineage === "ORIGINAL") return row.is_hardening_child === 0 && row.parent_selection_id === null;
        // P7_REPLACEMENT: must be a parent-linked upgraded candidate with verified lineage.
        return row.is_hardening_child === 1 && row.parent_selection_id !== null && row.lineage_verified === 1;
      })
      .map((row) => ({
        checkpointId: row.checkpoint_id, checkpointHash: row.checkpoint_hash,
        lineage: row.lineage, lineageVerified: row.lineage_verified === 1,
      }));
  }

  // --- Approval (three-identity, self-approval fail closed, CAS) ------------

  /**
   * §3 `POST /publication-candidates/:checkpointId/approvals`. The approver
   * identity comes from the server-authenticated `context`, NEVER the body; the
   * requester is derived from the selection's recorded `requester_user_id`
   * (finding A2). `requester === approver` => `403 SELF_APPROVAL`, bound to
   * ACTOR IDENTITY (role labels are ignored). The v33 approval-binding trigger
   * additionally rejects any row whose requester is not the selection's real
   * requester, so a hostile caller cannot forge a mismatch.
   */
  approve(checkpointId: string, rawBody: ApprovalDecisionBody, rawContext: ApproverAuthContext): { approvalId: string; status: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.approveWithinTx(checkpointId, rawBody, rawContext);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve approval failure */ }
      throw error;
    }
  }

  /**
   * The APPROVE body WITHOUT opening its own transaction — the caller MUST
   * already hold an open write transaction on THIS SAME connection. This is the
   * atomicity seam (Sol P1-1): the gateway facade drives `approveWithinTx` AND
   * the ledger's v35 attestation persistence inside ONE transaction over the
   * shared ledger connection, so the P8 approval and its REQUIRED attestation
   * commit together or NOT AT ALL. A crash/throw between the two rolls BOTH back
   * (nested savepoints unwind with the outer transaction), so there is NO durable
   * state where a consumable P8 approval exists without its bound required
   * attestation. All validation, the self-approval fail-closed, and the
   * live-approval CAS run here; a second live APPROVE still fails closed.
   */
  approveWithinTx(checkpointId: string, rawBody: ApprovalDecisionBody, rawContext: ApproverAuthContext): { approvalId: string; status: string } {
    const body = ApprovalDecisionBodySchema.parse(rawBody);
    const context = ApproverAuthContextSchema.parse(rawContext);

    const selection = this.db.query(`SELECT * FROM publication_candidate_selections_v33
      WHERE checkpoint_id=? AND checkpoint_hash=?`).get(checkpointId, body.checkpointHash) as unknown as SelectionRow | null;
    if (!selection || selection.lineage_verified !== 1) throw new StaleCandidateError();

    // Only parent-linked verified replacements or verified originals are eligible.
    const eligible = selection.lineage === "ORIGINAL"
      ? selection.is_hardening_child === 0
      : selection.is_hardening_child === 1 && selection.parent_selection_id !== null;
    if (!eligible) throw new StaleCandidateError();

    // Requester is the selection's recorded owner — not a client-supplied value.
    const requesterActorId = selection.requester_user_id;

    // Self-approval binds actor identity, not role. Enforce here before any DB
    // effect; the DB CHECK + binding trigger are redundant structural backstops.
    if (requesterActorId === context.approverActorId) throw new SelfApprovalError();

    const runRow = this.db.query("SELECT base_commit_sha FROM engineer_runs WHERE id=?")
      .get(selection.run_id) as unknown as { base_commit_sha: string } | null;
    if (!runRow) throw new StaleCandidateError();

    const approvalId = this.id();
    const createdAt = this.now();
    const status = body.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const approvalJson = JSON.stringify({
      approvalId, revision: 0, checkpointId, checkpointHash: body.checkpointHash,
      approver: context.approverActorId, requester: requesterActorId,
    });
    // CAS on (status, checkpointId, checkpointHash, revision): a live APPROVE
    // for this candidate blocks a second one (partial unique index also
    // enforces this at the storage layer). Runs under the caller's write lock.
    const live = this.db.query(`SELECT status FROM publication_approvals_v33
      WHERE checkpoint_id=? AND checkpoint_hash=? AND revision=0 AND decision='APPROVE'`)
      .get(checkpointId, body.checkpointHash) as { status: string } | null;
    if (body.decision === "APPROVE" && live) {
      throw new ApprovalAuthorityInvalidError("candidate already has a live approval decision");
    }
    this.db.query(`INSERT INTO publication_approvals_v33
      (approval_id, revision, run_id, selection_id, checkpoint_id, checkpoint_hash, requester_actor_id,
       requester_actor_kind, approver_actor_id, approver_actor_kind, implementation_actor_id,
       implementation_actor_kind, evidence_root, repository_id, base_commit_sha, policy_version, decision,
       status, invalidation_reason, rationale, expires_at, created_at, approval_json)
      VALUES (?,0,?,?,?,?,?,'HUMAN',?,'HUMAN',?,'NON_HUMAN',?,?,?,?,?,?,NULL,?,?,?,?)`).run(
        approvalId, selection.run_id, selection.id, checkpointId, body.checkpointHash,
        requesterActorId, context.approverActorId, context.implementationActorId, context.evidenceRoot,
        selection.repository_id, runRow.base_commit_sha, PUBLICATION_AUTHORITY_POLICY_VERSION, body.decision,
        status, body.rationale ?? null, context.expiresAt, createdAt, approvalJson);
    return { approvalId, status };
  }

  // --- Publication flow -----------------------------------------------------

  /**
   * §3 `POST /runs/:runId/publications`. Preflight revalidates branch/base/repo
   * immediately before any Git effect; mismatch => `409 PREFLIGHT_MISMATCH` and
   * the approval is invalidated. Duplicate Idempotency-Key can NEVER create a
   * second operation (unique index on revision-0 rows) — the replay returns the
   * original publication.
   */
  async startPublication(rawInput: StartPublicationInput): Promise<PublicationView> {
    const input = StartPublicationInputSchema.parse(rawInput);

    // Idempotency-Key replay: an existing revision-0 operation for this key is
    // the authoritative one; never dispatch a second. A replay that names a
    // DIFFERENT approval is a body/key conflict (finding A3), not a silent
    // no-op.
    const existing = this.db.query(`SELECT publication_id, approval_id FROM publication_git_operations_v33
      WHERE run_id=? AND idempotency_key=? AND revision=0`)
      .get(input.runId, input.idempotencyKey) as { publication_id: string; approval_id: string } | null;
    if (existing) {
      if (existing.approval_id !== input.approvalId) throw new PublicationIdempotencyConflictError();
      return this.getPublication(existing.publication_id);
    }

    const approval = this.currentApproval(input.approvalId);
    if (!approval || approval.run_id !== input.runId) throw new ApprovalAuthorityInvalidError("approval not found for run");
    if (approval.status === "CONSUMED") throw new ApprovalConsumedError();
    if (approval.status !== "APPROVED" || approval.decision !== "APPROVE") {
      throw new ApprovalAuthorityInvalidError(`approval is not live (status ${approval.status})`);
    }
    if (new Date(this.now()).getTime() > new Date(approval.expires_at).getTime()) {
      throw new ApprovalAuthorityInvalidError("approval expired");
    }

    // Preflight immediately before Git effects.
    const observed = await this.deps.preflight.probe({
      repositoryId: approval.repository_id, baseCommitSha: approval.base_commit_sha,
    });
    if (observed.repositoryId !== approval.repository_id || observed.baseCommitSha !== approval.base_commit_sha) {
      this.invalidateApproval(approval, "PREFLIGHT_MISMATCH");
      throw new PreflightMismatchError();
    }

    const publicationId = this.id();
    const createdAt = this.now();
    // The publication row and the approval-consuming transition are written in
    // ONE transaction. The `uq_pub_git_operation_approval_v33` partial unique
    // index makes a second publication under this approval impossible, and the
    // APPROVED->CONSUMED append means every later read sees the spent approval
    // (finding A1). A new PR therefore requires a fresh approval.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.currentApprovalLocked(input.approvalId);
      if (!current || current.status !== "APPROVED") throw new ApprovalConsumedError();
      this.db.query(`INSERT INTO publication_git_operations_v33
        (publication_id, revision, run_id, approval_id, operation_type, idempotency_key, requester_actor_id,
         implementation_actor_id, repository_id, base_commit_sha, checkpoint_id, checkpoint_hash, state,
         prev_state, resolution_type, detail, created_at)
        VALUES (?,0,?,?,'BRANCH_PR',?,?,?,?,?,?,?,'PREFLIGHT',NULL,NULL,NULL,?)`).run(
          publicationId, input.runId, approval.approval_id, input.idempotencyKey, approval.requester_actor_id,
          approval.implementation_actor_id, approval.repository_id, approval.base_commit_sha,
          approval.checkpoint_id, approval.checkpoint_hash, createdAt);
      this.appendApprovalStatusLocked(current, "CONSUMED", `CONSUMED_BY_PUBLICATION:${publicationId}`);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve publication failure */ }
      // A lost unique-approval / unique-idempotency race means someone else
      // already consumed this approval or key: surface the stable conflict.
      if (error instanceof Error && /UNIQUE constraint failed.*approval_id|already consumed/.test(error.message)) {
        throw new ApprovalConsumedError();
      }
      if (error instanceof Error && /UNIQUE constraint failed.*idempotency_key/.test(error.message)) {
        const winner = this.db.query(`SELECT publication_id, approval_id FROM publication_git_operations_v33
          WHERE run_id=? AND idempotency_key=? AND revision=0`)
          .get(input.runId, input.idempotencyKey) as { publication_id: string; approval_id: string } | null;
        if (winner) {
          if (winner.approval_id !== input.approvalId) throw new PublicationIdempotencyConflictError();
          return this.getPublication(winner.publication_id);
        }
      }
      throw error;
    }
    return this.getPublication(publicationId);
  }

  /**
   * Explicit typed resolution of a durable RECONCILING publication (finding
   * A4). This is the ONLY legal successor to RECONCILING; the DB trigger rejects
   * any other. It is never invoked automatically — a human/operator drives it
   * after establishing the true remote state.
   */
  resolveReconciliation(publicationId: string, resolution: "RECEIPTED" | "FAILED", detail: string): PublicationView {
    const current = this.requireCurrentOperation(publicationId);
    if (current.state !== "RECONCILING") {
      throw new PublicationStateConflictError(`resolution requires RECONCILING, not ${current.state}`);
    }
    const resolutionType = resolution === "RECEIPTED" ? "RESOLVED_RECEIPTED" : "RESOLVED_FAILED";
    this.appendTransition(current, resolution, "RECONCILING", detail, resolutionType);
    return this.getPublication(publicationId);
  }

  /**
   * Advances PREFLIGHT -> DISPATCHED, then invokes the credentialed actuator.
   * Credentials are fetched ONLY here, after the approval is revalidated live,
   * and passed ONLY to the actuator — never to candidate/selection reads or the
   * lineage verifier. The DISPATCHED transition is committed BEFORE the remote
   * call so a crash leaves a durable DISPATCHED row: recovery reconciles and
   * never re-dispatches. This closes the double-PR window (publication-manager
   * finding 4).
   */
  async dispatch(publicationId: string): Promise<PublicationView> {
    const current = this.requireCurrentOperation(publicationId);
    if (current.state === "DISPATCHED") {
      // Already dispatched (a prior crash/return). Do NOT re-dispatch.
      return this.resume(publicationId);
    }
    if (current.state !== "PREFLIGHT") {
      throw new PublicationStateConflictError(`dispatch requires PREFLIGHT, not ${current.state}`);
    }
    // The approval was CONSUMED by this very publication at startPublication.
    // It must not have been INVALIDATED (which consumption forbids anyway).
    const approval = this.currentApproval(current.approval_id);
    if (!approval || approval.status === "INVALIDATED" || approval.status === "REJECTED") {
      throw new ApprovalAuthorityInvalidError("approval is no longer live at dispatch");
    }

    // CAS PREFLIGHT -> DISPATCHED (append-only), committed before any remote call.
    this.appendTransition(current, "DISPATCHED", "PREFLIGHT", null);

    const dispatched = this.requireCurrentOperation(publicationId);
    const credentials = await this.deps.credentialProvider.getPublicationCredentials({
      approvalId: approval.approval_id, repositoryId: approval.repository_id,
    });
    let outcome: ActuatorOutcome;
    try {
      outcome = await this.deps.actuator.createBranchPr({
        runId: dispatched.run_id, publicationId, repositoryId: dispatched.repository_id,
        baseCommitSha: dispatched.base_commit_sha, resultCommitSha: this.selectionResultCommit(dispatched),
        idempotencyKey: dispatched.idempotency_key,
      }, credentials);
    } catch (error) {
      // The remote result is unknown and a side effect may already have landed.
      // Leave the durable DISPATCHED row untouched and surface the error: the
      // operation is NEVER re-dispatched. Recovery (`resume`) parks it in
      // RECONCILING. This is exactly what closes the double-PR window — the
      // dispatch is committed before the remote call, so no path re-issues it.
      throw error instanceof Error ? error : new Error(String(error));
    }
    return this.settleOutcome(dispatched, outcome);
  }

  /**
   * Idempotent recovery. A durable DISPATCHED row with no receipt is an
   * ambiguous remote outcome: it parks in RECONCILING with a durable record and
   * is NEVER re-dispatched or rebase-retried. Terminal/reconciling states are
   * returned unchanged.
   */
  resume(publicationId: string): PublicationView {
    const current = this.requireCurrentOperation(publicationId);
    if (current.state === "DISPATCHED") {
      this.parkReconciling(current, "RESTART_UNCERTAIN_DISPATCH",
        "dispatched operation observed without a durable receipt after restart",
        "No remote mutation was retried. Human reconciliation is required.");
      return this.getPublication(publicationId);
    }
    return this.getPublication(publicationId);
  }

  private settleOutcome(operation: OperationRow, outcome: ActuatorOutcome): PublicationView {
    if (outcome.kind === "RECEIPT") {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const receipted = this.appendTransitionLocked(operation, "RECEIPTED", "DISPATCHED", null);
        this.db.query(`INSERT INTO publication_remote_receipts_v33
          (id, publication_id, publication_revision, idempotency_key, pr_url, commit_sha, observed_at, created_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(
            this.id(), operation.publication_id, receipted.revision, operation.idempotency_key,
            outcome.prUrl, outcome.commitSha, this.now(), this.now());
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* preserve settlement failure */ }
        throw error;
      }
      return this.getPublication(operation.publication_id);
    }
    if (outcome.kind === "AMBIGUOUS") {
      this.parkReconciling(operation, "AMBIGUOUS_REMOTE_OUTCOME", outcome.observedRemoteState, outcome.detail);
      return this.getPublication(operation.publication_id);
    }
    this.appendTransition(operation, "FAILED", "DISPATCHED", outcome.detail);
    return this.getPublication(operation.publication_id);
  }

  private parkReconciling(operation: OperationRow, reason: string, observedRemoteState: string, detail: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const parked = this.appendTransitionLocked(operation, "RECONCILING", operation.state, detail);
      // A durable reconciliation record is written exactly once per publication.
      const existing = this.db.query("SELECT id FROM publication_reconciliations_v33 WHERE publication_id=?")
        .get(operation.publication_id) as { id: string } | null;
      if (!existing) {
        this.db.query(`INSERT INTO publication_reconciliations_v33
          (id, publication_id, publication_revision, reason, observed_remote_state, detail, requires_human, created_at)
          VALUES (?,?,?,?,?,?,1,?)`).run(
            this.id(), operation.publication_id, parked.revision, reason, observedRemoteState, detail, this.now());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve reconciliation failure */ }
      throw error;
    }
  }

  /**
   * Supersede a live P8 approval (append an INVALIDATED revision). Used for
   * stale-base recovery: `startPublication`'s preflight, run immediately before
   * any Git effect, invalidates the old hash-bound approval when the base has
   * moved (`PREFLIGHT_MISMATCH`), so no dangling consumable approval survives
   * against a stale base — the replacement path is a fresh selection+approval
   * against the new base. Idempotent: an already-terminal approval is a no-op.
   */
  private invalidateApproval(approval: ApprovalRow, reason: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.currentApprovalLocked(approval.approval_id);
      if (!current || current.status === "INVALIDATED" || current.status === "CONSUMED") { this.db.exec("COMMIT"); return; }
      this.appendApprovalStatusLocked(current, "INVALIDATED", reason);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve invalidation failure */ }
      throw error;
    }
  }

  /** Append a terminal approval status row (INVALIDATED|CONSUMED). Caller holds the write lock. */
  private appendApprovalStatusLocked(current: ApprovalRow, status: "INVALIDATED" | "CONSUMED", reason: string): void {
    const revision = current.revision + 1;
    const approvalJson = JSON.stringify({
      approvalId: current.approval_id, revision, checkpointId: current.checkpoint_id,
      checkpointHash: current.checkpoint_hash, approver: current.approver_actor_id, requester: current.requester_actor_id,
    });
    this.db.query(`INSERT INTO publication_approvals_v33
      (approval_id, revision, run_id, selection_id, checkpoint_id, checkpoint_hash, requester_actor_id,
       requester_actor_kind, approver_actor_id, approver_actor_kind, implementation_actor_id,
       implementation_actor_kind, evidence_root, repository_id, base_commit_sha, policy_version, decision,
       status, invalidation_reason, rationale, expires_at, created_at, approval_json)
      SELECT approval_id, ?, run_id, selection_id, checkpoint_id, checkpoint_hash, requester_actor_id,
       requester_actor_kind, approver_actor_id, approver_actor_kind, implementation_actor_id,
       implementation_actor_kind, evidence_root, repository_id, base_commit_sha, policy_version, decision,
       ?, ?, rationale, expires_at, ?, ?
      FROM publication_approvals_v33 WHERE approval_id=? AND revision=?`).run(
        revision, status, reason, this.now(), approvalJson, current.approval_id, current.revision);
  }

  // --- Recovery enumeration -------------------------------------------------

  /**
   * Boot-recovery seam (R3, finding 1d). Returns the ids of every publication
   * whose CURRENT (max-revision) state is DISPATCHED — i.e. a dispatch that was
   * committed durably but whose remote outcome was never settled (a crash
   * window). The gateway restart loop calls `resume(id)` for each, which parks
   * it in RECONCILING with a durable record and NEVER re-dispatches, so a crash
   * mid-DISPATCHED can never produce a second pull request. Read-only; does not
   * mutate state.
   */
  listResumablePublications(): string[] {
    const rows = this.db.query(`SELECT o.publication_id AS publication_id
      FROM publication_git_operations_v33 o
      WHERE o.revision = (SELECT MAX(revision) FROM publication_git_operations_v33 WHERE publication_id = o.publication_id)
        AND o.state = 'DISPATCHED'
      ORDER BY o.publication_id`).all() as unknown as Array<{ publication_id: string }>;
    return rows.map((row) => row.publication_id);
  }

  // --- View ----------------------------------------------------------------

  getPublication(publicationId: string): PublicationView {
    const operation = this.requireCurrentOperation(publicationId);
    const view: PublicationView = { publicationId, state: operation.state };
    if (operation.state === "RECEIPTED") {
      const receipt = this.db.query("SELECT pr_url, commit_sha FROM publication_remote_receipts_v33 WHERE publication_id=?")
        .get(publicationId) as { pr_url: string; commit_sha: string } | null;
      if (receipt) return { ...view, receipt: { prUrl: receipt.pr_url, commitSha: receipt.commit_sha } };
    }
    if (operation.state === "RECONCILING") {
      const reconciliation = this.db.query("SELECT reason, observed_remote_state FROM publication_reconciliations_v33 WHERE publication_id=?")
        .get(publicationId) as { reason: string; observed_remote_state: string } | null;
      if (reconciliation) {
        return { ...view, reconciliation: { reason: reconciliation.reason, observedRemoteState: reconciliation.observed_remote_state } };
      }
    }
    return view;
  }

  // --- Internal state helpers ----------------------------------------------

  private currentApproval(approvalId: string): ApprovalRow | null {
    return this.db.query(`SELECT * FROM publication_approvals_v33 WHERE approval_id=?
      ORDER BY revision DESC LIMIT 1`).get(approvalId) as unknown as ApprovalRow | null;
  }
  private currentApprovalLocked(approvalId: string): ApprovalRow | null { return this.currentApproval(approvalId); }

  private requireCurrentOperation(publicationId: string): OperationRow {
    const row = this.db.query(`SELECT * FROM publication_git_operations_v33 WHERE publication_id=?
      ORDER BY revision DESC LIMIT 1`).get(publicationId) as unknown as OperationRow | null;
    if (!row) throw new PublicationStateConflictError(`publication ${publicationId} does not exist`);
    return row;
  }

  private selectionResultCommit(operation: OperationRow): string {
    const row = this.db.query(`SELECT result_commit_sha FROM publication_candidate_selections_v33
      WHERE run_id=? AND checkpoint_id=? AND checkpoint_hash=?`)
      .get(operation.run_id, operation.checkpoint_id, operation.checkpoint_hash) as { result_commit_sha: string } | null;
    if (!row) throw new PublicationStateConflictError("publication candidate selection disappeared");
    return row.result_commit_sha;
  }

  /** Append-only CAS transition inside its own IMMEDIATE transaction. */
  private appendTransition(operation: OperationRow, next: PublicationState, expected: PublicationState, detail: string | null, resolutionType: string | null = null): OperationRow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const applied = this.appendTransitionLocked(operation, next, expected, detail, resolutionType);
      this.db.exec("COMMIT");
      return applied;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve transition failure */ }
      throw error;
    }
  }

  /** Append-only CAS transition; caller holds the write lock. */
  private appendTransitionLocked(operation: OperationRow, next: PublicationState, expected: PublicationState, detail: string | null, resolutionType: string | null = null): OperationRow {
    const current = this.requireCurrentOperation(operation.publication_id);
    if (current.state !== expected) {
      throw new PublicationStateConflictError(`expected ${expected} for transition to ${next}, found ${current.state}`);
    }
    const revision = current.revision + 1;
    this.db.query(`INSERT INTO publication_git_operations_v33
      (publication_id, revision, run_id, approval_id, operation_type, idempotency_key, requester_actor_id,
       implementation_actor_id, repository_id, base_commit_sha, checkpoint_id, checkpoint_hash, state,
       prev_state, resolution_type, detail, created_at)
      VALUES (?,?,?,?,'BRANCH_PR',?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        current.publication_id, revision, current.run_id, current.approval_id, current.idempotency_key,
        current.requester_actor_id, current.implementation_actor_id, current.repository_id, current.base_commit_sha,
        current.checkpoint_id, current.checkpoint_hash, next, expected, resolutionType, detail, this.now());
    return { ...current, revision, state: next, resolution_type: resolutionType, detail };
  }
}
