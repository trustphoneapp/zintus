import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { StaleCandidateError } from "@zintus/engineer";
import type { EngineerPrincipal } from "./engineer-identity.js";
import type { EngineerPublicationAuthorityFacade } from "./handler.js";

/**
 * P8 publication-authority gateway facade (real adapter).
 *
 * The routes in handler.ts forward JSON and derive nothing; ALL authority is
 * derived here, server-side, from DURABLE server records keyed by the server-owned
 * principal. The browser may reference a candidate/approval ONLY by an opaque id
 * (checkpointId / approvalId); every authority field is derived, and a body value
 * for a derived field is IGNORED (the derived value always wins). Cross-owner or
 * unknown references collapse to a single not-found shape (no ownership oracle).
 *
 *   - selectCandidate (R2 server-derivation fix): the body is NO LONGER spread into
 *     the service. The browser sends only `checkpointId`. repositoryId,
 *     checkpointHash, resultCommitSha, candidateRunId, the root runId, lineage
 *     (ORIGINAL vs P7_REPLACEMENT) and parentSelectionId are all DERIVED from
 *     `verified_candidate_checkpoints` (the promoted checkpoint row) plus
 *     `resolution_replacements` -> `resolution_cases` for a replacement's lineage.
 *     `requesterUserId` is the principal's ownerId. A checkpoint that is not a
 *     promoted verified-candidate row owned by the principal is not-found. A
 *     P7_REPLACEMENT's lineage is derived (never client-claimed) and remains gated
 *     by the real `ResolutionLineageVerifier` inside the service.
 *   - approve: the checkpointHash is DERIVED from the owner's durable selection row
 *     keyed by checkpointId — NEVER read from the request body. The
 *     `ApproverAuthContext` (approverActorId / implementationActorId / evidenceRoot /
 *     expiresAt) is built from the server principal + run-derived facts, NEVER from
 *     the request body. `approverActorId` is the principal's independent `approverId`
 *     (derived from a SEPARATELY provisioned second-party credential, never the
 *     requester's own secret), distinct from the selection's requester (`ownerId`); a
 *     single install has no such approver and the approve path fails closed (B4). The
 *     strict §3 body carries only the browser's choice
 *     (decision/policyVersion/rationale); the service `.parse`s it (a ZodError
 *     surfaces as a typed 400).
 *   - startPublication: the browser names the approval only by opaque `approvalId`.
 *     The `runId` is DERIVED from the approval's durable row (never the URL), and a
 *     cross-owner approval is not-found. The Idempotency-Key arrives from the HTTP
 *     header (never the body) and is threaded into the service's `idempotencyKey`
 *     seam; `operation` is fixed to BRANCH_PR.
 *
 * Attestation last-mile (item 2 / P11 + P12 Finding A). The v35 provenance
 * attestation binds a ledger `approval_decision`
 * (provenance_attestations.approval_decision_id is UNIQUE + trigger-bound) AND a
 * `resultTreeHash` — the git TREE hash. That tree hash IS now wired (R5F-2): the
 * gateway sources it from the verified candidate's result commit via
 * `GitHubGitService.resolveResultTreeHash` and threads it in through
 * `resultTreeHashFor`, failing CLOSED to null when git cannot source it. Attestation
 * is therefore REQUIRED BY DEFAULT (Sol #7); it is threaded here as
 * `attestationRequired` (`ENGINEER_PROVENANCE_ATTESTATION_REQUIRED`, default
 * REQUIRED; the only escape is the explicit opt-out `=0`):
 *
 *   - attestationRequired = false (EXPLICIT opt-out only, deferred): the pure P8
 *     approval path runs unchanged. This is a documented, audited deferral, NOT a
 *     silent fail-open (see docs/zintus-engineer/KNOWN-LIMITATIONS.md).
 *   - attestationRequired = true (default): a durable APPROVE MUST emit + persist the v35
 *     attestation or fail closed. Feasibility (a PENDING approval_request bound to
 *     this exact verified checkpoint, and a sourced `resultTreeHash`) is checked
 *     BEFORE any write, so an infeasible required-attestation APPROVE fails closed
 *     with a 503 PUBLICATION_ATTESTATION_UNAVAILABLE and NO P8 approval row.
 *     Absence of a required attestation DENIES publication; it never allows an
 *     unattested publish.
 *
 * ATOMICITY (Sol P1-1 / R5C): the P8 approval and its REQUIRED v35 attestation
 * are made GENUINELY ATOMIC — not compensated. The service, the ledger, and this
 * facade all share the SAME `Database` connection (`resolutionDeskConnection()`),
 * so when attestation is required the facade drives BOTH writes inside ONE
 * transaction over that connection: `service.approveWithinTx` inserts the P8
 * approval and `deps.decideApprove` emits+persists the v35 attestation as a
 * nested savepoint on the same connection. A throw or a process CRASH before the
 * outer COMMIT rolls BOTH back together (the approval INSERT is undone with the
 * attestation), so there is NO durable state where a consumable P8 approval
 * exists without its bound required attestation. The INVARIANT is enforced by
 * construction, not by best-effort compensation.
 */

