import { spawnSync } from "node:child_process";
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
  title: string;
  body: string;
  idempotencyKey: string;
}
export interface PullRequestResult { id: string; number: number; url: string; }
export interface InspectBaseBranchInput { repository: RepositoryReference; expectedBaseCommitSha: string; }
export interface BaseBranchStatus { currentCommitSha: string; matchesExpected: boolean; protectionEnforced: boolean; }

export interface GitService {
  createRunBranch(input: CreateRunBranchInput): Promise<BranchResult>;
  pushVerifiedCommit(input: PushVerifiedCommitInput): Promise<PushResult>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestResult>;
  inspectBaseBranch(input: InspectBaseBranchInput): Promise<BaseBranchStatus>;
}

export interface GitHubGitServiceOptions {
  repositoryRoot: string;
  token: () => string | Promise<string>;
  fetch?: typeof fetch;
}

/** Narrow credential boundary. This service is never passed to an agent. */
export class GitHubGitService implements GitService {
  private readonly options: GitHubGitServiceOptions;
  constructor(options: GitHubGitServiceOptions) { this.options = options; }

  async createRunBranch(input: CreateRunBranchInput): Promise<BranchResult> {
    this.git(["cat-file", "-e", `${input.resultCommitSha}^{commit}`]);
    const segment = input.runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
    const branchName = `zintus/engineer/${segment}-${input.resultCommitSha.slice(0, 12)}`;
    return { branchName, remoteReference: `refs/heads/${branchName}` };
  }

  async pushVerifiedCommit(input: PushVerifiedCommitInput): Promise<PushResult> {
    this.git(["push", "--porcelain", "origin", `${input.resultCommitSha}:refs/heads/${input.branchName}`]);
    return { remoteReference: `refs/heads/${input.branchName}` };
  }

  async inspectBaseBranch(input: InspectBaseBranchInput): Promise<BaseBranchStatus> {
    const output = this.git(["ls-remote", "--exit-code", "origin", `refs/heads/${input.repository.baseBranch}`]);
    const currentCommitSha = output.trim().split(/\s+/)[0] ?? "";
    if (!/^[a-f0-9]{40,64}$/i.test(currentCommitSha)) throw new Error("remote base branch returned no valid commit");
    const branch = await this.github(input.repository, `/branches/${encodeURIComponent(input.repository.baseBranch)}`, { method: "GET" });
    const protectedBranch = (branch as { protected?: boolean }).protected === true;
    return { currentCommitSha, matchesExpected: currentCommitSha.toLowerCase() === input.expectedBaseCommitSha.toLowerCase(), protectionEnforced: protectedBranch };
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestResult> {
    const response = await this.github(input.repository, "/pulls", {
      method: "POST",
      body: JSON.stringify({ title: input.title, body: input.body, head: input.branchName, base: input.baseBranch }),
    }) as { id?: number; number?: number; html_url?: string };
    if (!response.id || !response.number || !response.html_url) throw new Error("GitHub returned an invalid pull request result");
    return { id: String(response.id), number: response.number, url: response.html_url };
  }

  private git(args: string[]): string {
    const result = spawnSync("git", ["-C", this.options.repositoryRoot, ...args], {
      shell: false, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0" },
    });
    if (result.status !== 0) throw new Error(`git service command failed: ${String(result.stderr || result.error?.message || "unknown error")}`);
    return String(result.stdout ?? "");
  }

  private async github(repository: RepositoryReference, path: string, init: RequestInit): Promise<unknown> {
    if (repository.provider !== "github") throw new Error("pull request publication requires a GitHub repository");
    const token = await this.options.token();
    if (!token) throw new Error("GitHub publication credential is unavailable");
    const response = await (this.options.fetch ?? fetch)(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${path}`, {
      ...init,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`GitHub API failed with status ${response.status}`);
    return response.json();
  }
}
