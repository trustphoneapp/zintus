import type {
  ActuatorOutcome,
  PublicationActuator,
  PublicationCredentials,
} from "@zintus/engineer";
import type { RepositoryReference } from "@zintus/engineer";

/**
 * Real P8 publication actuator — the credentialed GitHub branch/PR effect.
 *
 * The P8 `PublicationAuthorityService.dispatch` commits DISPATCHED durably
 * BEFORE calling this, so a crash never re-issues the remote effect. This
 * actuator therefore only has to map a git result to the frozen
 * `ActuatorOutcome`:
 *   - success (branch → push → PR) => RECEIPT{prUrl, commitSha}
 *   - the run context cannot be resolved (nothing was written remotely) =>
 *     FAILED — a definite, pre-remote failure the service records terminally.
 *   - ANY thrown error during the git steps => AMBIGUOUS — the remote state is
 *     uncertain (a ref/PR may or may not have landed), so the service parks
 *     RECONCILING and a human resolves it. This is deliberately conservative:
 *     we NEVER auto-redispatch an operation whose remote outcome is unknown.
 *
 * The GitHub credentials arrive ONLY here (post-approval, post-DISPATCHED) and
 * are passed only to the injected git service; they never touch candidate,
 * selection, or approval reads. The [HUMAN] credential boundary (is a token
 * even configured) is enforced UPSTREAM of `dispatch` in the gateway facade so
 * a missing token leaves the publication in PREFLIGHT (re-driveable once the
 * credential is connected) rather than parking it in RECONCILING.
 */

/** The subset of the engineer GitService the actuator drives (branch → push → PR). */
export interface BranchPrActuatorGitService {
  createRunBranch(input: {
    runId: string;
    repository: RepositoryReference;
    resultCommitSha: string;
  }): Promise<{ branchName: string; remoteReference: string }>;
  pushVerifiedCommit(input: {
    runId: string;
    repository: RepositoryReference;
    resultCommitSha: string;
    branchName: string;
  }): Promise<{ remoteReference: string }>;
  createPullRequest(input: {
    runId: string;
    repository: RepositoryReference;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ id: string; number: number; url: string }>;
}

/** Server-derived, run-scoped facts the actuator needs beyond the P8 operation row. */
export interface ActuatorRunContext {
  repository: RepositoryReference;
  title: string;
  body: string;
}

export interface BranchPrActuatorDeps {
  gitService: BranchPrActuatorGitService;
  /**
   * Resolves the run's durable repository + PR title/body from server records.
   * Returns null ONLY when the run/repository is genuinely unavailable — that
   * is a definite pre-remote failure (nothing was written), mapped to FAILED.
   */
  resolveRunContext: (runId: string) => ActuatorRunContext | null;
}

export function createBranchPrActuator(deps: BranchPrActuatorDeps): PublicationActuator {
  return {
    async createBranchPr(input, credentials: PublicationCredentials): Promise<ActuatorOutcome> {
      const context = deps.resolveRunContext(input.runId);
      if (!context) {
        // Nothing has been written to the remote — a clean, terminal failure.
        return { kind: "FAILED", detail: `publication run context unavailable for run ${input.runId}` };
      }
      // Credentials are held only for the effect; never logged or returned.
      void credentials;
      try {
        const branch = await deps.gitService.createRunBranch({
          runId: input.runId,
          repository: context.repository,
          resultCommitSha: input.resultCommitSha,
        });
        await deps.gitService.pushVerifiedCommit({
          runId: input.runId,
          repository: context.repository,
          resultCommitSha: input.resultCommitSha,
          branchName: branch.branchName,
        });
        const pr = await deps.gitService.createPullRequest({
          runId: input.runId,
          repository: context.repository,
          branchName: branch.branchName,
          baseBranch: context.repository.baseBranch,
          title: context.title,
          body: context.body,
          idempotencyKey: input.idempotencyKey,
        });
        return { kind: "RECEIPT", prUrl: pr.url, commitSha: input.resultCommitSha };
      } catch (error) {
        // The remote result is unknown: a ref or PR may already exist. Park in
        // RECONCILING for a human — never auto-redispatch.
        return {
          kind: "AMBIGUOUS",
          observedRemoteState: "REMOTE_OUTCOME_UNKNOWN",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
