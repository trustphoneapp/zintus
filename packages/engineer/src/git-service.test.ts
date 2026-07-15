import { describe, expect, test } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { GitHubGitService } from "./git-service.js";

const repository = {
  repositoryId: "repo-1", provider: "github" as const, owner: "zintus-org", name: "zintus",
  baseBranch: "main", baseCommitSha: "a".repeat(40),
};

describe("Phase 4 credentialed Git publication", () => {
  test("uses an ephemeral askpass token without placing the credential in argv", async () => {
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "github-secret-token",
      spawn: ((_command, args, options) => {
        calls.push({ args: args ?? [], env: options?.env ?? {} });
        const stdout = args?.includes("ls-remote") ? `${"b".repeat(40)}\trefs/heads/zintus/engineer/run-1\n` : "";
        return { status: 0, stdout, stderr: "", pid: 1, output: [], signal: null, error: undefined } as unknown as SpawnSyncReturns<string>;
      }) as typeof import("node:child_process").spawnSync,
    });
    await service.pushVerifiedCommit({ runId: "run-1", repository, resultCommitSha: "b".repeat(40), branchName: "zintus/engineer/run-1" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args.join(" ")).toContain("https://github.com/zintus-org/zintus.git");
    expect(calls[0]!.args.join(" ")).not.toContain("github-secret-token");
    expect(calls[0]!.env.ZINTUS_GIT_PASSWORD).toBe("github-secret-token");
    expect(calls[0]!.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(calls.every((call) => !call.args.join(" ").includes("github-secret-token"))).toBe(true);
    expect(calls.every((call) => existsSync(String(call.env.GIT_ASKPASS)) === false)).toBe(true);
  });

  test("requires reviews, stale-approval invalidation, strict checks, admin enforcement, and immutable history", async () => {
    const responses = [
      { protected: true },
      {
        required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: false },
        required_status_checks: { strict: true, contexts: ["ci/test"] }, enforce_admins: { enabled: true },
        allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
      },
    ];
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      spawn: (() => ({ status: 0, stdout: `${repository.baseCommitSha}\trefs/heads/main\n`, stderr: "", pid: 1, output: [], signal: null })) as unknown as typeof import("node:child_process").spawnSync,
      fetch: (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as unknown as typeof fetch,
    });
    const status = await service.inspectBaseBranch({ repository, expectedBaseCommitSha: repository.baseCommitSha });
    expect(status.matchesExpected).toBe(true);
    expect(status.protectionEnforced).toBe(true);
    expect(status.protection).toMatchObject({ requiresPullRequestReviews: true, requiresStrictStatusChecks: true, enforcesAdmins: true });
  });

  test("fails the protection verdict when required status checks are absent", async () => {
    const responses = [
      { protected: true },
      { required_pull_request_reviews: { required_approving_review_count: 1, require_last_push_approval: true }, enforce_admins: { enabled: true } },
    ];
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      spawn: (() => ({ status: 0, stdout: `${repository.baseCommitSha}\trefs/heads/main\n`, stderr: "", pid: 1, output: [], signal: null })) as unknown as typeof import("node:child_process").spawnSync,
      fetch: (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as unknown as typeof fetch,
    });
    expect((await service.inspectBaseBranch({ repository, expectedBaseCommitSha: repository.baseCommitSha })).protectionEnforced).toBe(false);
  });

  test("recovers an already-created pull request instead of posting a duplicate", async () => {
    const methods: string[] = [];
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return new Response(JSON.stringify([{ id: 91, number: 12, html_url: "https://github.test/pull/12" }]), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const pullRequest = await service.createPullRequest({
      runId: "run-1", repository, branchName: "zintus/engineer/run-1", baseBranch: "main",
      title: "Verified change", body: "trusted body", idempotencyKey: "pr:create:run-1",
    });
    expect(pullRequest).toEqual({ id: "91", number: 12, url: "https://github.test/pull/12" });
    expect(methods).toEqual(["GET"]);
  });
});
