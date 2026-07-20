import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryReference } from "./contracts.js";

export interface CreateRunBranchInput {
  runId: string;
  repository: RepositoryReference;
  resultCommitSha: string;
}
export interface BranchResult { branchName: string; remoteReference: string; }
export interface PushVerifiedCommitInput extends CreateRunBranchInput { branchName: string; }
export interface PushResult { remoteReference: string; }
export interface CreatePullRequestInput {
  runId: string;
  repository: RepositoryReference;
  branchName: string;
  baseBranch: string;
  /**
   * The verified result commit that MUST be at the head of the publication PR.
   * The existing-PR short-circuit re-asserts head.sha against this (mirroring
   * `reconcilePublicationOperation`), so an existing PR is only ever returned
   * when its head/sha/base EXACTLY match this publication — never merely because
   * it is a draft on the same head ref.
   */
  resultCommitSha: string;
  title: string;
  body: string;
  idempotencyKey: string;
}
export interface PullRequestResult { id: string; number: number; url: string; }
export interface InspectBaseBranchInput { repository: RepositoryReference; expectedBaseCommitSha: string; }
export interface BranchProtectionEvidence {
  protected: boolean;
  requiresPullRequestReviews: boolean;
  requiredApprovingReviewCount: number;
  invalidatesStaleApproval: boolean;
  requiresStatusChecks: boolean;
  requiresStrictStatusChecks: boolean;
  enforcesAdmins: boolean;
  blocksForcePushes: boolean;
  blocksDeletions: boolean;
}
export interface BaseBranchStatus {
  currentCommitSha: string;
  matchesExpected: boolean;
  protectionEnforced: boolean;
  /** Detailed provider evidence; optional only for alternate/test adapters. */
  protection?: BranchProtectionEvidence;
}

export interface ReconcilePublicationOperationInput {
  runId: string;
  repository: RepositoryReference;
  operationType: "CREATE_BRANCH" | "PUSH_COMMIT" | "CREATE_PR";
  resultCommitSha: string;
  baseBranch: string;
  idempotencyKey: string;
}

export type PublicationOperationReconciliation =
  | { status: "SUCCEEDED"; remoteReference: string }
  | { status: "NOT_FOUND" | "CONFLICT" | "INDETERMINATE"; detail: string };

export interface GitService {
  createRunBranch(input: CreateRunBranchInput): Promise<BranchResult>;
  pushVerifiedCommit(input: PushVerifiedCommitInput): Promise<PushResult>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestResult>;
  inspectBaseBranch(input: InspectBaseBranchInput): Promise<BaseBranchStatus>;
  /** Read-only, credentialed recovery check. It must never create, update, or delete a remote ref or PR. */
  reconcilePublicationOperation?(input: ReconcilePublicationOperationInput): Promise<PublicationOperationReconciliation>;
  /**
   * Read-only: derives a deterministic `sha256:<64hex>` commitment to the result
   * commit's FULL tree from the local object store, for the v35 provenance
   * attestation's `resultTreeHash`. Returns null (fail closed) when the commit or
   * tree cannot be read (no git access / unknown commit). Never mutates a ref,
   * remote, or working tree.
   */
  resolveResultTreeHash?(input: { resultCommitSha: string }): string | null;
}

export interface GitHubGitServiceOptions {
  repositoryRoot: string;
  token: () => string | Promise<string>;
  refreshToken?: () => string | Promise<string>;
  fetch?: typeof fetch;
  spawn?: typeof spawnSync;
}

/** Narrow credential boundary. This service is never passed to an agent. */
export class GitHubGitService implements GitService {
  private readonly options: GitHubGitServiceOptions;
  constructor(options: GitHubGitServiceOptions) { this.options = options; }

  async createRunBranch(input: CreateRunBranchInput): Promise<BranchResult> {
    this.git(["cat-file", "-e", `${input.resultCommitSha}^{commit}`]);
    const branchName = this.branchName(input.runId, input.resultCommitSha);
    return { branchName, remoteReference: `refs/heads/${branchName}` };
  }

