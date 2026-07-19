import type { RepositoryReference } from "./contracts.js";
import type { BaseBranchStatus, BranchProtectionEvidence, GitService } from "./git-service.js";
import type {
  ActuatorOutcome,
  PublicationActuator,
  PublicationCredentials,
  PublicationReceiptDiscovery,
  RepositoryPreflightProbe,
} from "./publication-authority.js";

/**
 * GitPublicationMechanics — AUTHORITY-FREE Git publication mechanics beneath P8.
 *
 * This component ports the credentialed Git mechanics that used to live inside
 * the legacy `EngineerPublicationManager` (protected-base preflight, base-SHA
 * recheck, rich PR-body synthesis, deterministic branch/push/PR, existing-PR
 * discovery, and remote reconciliation of an ambiguous outcome) into a
 * standalone unit that the P8 `PublicationAuthorityService` actuator/preflight
 * seams can call.
 *
 * It deliberately owns NO approval, state-machine, attestation, or authority
 * logic: it never imports the legacy manager, never reads or writes run state,
 * and never decides whether a publication is permitted. P8 remains the sole
 * authority; this is the effect layer it drives after it has decided. The only
 * things it touches are the `GitService` (the narrow credential boundary) and
 * two pure resolver seams the composition root fills from server records.
 *
 * The [HUMAN] GitHub-credential boundary is NOT weakened here: whether a token
 * exists at all is enforced upstream in the gateway facade (a missing token
 * withholds dispatch with 503 and leaves the publication in PREFLIGHT). This
 * component only runs once P8 has already committed DISPATCHED and handed it
 * live credentials.
 */

/** Narrative inputs for a rich PR body. All fields come from trusted server records, never Builder text. */
export interface PublicationNarrative {
  readonly requestNormalized: string;
  readonly requestOriginal: string;
  readonly riskTier: string;
  readonly evidenceBundleHash: string;
  readonly acceptanceCriteria: readonly { readonly statement: string }[];
  /** The exact reviewed unified diff. */
  readonly diff: string;
  readonly claims: readonly { readonly status: string; readonly claim: string }[];
}

/** Server-derived, run-scoped facts the actuator needs beyond the P8 operation row. */
export interface GitPublicationContext {
  readonly repository: RepositoryReference;
  readonly title: string;
  readonly narrative: PublicationNarrative;
}

export interface GitPublicationMechanicsDeps {
  readonly gitService: GitService;
  /**
   * Resolves a `repositoryId` to its durable repository reference for preflight
   * inspection. Returns null ONLY when the repository is genuinely unknown.
   */
  readonly resolveRepository: (repositoryId: string) => RepositoryReference | null;
  /**
   * Resolves the run's durable repository + PR title + narrative from server
   * records. Returns null ONLY when the run is genuinely unavailable — a
   * definite pre-remote failure (nothing was written), mapped to FAILED.
   */
  readonly resolvePublicationContext: (runId: string) => GitPublicationContext | null;
  /** Upper bound on the diff embedded in a PR body (GitHub body limit is ~65536). */
  readonly maxDiffBodyChars?: number;
}

export interface BranchProtectionEvaluation {
  readonly enforced: boolean;
  readonly reasons: readonly string[];
}

/** Raised by preflight when the base branch protection is not fully enforced. */
export class BranchProtectionInsufficientError extends Error {
  readonly code = "BRANCH_PROTECTION_INSUFFICIENT";
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`publication blocked: base branch protection is insufficient (${reasons.join("; ")})`);
    this.name = "BranchProtectionInsufficientError";
    this.reasons = reasons;
  }
}

/** Raised by preflight when the repository id cannot be resolved to a real repository. */
export class PublicationRepositoryUnavailableError extends Error {
  readonly code = "PUBLICATION_REPOSITORY_UNAVAILABLE";
  constructor(repositoryId: string) {
    super(`publication blocked: repository ${repositoryId} is unavailable for preflight`);
    this.name = "PublicationRepositoryUnavailableError";
  }
}

/**
 * REAL branch-protection evaluation over the evidence a credentialed
 * `inspectBaseBranch` returns. Reproduces the same conjunction the GitService
 * uses, but surfaces the SPECIFIC failing control so a caller (and its tests)
 * can prove WHICH protection is missing — required reviews, fresh-approval
 * dismissal, strict status checks, admin coverage, or immutable protected
 * history. An unprotected base fails every clause; a base that merely lacks
 * required reviews fails exactly that one.
 */