/**
 * Fail-closed error when the P8 approve path has no independent, provisioned approver
 * identity (B4). A single install derives NO usable `approverId`, so it cannot act as
 * its own approver; an explicitly provisioned second-party credential is required. This
 * is the self-approval control enforced on ACTOR IDENTITY (frozen contract §3), surfaced
 * before any durable write.
 */
export class PublicationApproverNotProvisionedError extends Error {
  readonly httpStatus = 403;
  readonly code = "APPROVER_NOT_PROVISIONED";
  constructor() {
    super("publication approval requires an independently provisioned approver; a single install cannot self-approve");
    this.name = "PublicationApproverNotProvisionedError";
  }
}

/** Fail-closed error surfaced when a signer-configured APPROVE cannot emit its v35 attestation. */
export class PublicationAttestationUnavailableError extends Error {
  readonly httpStatus = 503;
  readonly code = "PUBLICATION_ATTESTATION_UNAVAILABLE";
  constructor(detail: string) {
    super(`publication approval is fail-closed: ${detail}`);
    this.name = "PublicationAttestationUnavailableError";
  }
}

/**
 * Single not-found shape for every unresolvable server-derived reference: an
 * unknown checkpoint/approval AND a checkpoint/approval owned by a DIFFERENT
 * principal both surface this identical 404 — so the response is never an
 * ownership oracle. The message is intentionally generic (no derived authority
 * fields are echoed back).
 */
export class CandidateNotFoundError extends Error {
  readonly httpStatus = 404;
  readonly code = "CANDIDATE_NOT_FOUND";
  constructor() {
    super("no such publication candidate for this principal");
    this.name = "CandidateNotFoundError";
  }
}

/** Minimal structural shape of the P8 PublicationAuthorityService the facade drives. */
interface PublicationAuthorityServiceLike {
  listPublicationCandidates(runId: string): unknown;
  selectCandidate(input: unknown): Promise<unknown>;
  approve(checkpointId: string, body: unknown, context: unknown): { approvalId: string; status: string };
  /**
   * Atomicity seam: approve WITHOUT opening a transaction — the caller MUST hold
   * an open write transaction on the shared connection. Lets the facade persist
   * the P8 approval and its REQUIRED v35 attestation in ONE transaction.
   */
  approveWithinTx(checkpointId: string, body: unknown, context: unknown): { approvalId: string; status: string };
  startPublication(input: unknown): Promise<{ publicationId: string; state: string }>;
  getPublication(publicationId: string): { publicationId: string; state: string };
  /** R7-2 durable current-publication projection for a run's owned publication. */
  getCurrentPublicationView(publicationId: string): unknown;
  // R3 dispatch/reconcile/restart seams.
  dispatch(publicationId: string): Promise<{ publicationId: string; state: string }>;
  resume(publicationId: string): Promise<{ publicationId: string; state: string }>;
  resolveReconciliation(
    publicationId: string,
    resolution: "RECEIPTED" | "FAILED",
    detail: string,
    receipt?: { prUrl: string; commitSha: string },
  ): Promise<{ publicationId: string; state: string }>;
  /** R7-3: read-only re-discovery of a RECONCILING publication (auto-confirm or stay). */
  recheckReconciliation(publicationId: string): Promise<{ publicationId: string; state: string }>;
}