  async reconcilePublicationOperation(input: ReconcilePublicationOperationInput): Promise<PublicationOperationReconciliation> {
    const branchName = this.branchName(input.runId, input.resultCommitSha);
    const remoteReference = `refs/heads/${branchName}`;
    if (input.operationType === "CREATE_BRANCH") {
      // CREATE_BRANCH only validates the local commit and derives this deterministic name.
      // Recomputing that value is read-only and cannot duplicate a remote mutation.
      this.git(["cat-file", "-e", `${input.resultCommitSha}^{commit}`]);
      return { status: "SUCCEEDED", remoteReference };
    }
    if (input.operationType === "PUSH_COMMIT") {
      const result = await this.authenticatedGitCurrent(input.repository, ["ls-remote", this.remoteUrl(input.repository), remoteReference]);
      const remoteCommitSha = result.trim().split(/\s+/)[0] ?? "";
      if (!remoteCommitSha) return { status: "NOT_FOUND", detail: "publication branch is not present on the remote" };
      if (remoteCommitSha.toLowerCase() !== input.resultCommitSha.toLowerCase()) {
        return { status: "CONFLICT", detail: "publication branch points to a different commit" };
      }
      return { status: "SUCCEEDED", remoteReference };
    }
    // F3: the live receipt is ONLY an exact OPEN DRAFT pull request — the same
    // invariants the creation path enforces (open state, draft:true). A CLOSED,
    // MERGED, or ready-for-review PR that happens to match branch+sha+base is NOT
    // the live publication and must reconcile to NOT_FOUND, never SUCCEEDED. We
    // scope the query to open PRs AND re-assert state/draft on each candidate, so
    // a stale or non-draft PR is rejected even if the provider ignores the filter.
    const query = new URLSearchParams({ state: "open", head: `${input.repository.owner}:${branchName}`, base: input.baseBranch });
    const matches = await this.github(input.repository, `/pulls?${query.toString()}`, { method: "GET" }) as Array<{
      id?: number; number?: number; html_url?: string; state?: string; draft?: boolean;
      merged_at?: string | null; head?: { sha?: string; ref?: string }; base?: { ref?: string };
    }>;
    const exact = matches.find((candidate) => candidate.head?.ref === branchName &&
      candidate.head?.sha?.toLowerCase() === input.resultCommitSha.toLowerCase() && candidate.base?.ref === input.baseBranch &&
      candidate.state === "open" && candidate.draft === true && !candidate.merged_at);
    if (!exact?.id || !exact.number || !exact.html_url) {
      return { status: "NOT_FOUND", detail: "no exact OPEN DRAFT pull request matches the verified branch, commit, and base" };
    }
    return { status: "SUCCEEDED", remoteReference: exact.html_url };
  }

  async pushVerifiedCommit(input: PushVerifiedCommitInput): Promise<PushResult> {
    await this.authenticatedGitCurrent(input.repository, ["push", "--porcelain", this.remoteUrl(input.repository), `${input.resultCommitSha}:refs/heads/${input.branchName}`]);
    const remote = await this.authenticatedGitCurrent(input.repository, ["ls-remote", "--exit-code", this.remoteUrl(input.repository), `refs/heads/${input.branchName}`]);
    const remoteCommitSha = remote.trim().split(/\s+/)[0] ?? "";
    if (remoteCommitSha.toLowerCase() !== input.resultCommitSha.toLowerCase()) {
      throw new Error("remote publication branch does not match the verified result commit");
    }
    return { remoteReference: `refs/heads/${input.branchName}` };
  }