export function evaluateBranchProtection(protection: BranchProtectionEvidence | undefined): BranchProtectionEvaluation {
  if (!protection) return { enforced: false, reasons: ["branch protection evidence is unavailable"] };
  const reasons: string[] = [];
  if (!protection.protected) reasons.push("base branch is not protected");
  if (!protection.requiresPullRequestReviews) reasons.push("base branch does not require pull request reviews");
  if (protection.requiredApprovingReviewCount < 1) reasons.push("base branch requires zero approving reviews");
  if (!protection.invalidatesStaleApproval) reasons.push("base branch does not invalidate stale approvals on new commits");
  if (!protection.requiresStatusChecks) reasons.push("base branch does not require status checks");
  if (!protection.requiresStrictStatusChecks) reasons.push("base branch does not require strict (up-to-date) status checks");
  if (!protection.enforcesAdmins) reasons.push("base branch protection does not cover administrators");
  if (!protection.blocksForcePushes) reasons.push("base branch permits force pushes over protected history");
  if (!protection.blocksDeletions) reasons.push("base branch permits deletion of protected history");
  return { enforced: reasons.length === 0, reasons };
}

/**
 * Synthesizes a rich PR body from trusted server records only. Includes the
 * normalized request, risk tier, evidence-bundle hash, frozen acceptance
 * criteria, changed files, evidence-backed claims, AND the exact reviewed diff
 * (bounded so an enormous diff never blows the GitHub body limit — when it
 * would, the diff is truncated with an explicit marker and its length noted).
 * Builder narrative is never used.
 */