/**
 * The [HUMAN] credential boundary. Publication DISPATCH is the credentialed
 * GitHub branch/PR effect; when no GitHub token is configured we withhold the
 * dispatch and keep the publication in PREFLIGHT (re-driveable once the
 * credential is connected), rather than committing DISPATCHED and parking a
 * human-only RECONCILING for a publish that never left the building.
 */
export class PublicationCredentialUnavailableError extends Error {
  readonly httpStatus = 503;
  readonly code = "PUBLICATION_CREDENTIAL_UNAVAILABLE";
  constructor() {
    super("GitHub publication credentials are not configured; connect GitHub before dispatching a publication");
    this.name = "PublicationCredentialUnavailableError";
  }
}

/** A reconcile request whose `resolution` is not the required RECEIPTED|FAILED. */
export class PublicationReconciliationInputError extends Error {
  readonly httpStatus = 400;
  readonly code = "PUBLICATION_RECONCILIATION_INVALID";
  constructor() {
    super("reconciliation resolution must be 'RECEIPTED' or 'FAILED'");
    this.name = "PublicationReconciliationInputError";
  }
}

/**
 * A RECEIPTED reconciliation whose body carries no real receipt. F5: a RECEIPTED
 * resolution MUST carry a genuine receipt (prUrl + a 40/64-hex commitSha) so a
 * RECEIPTED publication can never exist without its durable receipt.
 */
export class PublicationReconciliationReceiptError extends Error {
  readonly httpStatus = 400;
  readonly code = "PUBLICATION_RECONCILIATION_RECEIPT_REQUIRED";
  constructor() {
    super("a RECEIPTED reconciliation must carry a real receipt: { prUrl, commitSha }");
    this.name = "PublicationReconciliationReceiptError";
  }
}

/** Minimal structural shape of the ledger approval_request row the bridge reads. */
interface ApprovalRequestLike {
  approvalRequestId: string;
  status: string;
  approvalRevision: number;
  deadlineAt: string;
  evidenceBundleHash: string;
  verifiedCheckpointId: string | null;
  verifiedCheckpointHash: string | null;
}

export interface PublicationFacadeDeps {
  service: PublicationAuthorityServiceLike;
  principal: EngineerPrincipal;
  /** The ledger's live connection — reads the v33 selection row (server-owned). */
  connection: Database;
  now: () => Date;
  /**
   * Whether a GitHub publication credential is configured. Gates DISPATCH
   * (the credentialed effect) — false ⇒ a fail-closed 503 that leaves the
   * publication in PREFLIGHT. Defaults to true when omitted (older callers).
   */
  credentialAvailable?: boolean;
  /**
   * True when v35 provenance attestation is REQUIRED for a durable APPROVE
   * (REQUIRED BY DEFAULT — `ENGINEER_PROVENANCE_ATTESTATION_REQUIRED` not explicitly
   * opted out AND a signer is configured). When true, the P8 approval and its v35
   * attestation are persisted in ONE transaction over the shared connection (atomic):
   * an APPROVE that cannot emit its attestation fails closed with NOTHING persisted
   * (the approval INSERT is rolled back with the attestation). When false (the
   * EXPLICIT opt-out only), attestation is formally deferred and the pure P8 approval
   * path runs unchanged.
   */
  attestationRequired: boolean;
  /** Reads the run's latest ledger approval_request (the bridge target for the attestation). */
  latestApprovalRequest: (runId: string) => ApprovalRequestLike | null;
  /**
   * Drives `ledger.decideApproval(record, "APPROVED", { resultTreeHash })`, which
   * atomically emits+persists the v35 provenance attestation in the approval's own
   * transaction. Throws on any authority/attestation failure (fail closed).
   */
  decideApprove: (
    record: {
      approvalDecisionId: string; approvalRequestId: string; actorId: string;
      decision: "APPROVE"; reason: string; decidedAt: string;
      expectedApprovalRevision: number; expectedVerifiedCheckpointId: string; expectedVerifiedCheckpointHash: string;
    },
    provenanceContext: { resultTreeHash: string },
  ) => void;
  /**
   * Sources the git tree hash for the candidate's result commit (e.g.
   * `git rev-parse <resultCommitSha>^{tree}`), formatted as `sha256:<64hex>` for the
   * attestation. Returns null when it genuinely cannot be sourced (→ fail closed).
   */
  resultTreeHashFor: (input: { runId: string; resultCommitSha: string }) => string | null;
}