  async inspectBaseBranch(input: InspectBaseBranchInput): Promise<BaseBranchStatus> {
    const output = await this.authenticatedGitCurrent(input.repository, ["ls-remote", "--exit-code", this.remoteUrl(input.repository), `refs/heads/${input.repository.baseBranch}`]);
    const currentCommitSha = output.trim().split(/\s+/)[0] ?? "";
    if (!/^[a-f0-9]{40,64}$/i.test(currentCommitSha)) throw new Error("remote base branch returned no valid commit");
    const branch = await this.github(input.repository, `/branches/${encodeURIComponent(input.repository.baseBranch)}`, { method: "GET" }) as { protected?: boolean };
    const rules = branch.protected === true
      ? await this.github(input.repository, `/branches/${encodeURIComponent(input.repository.baseBranch)}/protection`, { method: "GET" }) as Record<string, unknown>
      : {};
    const reviews = rules.required_pull_request_reviews as Record<string, unknown> | null | undefined;
    const checks = rules.required_status_checks as Record<string, unknown> | null | undefined;
    const enabled = (value: unknown) => (value as { enabled?: boolean } | null | undefined)?.enabled === true;
    const protection: BranchProtectionEvidence = {
      protected: branch.protected === true,
      requiresPullRequestReviews: Boolean(reviews),
      requiredApprovingReviewCount: typeof reviews?.required_approving_review_count === "number" ? reviews.required_approving_review_count : 0,
      invalidatesStaleApproval: reviews?.dismiss_stale_reviews === true || reviews?.require_last_push_approval === true,
      requiresStatusChecks: Boolean(checks) && ([...(Array.isArray(checks?.contexts) ? checks.contexts : []), ...(Array.isArray(checks?.checks) ? checks.checks : [])].length > 0),
      requiresStrictStatusChecks: checks?.strict === true,
      enforcesAdmins: enabled(rules.enforce_admins),
      blocksForcePushes: !enabled(rules.allow_force_pushes),
      blocksDeletions: !enabled(rules.allow_deletions),
    };
    const protectionEnforced = protection.protected && protection.requiresPullRequestReviews &&
      protection.requiredApprovingReviewCount >= 1 && protection.invalidatesStaleApproval &&
      protection.requiresStatusChecks && protection.requiresStrictStatusChecks && protection.enforcesAdmins &&
      protection.blocksForcePushes && protection.blocksDeletions;
    return { currentCommitSha, matchesExpected: currentCommitSha.toLowerCase() === input.expectedBaseCommitSha.toLowerCase(), protectionEnforced, protection };
  }

  // R8-3 FINDING 2: `synchronizeBaseBranch` is removed. Its only caller was the
  // deleted `EngineerPublicationManager.replacementRepositoryForStale` stale-lane
  // recovery; no live path fetches a replacement base outside the Resolution Desk.

  /**
   * Result-tree-hash source for the v35 provenance attestation. Reads the result
   * commit's FULL recursive tree listing (`git ls-tree -r -t --full-tree
   * <sha>^{tree}`) from the local object store — a read-only operation that binds
   * the exact tree by content (each line carries the child object's git OID, so
   * the top-level listing is a Merkle commitment to the whole tree). The sha256
   * of that canonical, text-recomputable listing is returned as `sha256:<64hex>`
   * — the exact shape the attestation `resultTreeHash` HashSchema requires and
   * one a verifier with the repo can independently recompute. Any git failure
   * (unknown commit, no local object store, no git binary) fails CLOSED to null,
   * so a REQUIRED attestation denies publication rather than emitting a fabricated
   * hash. The commit-object identity (`^{tree}`) is validated by git itself.
   */
  resolveResultTreeHash(input: { resultCommitSha: string }): string | null {
    try {
      const listing = this.git(["ls-tree", "-r", "-t", "--full-tree", `${input.resultCommitSha}^{tree}`]);
      if (!listing.trim()) return null;
      return `sha256:${createHash("sha256").update(listing, "utf8").digest("hex")}`;
    } catch {
      return null;
    }
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestResult> {
    const query = new URLSearchParams({ state: "open", head: `${input.repository.owner}:${input.branchName}`, base: input.baseBranch });
    const existing = await this.github(input.repository, `/pulls?${query.toString()}`, { method: "GET" }) as Array<{
      id?: number; number?: number; html_url?: string; draft?: boolean;
      state?: string; merged_at?: string | null; head?: { sha?: string; ref?: string }; base?: { ref?: string };
    }>;
    // Existing-PR short-circuit. Return an existing PR ONLY when it is the EXACT
    // open-draft PR for THIS publication: re-assert head.ref, head.sha (lowercased)
    // and base.ref against the verified branch/commit/base — mirroring
    // `reconcilePublicationOperation` — never merely `draft===true` on the same
    // head. A provider that ignores the head/base filter (or a compromised
    // listing) can therefore NEVER yield a prUrl for a non-matching PR.
    const match = existing.find((candidate) => candidate.head?.ref === input.branchName &&
      candidate.head?.sha?.toLowerCase() === input.resultCommitSha.toLowerCase() &&
      candidate.base?.ref === input.baseBranch && candidate.state === "open" &&
      candidate.draft === true && !candidate.merged_at);
    if (match?.id && match.number && match.html_url) {
      return { id: String(match.id), number: match.number, url: match.html_url };
    }
    // An OPEN, non-draft PR already exists on this exact head/base: creating a
    // draft would be refused by the provider, and a ready-for-review PR is NOT an
    // admissible publication receipt. Fail closed with the same error the legacy
    // draft check surfaced, rather than attempting a duplicate create.
    const readyForReview = existing.find((candidate) => candidate.head?.ref === input.branchName &&
      candidate.head?.sha?.toLowerCase() === input.resultCommitSha.toLowerCase() &&
      candidate.base?.ref === input.baseBranch && candidate.state === "open" &&
      candidate.draft !== true && !candidate.merged_at);
    if (readyForReview) throw new Error("existing publication pull request is not a draft");
    const response = await this.github(input.repository, "/pulls", {
      method: "POST",
      body: JSON.stringify({ title: input.title, body: input.body, head: input.branchName, base: input.baseBranch, draft: true }),
    }) as { id?: number; number?: number; html_url?: string };
    if (!response.id || !response.number || !response.html_url) throw new Error("GitHub returned an invalid pull request result");
    return { id: String(response.id), number: response.number, url: response.html_url };
  }

  private git(args: string[], env: Record<string, string> = {}): string {
    const result = (this.options.spawn ?? spawnSync)("git", ["-C", this.options.repositoryRoot, ...args], {
      shell: false, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env },
    });
    if (result.status !== 0) throw new Error(`git service command failed: ${String(result.stderr || result.error?.message || "unknown error")}`);
    return String(result.stdout ?? "");
  }