export function synthesizePublicationPrBody(narrative: PublicationNarrative, maxDiffBodyChars = 60_000): string {
  const changed = [...narrative.diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]);
  const criteria = narrative.acceptanceCriteria.map((item) => `- ${item.statement}`);
  const claims = narrative.claims.map((claim) => `- [${claim.status}] ${claim.claim}`);
  const diffBody = narrative.diff.length > maxDiffBodyChars
    ? `${narrative.diff.slice(0, maxDiffBodyChars)}\n… diff truncated (${narrative.diff.length} bytes total)`
    : narrative.diff.trimEnd();
  return [
    "## Zintus Engineer verified change",
    "",
    narrative.requestNormalized || narrative.requestOriginal,
    "",
    `Risk tier: ${narrative.riskTier}`,
    `Evidence bundle: ${narrative.evidenceBundleHash}`,
    "",
    "### Acceptance criteria",
    ...(criteria.length ? criteria : ["- (none recorded)"]),
    "",
    "### Changed files",
    ...(changed.length ? changed.map((file) => `- ${file}`) : ["- (none)"]),
    "",
    "### Evidence-backed claims",
    ...(claims.length ? claims : ["- (none recorded)"]),
    "",
    "### Verified diff",
    "```diff",
    diffBody,
    "```",
    "",
    "Generated from trusted Zintus system records; Builder narrative was not used.",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function branchProtectionEnforced(status: BaseBranchStatus): boolean {
  // Prefer the detailed evidence (the real GitService path); fall back to the
  // boolean only for alternate adapters that omit it.
  return status.protection ? evaluateBranchProtection(status.protection).enforced : status.protectionEnforced;
}

export class GitPublicationMechanics {
  private readonly deps: GitPublicationMechanicsDeps;
  constructor(deps: GitPublicationMechanicsDeps) {
    this.deps = deps;
  }

  /**
   * P8 `RepositoryPreflightProbe`. Runs the REAL protected-base inspection
   * immediately before the authority service admits the publication:
   *   - an unresolvable repository throws (fail closed);
   *   - a base whose protection is not fully enforced throws
   *     `BranchProtectionInsufficientError` (the echo stub would ACCEPT it);
   *   - a fresh, protected base returns the observed current sha unchanged, so
   *     the authority service's equality check passes;
   *   - a STALE base returns the current remote sha, which differs from the
   *     approval's expected base and the authority service maps to
   *     `PREFLIGHT_MISMATCH` (and invalidates the approval).
   */
  readonly preflightProbe: RepositoryPreflightProbe = {
    probe: (input) => this.preflight(input),
  };

  async preflight(input: { repositoryId: string; baseCommitSha: string }): Promise<{ repositoryId: string; baseCommitSha: string }> {
    const repository = this.deps.resolveRepository(input.repositoryId);
    if (!repository) throw new PublicationRepositoryUnavailableError(input.repositoryId);
    const status = await this.deps.gitService.inspectBaseBranch({
      repository,
      expectedBaseCommitSha: input.baseCommitSha,
    });
    if (!branchProtectionEnforced(status)) {
      const reasons = status.protection ? evaluateBranchProtection(status.protection).reasons : ["base branch protection is not enforced"];
      throw new BranchProtectionInsufficientError(reasons);
    }
    // The current remote sha is the authority. A stale base yields a value that
    // no longer equals the approval's base and is rejected by the service.
    return { repositoryId: input.repositoryId, baseCommitSha: status.currentCommitSha };
  }

  /** P8 `PublicationActuator`, backed by real Git mechanics (never the legacy manager). */
  createActuator(): PublicationActuator {
    return { createBranchPr: (input, credentials) => this.createBranchPr(input, credentials) };
  }

  /**
   * F2 restart-recovery seam. P8's `resume` drives this READ-ONLY discovery for a
   * durable DISPATCHED publication before parking RECONCILING: a crash AFTER the
   * PR was created but BEFORE the receipt was recorded is auto-recovered to
   * RECEIPTED with the discovered PR. This NEVER mutates the remote (no branch,
   * push, or PR create) — it only runs the credentialed, side-effect-free
   * existing-PR discovery. An exact OPEN DRAFT PR => RECEIPT; anything else (none
   * found, repository unavailable) => a non-RECEIPT outcome so P8 parks
   * RECONCILING for a human. It never re-invokes the actuator, so no second PR.
   */
  createReceiptDiscovery(): PublicationReceiptDiscovery {
    return {
      discoverExistingReceipt: async (input) => {
        const repository = this.deps.resolveRepository(input.repositoryId);
        if (!repository) {
          return {
            kind: "AMBIGUOUS",
            observedRemoteState: "REPOSITORY_UNAVAILABLE",
            detail: `repository ${input.repositoryId} is unavailable for restart receipt discovery`,
          };
        }
        const discovered = await this.lookupExistingPr(
          { runId: input.runId, resultCommitSha: input.resultCommitSha, idempotencyKey: input.idempotencyKey },
          repository,
        );
        if (discovered) return { kind: "RECEIPT", prUrl: discovered, commitSha: input.resultCommitSha };
        return {
          kind: "AMBIGUOUS",
          observedRemoteState: "RESTART_NO_RECEIPT_DISCOVERED",
          detail: "no exact OPEN DRAFT pull request was discovered for the dispatched publication",
        };
      },
    };
  }

  private async createBranchPr(
    input: {
      readonly runId: string;
      readonly publicationId: string;
      readonly repositoryId: string;
      readonly baseCommitSha: string;
      readonly resultCommitSha: string;
      readonly idempotencyKey: string;
    },
    credentials: PublicationCredentials,
  ): Promise<ActuatorOutcome> {
    const context = this.deps.resolvePublicationContext(input.runId);
    if (!context) {
      // Nothing has been written to the remote — a clean, terminal failure.
      return { kind: "FAILED", detail: `publication run context unavailable for run ${input.runId}` };
    }
    // Credentials are held only for the effect; never logged, returned, or
    // passed to any resolver/discovery read.
    void credentials;

    // Base-SHA recheck immediately before mutation. A base that advanced (or a
    // base whose protection lapsed) since the authority admitted the
    // publication is a definite pre-remote stop: nothing is written remotely.
    let recheck: BaseBranchStatus;
    try {
      recheck = await this.deps.gitService.inspectBaseBranch({
        repository: context.repository,
        expectedBaseCommitSha: input.baseCommitSha,
      });
    } catch (error) {
      return { kind: "FAILED", detail: `base recheck failed before mutation: ${errorMessage(error)}` };
    }
    if (!recheck.matchesExpected) {
      return {
        kind: "FAILED",
        detail: `base branch advanced to ${recheck.currentCommitSha} before mutation; no remote effect attempted`,
      };
    }
    if (!branchProtectionEnforced(recheck)) {
      return {
        kind: "FAILED",
        detail: "base branch protection is no longer enforced at mutation time; no remote effect attempted",
      };
    }

    // Existing-PR discovery BEFORE creation: a restart or retry that reaches the
    // effect layer again must return the deterministic head/base PR instead of
    // opening a second one.
    const discovered = await this.lookupExistingPr(input, context.repository);
    if (discovered) return { kind: "RECEIPT", prUrl: discovered, commitSha: input.resultCommitSha };

    const body = synthesizePublicationPrBody(context.narrative, this.deps.maxDiffBodyChars);
    try {
      const branch = await this.deps.gitService.createRunBranch({
        runId: input.runId,
        repository: context.repository,
        resultCommitSha: input.resultCommitSha,
      });
      await this.deps.gitService.pushVerifiedCommit({
        runId: input.runId,
        repository: context.repository,
        resultCommitSha: input.resultCommitSha,
        branchName: branch.branchName,
      });
      // F4 (regression from the R5B port): the base can advance — or its
      // protection lapse — between the push and PR creation. The legacy manager
      // re-inspected the base immediately before opening the PR; that mid-flight
      // check was dropped. Re-observe base+protection AFTER push, immediately
      // BEFORE createPullRequest, and fail closed (no PR) if it moved. The pushed
      // branch is a benign dangling ref; NO pull request is opened against a base
      // that is no longer the reviewed/approved one.
      let preCreate: BaseBranchStatus;
      try {
        preCreate = await this.deps.gitService.inspectBaseBranch({
          repository: context.repository,
          expectedBaseCommitSha: input.baseCommitSha,
        });
      } catch (error) {
        return { kind: "FAILED", detail: `base re-inspection failed before PR creation: ${errorMessage(error)}` };
      }
      if (!preCreate.matchesExpected) {
        return {
          kind: "FAILED",
          detail: `base branch advanced to ${preCreate.currentCommitSha} after push, before PR creation; no pull request opened`,
        };
      }
      if (!branchProtectionEnforced(preCreate)) {
        return {
          kind: "FAILED",
          detail: "base branch protection is no longer enforced after push, before PR creation; no pull request opened",
        };
      }
      const pr = await this.deps.gitService.createPullRequest({
        runId: input.runId,
        repository: context.repository,
        branchName: branch.branchName,
        baseBranch: context.repository.baseBranch,
        title: context.title,
        body,
        idempotencyKey: input.idempotencyKey,
      });
      return { kind: "RECEIPT", prUrl: pr.url, commitSha: input.resultCommitSha };
    } catch (error) {
      // The remote result is unknown: a ref or PR may already exist. First try a
      // read-only reconciliation to resolve it to a definite RECEIPT when the PR
      // actually landed; otherwise report AMBIGUOUS so the authority parks
      // RECONCILING for a human. We NEVER auto-redispatch an uncertain effect.
      const reconciled = await this.lookupExistingPr(input, context.repository);
      if (reconciled) return { kind: "RECEIPT", prUrl: reconciled, commitSha: input.resultCommitSha };
      return {
        kind: "AMBIGUOUS",
        observedRemoteState: "REMOTE_OUTCOME_UNKNOWN",
        detail: errorMessage(error),
      };
    }
  }

  /**
   * Read-only discovery/reconciliation of the deterministic head/base PR. Uses
   * the GitService's credentialed, side-effect-free `reconcilePublicationOperation`
   * (CREATE_PR). Returns the PR reference only on an exact SUCCEEDED match;
   * anything else (unsupported, thrown, NOT_FOUND, CONFLICT) is null.
   */
  private async lookupExistingPr(
    input: { runId: string; resultCommitSha: string; idempotencyKey: string },
    repository: RepositoryReference,
  ): Promise<string | null> {
    const reconcile = this.deps.gitService.reconcilePublicationOperation;
    if (!reconcile) return null;
    try {
      const result = await reconcile.call(this.deps.gitService, {
        runId: input.runId,
        repository,
        operationType: "CREATE_PR",
        resultCommitSha: input.resultCommitSha,
        baseBranch: repository.baseBranch,
        idempotencyKey: input.idempotencyKey,
      });
      return result.status === "SUCCEEDED" && result.remoteReference.trim() ? result.remoteReference : null;
    } catch {
      return null;
    }
  }
}