/** The promoted verified-candidate checkpoint row — the durable authority root. */
interface VerifiedCheckpointRow {
  checkpoint_hash: string;
  run_id: string;
  requester_user_id: string;
  repository_id: string;
  result_commit_sha: string;
}

/** The owner-scoped durable selection row used to derive the approve/plan facts. */
interface OwnedSelectionRow {
  run_id: string;
  result_commit_sha: string;
  checkpoint_hash: string;
}

function sha256Hex(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

export function createEngineerPublicationAuthorityFacade(deps: PublicationFacadeDeps): EngineerPublicationAuthorityFacade {
  const { service, principal, connection } = deps;

  // --- Durable server-record reads (all authority is derived here) -----------

  /** The promoted verified-candidate checkpoint, keyed by its opaque id. */
  const readVerifiedCheckpoint = (checkpointId: string): VerifiedCheckpointRow | null =>
    connection
      .query("SELECT checkpoint_hash, run_id, requester_user_id, repository_id, result_commit_sha FROM verified_candidate_checkpoints WHERE id=?")
      .get(checkpointId) as VerifiedCheckpointRow | null;

  /** True iff a candidate run is a durable P7 resolution replacement run. */
  const isResolutionReplacementRun = (candidateRunId: string): boolean =>
    connection
      .query("SELECT 1 FROM resolution_replacements WHERE replacement_run_id=?")
      .get(candidateRunId) !== null;

  /**
   * The durable hardening candidate-lineage attestation for a replacement child
   * checkpoint, keyed by the principal. It binds the child checkpoint to its
   * publication ROOT run (never the frozen resolution source run, which the v37
   * freeze trigger forbids as a selection run_id). Absent => the replacement is
   * not selectable (fail closed).
   */
  const readChildLineageRootRun = (childCheckpointId: string): string | null =>
    (connection
      .query("SELECT root_run_id FROM candidate_lineage_attestations WHERE child_checkpoint_id=? AND requester_user_id=?")
      .get(childCheckpointId, principal.ownerId) as { root_run_id: string } | null)?.root_run_id ?? null;

  /** The principal's ORIGINAL selection for a root run — the required parent of a P7 replacement. */
  const readParentOriginalSelectionId = (rootRunId: string): string | null =>
    (connection
      .query("SELECT id FROM publication_candidate_selections_v33 WHERE run_id=? AND requester_user_id=? AND is_hardening_child=0 ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(rootRunId, principal.ownerId) as { id: string } | null)?.id ?? null;

  /** The principal's durable selection for a checkpoint — derives the checkpointHash for approve. */
  const readOwnedSelection = (checkpointId: string): OwnedSelectionRow | null =>
    connection
      .query("SELECT run_id, result_commit_sha, checkpoint_hash FROM publication_candidate_selections_v33 WHERE checkpoint_id=? AND requester_user_id=? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(checkpointId, principal.ownerId) as OwnedSelectionRow | null;

  /** The run a principal-owned approval binds — derives the startPublication runId. */
  const readOwnedApprovalRun = (approvalId: string): string | null =>
    (connection
      .query("SELECT run_id FROM publication_approvals_v33 WHERE approval_id=? AND requester_actor_id=? ORDER BY revision DESC LIMIT 1")
      .get(approvalId, principal.ownerId) as { run_id: string } | null)?.run_id ?? null;

  /**
   * R3: confirms a publication is owned by the principal. The current
   * (max-revision) operation row's `requester_actor_id` is the P8 requester,
   * which is the selection's `requester_user_id` = the principal's ownerId. An
   * unknown OR cross-owner publication collapses to the SAME not-found shape
   * (no ownership oracle) — never derived from the URL segment.
   */
  const isOwnedPublication = (publicationId: string): boolean =>
    connection
      .query("SELECT requester_actor_id FROM publication_git_operations_v33 WHERE publication_id=? AND requester_actor_id=? ORDER BY revision DESC LIMIT 1")
      .get(publicationId, principal.ownerId) !== null;

  /**
   * R7-2: the principal-owned CURRENT publication_id for a run — the
   * most-recently-touched operation row owned by the principal (its
   * `requester_actor_id` is the P8 requester = the principal's ownerId). An
   * unknown run, a run owned by a DIFFERENT principal, and a run with no
   * publication ALL collapse to the same `null` (no ownership oracle / none
   * result) — the publication_id is never taken from the URL segment.
   */
  const ownedCurrentPublicationId = (runId: string): string | null =>
    // FINDING C (Sol P2-1). Deterministically pick the GENUINELY-current owned
    // publication, not merely the most-recently-touched operation ROW. We reduce to
    // one row per publication (its max revision = current state), then prefer an
    // ACTIVE (non-terminal) publication over any terminal one, tie-breaking by
    // recency. This closes the mis-hydration where a LATE operator transition of an
    // OLDER, already-terminal publication (its new revision carries the newest
    // created_at) would otherwise out-sort a newer, still-active publication on the
    // same run+owner. A run is not expected to hold two concurrently-active
    // publications; if it ever did, the active-first + recency ordering is still
    // deterministic.
    (connection
      .query(`SELECT o.publication_id AS publication_id
        FROM publication_git_operations_v33 o
        WHERE o.run_id=? AND o.requester_actor_id=?
          AND o.revision=(SELECT MAX(m.revision) FROM publication_git_operations_v33 m WHERE m.publication_id=o.publication_id)
        ORDER BY (CASE WHEN o.state IN ('RECEIPTED','FAILED') THEN 1 ELSE 0 END) ASC, o.created_at DESC, o.publication_id DESC
        LIMIT 1`)
      .get(runId, principal.ownerId) as { publication_id: string } | null)?.publication_id ?? null;

  return {
    listCandidates(_p, runId) {
      return service.listPublicationCandidates(runId);
    },

    selectCandidate(_p, _runId, body) {
      const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      // The browser references a candidate ONLY by opaque checkpointId. EVERY
      // authority field is DERIVED from durable server records keyed by the
      // server-owned principal — the request body supplies none of them, so a
      // body-claimed repositoryId / resultCommitSha / lineage / candidateRunId is
      // simply never read (the derived value always wins).
      const checkpointId = typeof record.checkpointId === "string" ? record.checkpointId : "";
      const checkpoint = readVerifiedCheckpoint(checkpointId);
      // The candidate MUST be a PROMOTED verified_candidate_checkpoints row owned by
      // the principal. An unknown checkpoint AND another owner's checkpoint collapse
      // to the SAME not-found shape (no ownership oracle).
      if (!checkpoint || checkpoint.requester_user_id !== principal.ownerId) throw new CandidateNotFoundError();

      if (isResolutionReplacementRun(checkpoint.run_id)) {
        // P7_REPLACEMENT: the candidate's run is a durable resolution replacement
        // run, so lineage is DERIVED as P7_REPLACEMENT — a client can NEVER claim
        // ORIGINAL to skip verification, nor forge the lineage. The publication
        // ROOT run + parent ORIGINAL selection are derived from the durable
        // hardening candidate-lineage attestation (never the frozen source run),
        // and the service gates the candidate through the real
        // ResolutionLineageVerifier. If either durable link is absent, the
        // replacement is not selectable (fail closed).
        const rootRunId = readChildLineageRootRun(checkpointId);
        if (!rootRunId) throw new StaleCandidateError();
        const parentSelectionId = readParentOriginalSelectionId(rootRunId);
        // The original candidate must be selected before its replacement.
        if (!parentSelectionId) throw new StaleCandidateError();
        return service.selectCandidate({
          runId: rootRunId, candidateRunId: checkpoint.run_id, requesterUserId: principal.ownerId,
          repositoryId: checkpoint.repository_id, checkpointId, checkpointHash: checkpoint.checkpoint_hash,
          resultCommitSha: checkpoint.result_commit_sha, lineage: "P7_REPLACEMENT", parentSelectionId,
        });
      }
      // ORIGINAL: root run == candidate run == the checkpoint's own run.
      return service.selectCandidate({
        runId: checkpoint.run_id, candidateRunId: checkpoint.run_id, requesterUserId: principal.ownerId,
        repositoryId: checkpoint.repository_id, checkpointId, checkpointHash: checkpoint.checkpoint_hash,
        resultCommitSha: checkpoint.result_commit_sha, lineage: "ORIGINAL", parentSelectionId: null,
      });
    },

    approve(_p, checkpointId, body) {
      const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const decision = record.decision;

      // The checkpointHash is DERIVED from the principal's durable selection row
      // keyed by checkpointId — NEVER read from the request body. An unknown or
      // cross-owner checkpoint collapses to the SAME not-found shape (no oracle).
      const selection = readOwnedSelection(checkpointId);
      if (!selection) throw new CandidateNotFoundError();
      const checkpointHash = selection.checkpoint_hash;

      // B4: the approver MUST be an independently provisioned second party. `approverId`
      // is derived from a SEPARATE credential (never the requester's own secret); a
      // single install has none (null) and can never self-approve. A null/owner-equal
      // approver fails closed BEFORE any durable write.
      const approverActorId = principal.approverId;
      if (!approverActorId || approverActorId === principal.ownerId) {
        throw new PublicationApproverNotProvisionedError();
      }
      // Rebuild the strict body with the SERVER-DERIVED checkpointHash so a client
      // cannot name a foreign checkpoint hash; decision/policyVersion/rationale (the
      // browser's choice) still flow through and still surface a ZodError as a 400.
      const derivedBody = { ...record, checkpointHash };

      // Server-derived approval context — NEVER the request body. Approver is the
      // principal's independent approverId (a SEPARATELY provisioned second party,
      // distinct from the selection's requester = ownerId).
      const expiresAt = new Date(deps.now().getTime() + 24 * 60 * 60_000).toISOString();

      // Attestation feasibility is checked BEFORE any write so a signer-configured
      // APPROVE that cannot emit fails closed with nothing persisted.
      let attestationPlan: { request: ApprovalRequestLike; resultTreeHash: string } | null = null;
      if (deps.attestationRequired && decision === "APPROVE") {
        const request = deps.latestApprovalRequest(selection.run_id);
        if (!request || request.status !== "PENDING" ||
            request.verifiedCheckpointId !== checkpointId || request.verifiedCheckpointHash !== checkpointHash) {
          throw new PublicationAttestationUnavailableError(
            "no PENDING ledger approval request binds this candidate's verified checkpoint; the v35 attestation cannot be anchored to an approval_decision",
          );
        }
        const resultTreeHash = deps.resultTreeHashFor({ runId: selection.run_id, resultCommitSha: selection.result_commit_sha });
        if (!resultTreeHash) {
          throw new PublicationAttestationUnavailableError(
            "the result tree hash could not be sourced for the candidate's result commit (not durably recorded; git read unavailable)",
          );
        }
        attestationPlan = { request, resultTreeHash };
      }

      const context = {
        approverActorId,
        implementationActorId: principal.safetyIdentifier,
        // evidenceRoot: the bound approval request's evidence bundle when we have a
        // request, else a deterministic candidate-derived root (still a valid
        // sha256 authority tag recorded on the P8 approval row).
        evidenceRoot: attestationPlan
          ? `sha256:${attestationPlan.request.evidenceBundleHash.replace(/^sha256:/, "")}`
          : `sha256:${sha256Hex(checkpointId, checkpointHash)}`,
        expiresAt: attestationPlan ? attestationPlan.request.deadlineAt : expiresAt,
      };

      // Pure P8 approval path (attestation deferred / not an APPROVE): the
      // service opens its own transaction, unchanged.
      if (!attestationPlan || decision !== "APPROVE") {
        return service.approve(checkpointId, derivedBody, context);
      }

      // ATTESTATION REQUIRED: the P8 approval and its v35 attestation are
      // persisted in ONE transaction over the shared ledger connection.
      // `service.approveWithinTx` inserts the approval and `deps.decideApprove`
      // emits+persists the attestation as a nested savepoint on the SAME
      // connection — a throw or a process crash before COMMIT rolls BOTH back
      // together. INVARIANT: no durable state has a consumable P8 approval
      // without its bound required attestation. This replaces the old
      // best-effort compensation (which could leave a live approval on a crash
      // between the two separate transactions).
      const reason = typeof record.rationale === "string" && record.rationale.trim()
        ? record.rationale
        : "Approved via publication authority";
      // `attestationPhase` distinguishes an approval-phase failure (self-approval
      // 403, stale candidate, duplicate — surfaced with its own status) from an
      // attestation-phase failure (→ fail-closed 503). It flips only after the
      // approval INSERT succeeds, and survives the transaction rollback (it is a
      // JS flag, not DB state).
      let attestationPhase = false;
      const runAtomic = connection.transaction(() => {
        const approved = service.approveWithinTx(checkpointId, derivedBody, context);
        attestationPhase = true;
        deps.decideApprove(
          {
            approvalDecisionId: randomUUID(),
            approvalRequestId: attestationPlan.request.approvalRequestId,
            actorId: approverActorId,
            decision: "APPROVE",
            reason,
            decidedAt: deps.now().toISOString(),
            expectedApprovalRevision: attestationPlan.request.approvalRevision,
            expectedVerifiedCheckpointId: checkpointId,
            expectedVerifiedCheckpointHash: checkpointHash,
          },
          { resultTreeHash: attestationPlan.resultTreeHash },
        );
        return approved;
      });
      try {
        return runAtomic();
      } catch (error) {
        if (attestationPhase) {
          // The attestation failed; the ENTIRE transaction — including the P8
          // approval INSERT — rolled back atomically, so NOTHING was persisted.
          // Fail closed: absence of the required attestation denies the approval
          // rather than leaving a consumable one behind.
          throw new PublicationAttestationUnavailableError(
            `the v35 attestation could not be emitted for an approved candidate; the approval was not committed (${
              error instanceof Error ? error.message : String(error)
            })`,
          );
        }
        // An approval-phase error (self-approval, stale candidate, duplicate live
        // approval, ZodError) surfaces with its own status — unchanged.
        throw error;
      }
    },

    async startPublication(_p, _runId, body, idempotencyKey) {
      const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const approvalId = typeof record.approvalId === "string" ? record.approvalId : "";
      // The browser names the approval ONLY by opaque approvalId. The runId is
      // DERIVED from the approval's durable row (never the URL), and a cross-owner or
      // unknown approval collapses to the SAME not-found shape (no oracle). The
      // idempotencyKey comes from the HTTP HEADER (any body idempotencyKey is
      // ignored) and operation is fixed to BRANCH_PR.
      const derivedRunId = readOwnedApprovalRun(approvalId);
      if (!derivedRunId) throw new CandidateNotFoundError();
      return service.startPublication({
        runId: derivedRunId,
        approvalId,
        operation: "BRANCH_PR",
        idempotencyKey,
      });
    },

    getPublication(_p, publicationId) {
      return service.getPublication(publicationId);
    },

    // R7-2 durable current-publication projection. Read-only. The browser names
    // the run only by its opaque runId; the publication_id is DERIVED from the
    // owner-fenced durable operation rows (never the URL), and the whole view is
    // reconstructed from durable state by the service. A run with no owned
    // publication — including an unknown or cross-owner run — returns the SAME
    // `{ publication: null }` none-shape (no ownership oracle). This is what the
    // Approval & publication screen hydrates from on refresh, so React state is
    // never the authority for an in-flight publication.
    getCurrentPublication(_p, runId) {
      const publicationId = ownedCurrentPublicationId(runId);
      if (!publicationId) return { publication: null };
      return { publication: service.getCurrentPublicationView(publicationId) };
    },

    // --- R3 dispatch / restart / reconcile (owner-scoped) -------------------
    // All three name the publication ONLY by opaque publicationId; ownership is
    // derived from the durable operation row (never the URL), and an unknown or
    // cross-owner publication collapses to the same not-found shape.

    async dispatch(_p, publicationId) {
      if (!isOwnedPublication(publicationId)) throw new CandidateNotFoundError();
      // [HUMAN] credential boundary: without a configured GitHub token, withhold
      // the credentialed effect and leave the publication in PREFLIGHT rather
      // than committing DISPATCHED for a publish that cannot reach the remote.
      if (deps.credentialAvailable === false) throw new PublicationCredentialUnavailableError();
      return service.dispatch(publicationId);
    },

    resume(_p, publicationId) {
      if (!isOwnedPublication(publicationId)) throw new CandidateNotFoundError();
      return service.resume(publicationId);
    },

    async resolveReconciliation(_p, publicationId, body) {
      if (!isOwnedPublication(publicationId)) throw new CandidateNotFoundError();
      const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const resolution = record.resolution;
      if (resolution !== "RECEIPTED" && resolution !== "FAILED") {
        throw new PublicationReconciliationInputError();
      }
      const detail = typeof record.detail === "string" && record.detail.trim() ? record.detail : "operator reconciliation";
      if (resolution === "FAILED") {
        return service.resolveReconciliation(publicationId, resolution, detail);
      }
      // F5: a RECEIPTED resolution must carry a real receipt. Validate prUrl +
      // a 40/64-hex commitSha here so the operator establishes the true remote
      // outcome; the service persists it atomically with the RECEIPTED transition.
      // F-L1 (Luna): shape is NOT sufficient — the service additionally BINDS the
      // receipt to this publication (commitSha == the run's verified result commit,
      // and, when discovery confirms, prUrl == the discovered open-draft PR), so a
      // foreign prUrl/commitSha can no longer be persisted verbatim.
      const prUrl = record.prUrl;
      const commitSha = record.commitSha;
      if (typeof prUrl !== "string" || !prUrl.trim() ||
          typeof commitSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commitSha.trim())) {
        throw new PublicationReconciliationReceiptError();
      }
      return service.resolveReconciliation(publicationId, resolution, detail, { prUrl: prUrl.trim(), commitSha: commitSha.trim().toLowerCase() });
    },

    // R7-3 (finding #4): REMOTE RECHECK — an owner-scoped, read-only re-discovery
    // of a RECONCILING publication. No body: the operator supplies nothing; the
    // service re-runs the side-effect-free existing-PR discovery and auto-confirms
    // to RECEIPTED only on a provider-confirmed exact open-draft PR (routed through
    // the same central validator), else leaves it RECONCILING. Ownership is derived
    // from the durable row (never the URL), same 404 collapse as the others.
    async recheckReconciliation(_p, publicationId) {
      if (!isOwnedPublication(publicationId)) throw new CandidateNotFoundError();
      return service.recheckReconciliation(publicationId);
    },
  };
}