  private authenticatedGit(repository: RepositoryReference, token: string, args: string[]): string {
    if (repository.provider !== "github") throw new Error("credentialed Git transport requires a GitHub repository");
    const directory = mkdtempSync(join(tmpdir(), "zintus-git-askpass-"));
    const helper = join(directory, "askpass.sh");
    try {
      writeFileSync(helper, "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$ZINTUS_GIT_USERNAME\" ;;\n  *Password*) printf '%s\\n' \"$ZINTUS_GIT_PASSWORD\" ;;\n  *) exit 1 ;;\nesac\n", { mode: 0o700 });
      chmodSync(helper, 0o700);
      return this.git(args, { GIT_ASKPASS: helper, ZINTUS_GIT_USERNAME: "x-access-token", ZINTUS_GIT_PASSWORD: token });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private async authenticatedGitCurrent(repository: RepositoryReference, args: string[]): Promise<string> {
    const token = await this.requireToken();
    try {
      return this.authenticatedGit(repository, token, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.options.refreshToken || !/(?:authentication failed|bad credentials|could not read username|invalid credentials|http (?:401|403))/i.test(message)) throw error;
      const refreshed = await this.options.refreshToken();
      if (!refreshed || refreshed === token) throw error;
      return this.authenticatedGit(repository, refreshed, args);
    }
  }

  private remoteUrl(repository: RepositoryReference): string {
    if (repository.provider !== "github") throw new Error("credentialed Git transport requires a GitHub repository");
    return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}.git`;
  }

  private branchName(runId: string, resultCommitSha: string): string {
    const segment = runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
    return `zintus/engineer/${segment}-${resultCommitSha.slice(0, 12)}`;
  }

  private async requireToken(): Promise<string> {
    const token = await this.options.token();
    if (!token) throw new Error("GitHub publication credential is unavailable");
    return token;
  }

  private async github(repository: RepositoryReference, path: string, init: RequestInit, suppliedToken?: string, refreshAttempted = false): Promise<unknown> {
    if (repository.provider !== "github") throw new Error("pull request publication requires a GitHub repository");
    const token = suppliedToken ?? await this.requireToken();
    const response = await (this.options.fetch ?? fetch)(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${path}`, {
      ...init,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
    });
    if (response.status === 401 && this.options.refreshToken && !refreshAttempted) {
      const refreshed = await this.options.refreshToken();
      if (refreshed && refreshed !== token) return this.github(repository, path, init, refreshed, true);
    }
    if (!response.ok) throw new Error(`GitHub API failed with status ${response.status}`);
    return response.json();
  }
}
