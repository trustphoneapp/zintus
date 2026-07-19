import { describe, expect, test } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { GitHubGitService } from "./git-service.js";

const repository = {
  repositoryId: "repo-1", provider: "github" as const, owner: "zintus-org", name: "zintus",
  baseBranch: "main", baseCommitSha: "a".repeat(40),
};

describe("Phase 4 credentialed Git publication", () => {
  test("refreshes an expired API credential once without retaining the old token", async () => {
    const tokens: string[] = [];
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository",
      token: () => "expired-token",
      refreshToken: () => "fresh-token",
      fetch: (async (_url, init) => {
        const token = String((init?.headers as Record<string, string>)?.Authorization ?? "");
        tokens.push(token);
        return token === "Bearer fresh-token"
          ? new Response(JSON.stringify([]), { status: 200 })
          : new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      }) as typeof fetch,
    });
    await expect(service.createPullRequest({
      runId: "run-1", repository, branchName: "zintus/engineer/run-1",
      baseBranch: "main", title: "Title", body: "Body", idempotencyKey: "pr-1",
    })).rejects.toThrow("GitHub returned an invalid pull request result");
    expect(tokens).toEqual(["Bearer expired-token", "Bearer fresh-token", "Bearer expired-token", "Bearer fresh-token"]);
  });

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

  test("refreshes the credential once for authenticated Git transport", async () => {
    const usedTokens: string[] = [];
    const resultCommitSha = "b".repeat(40);
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository",
      token: () => "expired-token",
      refreshToken: () => "fresh-token",
      spawn: ((_command, args, options) => {
        const token = String(options?.env?.ZINTUS_GIT_PASSWORD ?? "");
        usedTokens.push(token);
        if (token === "expired-token") {
          return { status: 128, stdout: "", stderr: "Authentication failed", pid: 1, output: [], signal: null } as unknown as SpawnSyncReturns<string>;
        }
        const stdout = args?.includes("ls-remote") ? `${resultCommitSha}\trefs/heads/zintus/engineer/run-1\n` : "";
        return { status: 0, stdout, stderr: "", pid: 1, output: [], signal: null } as unknown as SpawnSyncReturns<string>;
      }) as typeof import("node:child_process").spawnSync,
    });

    await service.pushVerifiedCommit({
      runId: "run-1", repository, resultCommitSha, branchName: "zintus/engineer/run-1",
    });
    expect(usedTokens).toEqual(["expired-token", "fresh-token", "expired-token", "fresh-token"]);
  });

  test("does not refresh or replay a non-authentication Git failure", async () => {
    let refreshes = 0;
    let commands = 0;
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "current-token",
      refreshToken: () => { refreshes += 1; return "rotated-token"; },
      spawn: (() => {
        commands += 1;
        return { status: 1, stdout: "", stderr: "non-fast-forward", pid: 1, output: [], signal: null } as unknown as SpawnSyncReturns<string>;
      }) as unknown as typeof import("node:child_process").spawnSync,
    });
    await expect(service.pushVerifiedCommit({
      runId: "run-1", repository, resultCommitSha: "b".repeat(40), branchName: "zintus/engineer/run-1",
    })).rejects.toThrow("non-fast-forward");
    expect(refreshes).toBe(0);
    expect(commands).toBe(1);
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
        return new Response(JSON.stringify([{ id: 91, number: 12, html_url: "https://github.test/pull/12", draft: true }]), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const pullRequest = await service.createPullRequest({
      runId: "run-1", repository, branchName: "zintus/engineer/run-1", baseBranch: "main",
      title: "Verified change", body: "trusted body", idempotencyKey: "pr:create:run-1",
    });
    expect(pullRequest).toEqual({ id: "91", number: 12, url: "https://github.test/pull/12" });
    expect(methods).toEqual(["GET"]);
  });

  test("fails closed when idempotent recovery finds a publication PR already marked ready", async () => {
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      fetch: (async () => new Response(JSON.stringify([{
        id: 91, number: 12, html_url: "https://github.test/pull/12", draft: false,
      }]), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(service.createPullRequest({
      runId: "run-1", repository, branchName: "zintus/engineer/run-1", baseBranch: "main",
      title: "Verified change", body: "trusted body", idempotencyKey: "pr:create:run-1",
    })).rejects.toThrow("existing publication pull request is not a draft");
  });

  test("creates publication pull requests as drafts so approval remains a separate human action", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> | null }> = [];
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null,
        });
        if ((init?.method ?? "GET") === "GET") return new Response("[]", { status: 200 });
        return new Response(JSON.stringify({ id: 92, number: 13, html_url: "https://github.test/pull/13" }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    const pullRequest = await service.createPullRequest({
      runId: "run-1", repository, branchName: "zintus/engineer/run-1", baseBranch: "main",
      title: "Verified change", body: "trusted body", idempotencyKey: "pr:create:run-1",
    });
    expect(pullRequest.number).toBe(13);
    expect(requests).toEqual([
      { method: "GET", body: null },
      { method: "POST", body: { title: "Verified change", body: "trusted body", head: "zintus/engineer/run-1", base: "main", draft: true } },
    ]);
  });

  test("reconciles an interrupted push with a read-only credentialed lookup", async () => {
    const resultCommitSha = "b".repeat(40);
    const calls: string[][] = [];
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      spawn: ((_command, args) => {
        calls.push([...((args ?? []) as readonly string[])]);
        return {
          status: 0,
          stdout: `${resultCommitSha}\trefs/heads/zintus/engineer/run-1-${resultCommitSha.slice(0, 12)}\n`,
          stderr: "", pid: 1, output: [], signal: null,
        } as unknown as SpawnSyncReturns<string>;
      }) as typeof import("node:child_process").spawnSync,
    });
    expect(await service.reconcilePublicationOperation({
      runId: "run-1", repository, operationType: "PUSH_COMMIT", resultCommitSha,
      baseBranch: "main", idempotencyKey: "git:push:run-1",
    })).toEqual({
      status: "SUCCEEDED",
      remoteReference: `refs/heads/zintus/engineer/run-1-${resultCommitSha.slice(0, 12)}`,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("ls-remote");
    expect(calls[0]).not.toContain("push");
  });

  test("reconciles an interrupted PR only when branch, commit, and base all match", async () => {
    const resultCommitSha = "b".repeat(40);
    const methods: string[] = [];
    const branchName = `zintus/engineer/run-1-${resultCommitSha.slice(0, 12)}`;
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return new Response(JSON.stringify([{
          id: 91, number: 12, html_url: "https://github.test/pull/12", state: "open", draft: true,
          head: { ref: branchName, sha: resultCommitSha }, base: { ref: "main" },
        }]), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await service.reconcilePublicationOperation({
      runId: "run-1", repository, operationType: "CREATE_PR", resultCommitSha,
      baseBranch: "main", idempotencyKey: "pr:create:run-1",
    })).toEqual({ status: "SUCCEEDED", remoteReference: "https://github.test/pull/12" });
    expect(methods).toEqual(["GET"]);
  });

  // F3 (P1): reconciliation must accept ONLY an exact OPEN DRAFT pull request as a
  // live receipt — mirroring the creation-path invariants (open state, draft:true).
  // A CLOSED, MERGED, or ready-for-review PR that happens to match branch+sha+base
  // is NOT the live publication receipt and must reconcile to NOT_FOUND.
  test("F3: a CLOSED pull request matching branch+sha is NOT accepted as a receipt", async () => {
    const resultCommitSha = "b".repeat(40);
    const branchName = `zintus/engineer/run-1-${resultCommitSha.slice(0, 12)}`;
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      fetch: (async () => new Response(JSON.stringify([{
        id: 91, number: 12, html_url: "https://github.test/pull/12", state: "closed", draft: true,
        head: { ref: branchName, sha: resultCommitSha }, base: { ref: "main" },
      }]), { status: 200 })) as unknown as typeof fetch,
    });
    const result = await service.reconcilePublicationOperation({
      runId: "run-1", repository, operationType: "CREATE_PR", resultCommitSha,
      baseBranch: "main", idempotencyKey: "pr:create:run-1",
    });
    expect(result.status).toBe("NOT_FOUND");
  });

  test("F3: a MERGED pull request matching branch+sha is NOT accepted as a receipt", async () => {
    const resultCommitSha = "b".repeat(40);
    const branchName = `zintus/engineer/run-1-${resultCommitSha.slice(0, 12)}`;
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      fetch: (async () => new Response(JSON.stringify([{
        id: 91, number: 12, html_url: "https://github.test/pull/12", state: "closed", draft: false, merged_at: "2026-07-19T00:00:00Z",
        head: { ref: branchName, sha: resultCommitSha }, base: { ref: "main" },
      }]), { status: 200 })) as unknown as typeof fetch,
    });
    const result = await service.reconcilePublicationOperation({
      runId: "run-1", repository, operationType: "CREATE_PR", resultCommitSha,
      baseBranch: "main", idempotencyKey: "pr:create:run-1",
    });
    expect(result.status).toBe("NOT_FOUND");
  });

  test("F3: a ready-for-review (non-draft) OPEN pull request is NOT accepted as a receipt", async () => {
    const resultCommitSha = "b".repeat(40);
    const branchName = `zintus/engineer/run-1-${resultCommitSha.slice(0, 12)}`;
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      fetch: (async () => new Response(JSON.stringify([{
        id: 91, number: 12, html_url: "https://github.test/pull/12", state: "open", draft: false,
        head: { ref: branchName, sha: resultCommitSha }, base: { ref: "main" },
      }]), { status: 200 })) as unknown as typeof fetch,
    });
    const result = await service.reconcilePublicationOperation({
      runId: "run-1", repository, operationType: "CREATE_PR", resultCommitSha,
      baseBranch: "main", idempotencyKey: "pr:create:run-1",
    });
    expect(result.status).toBe("NOT_FOUND");
  });

  test("F3: an exact OPEN DRAFT pull request IS accepted as the live receipt (control)", async () => {
    const resultCommitSha = "b".repeat(40);
    const branchName = `zintus/engineer/run-1-${resultCommitSha.slice(0, 12)}`;
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      fetch: (async () => new Response(JSON.stringify([{
        id: 91, number: 12, html_url: "https://github.test/pull/12", state: "open", draft: true,
        head: { ref: branchName, sha: resultCommitSha }, base: { ref: "main" },
      }]), { status: 200 })) as unknown as typeof fetch,
    });
    expect(await service.reconcilePublicationOperation({
      runId: "run-1", repository, operationType: "CREATE_PR", resultCommitSha,
      baseBranch: "main", idempotencyKey: "pr:create:run-1",
    })).toEqual({ status: "SUCCEEDED", remoteReference: "https://github.test/pull/12" });
  });
});

// F6 (R5F-2): a REAL result-tree-hash source for the v35 provenance attestation.
// index.ts previously wired `resultTreeHashFor: () => null`, so a REQUIRED
// attestation ALWAYS failed closed and nothing fed the mechanism. This source
// reads the result commit's full tree from the local object store (read-only)
// and returns a deterministic `sha256:<64hex>` that the attestation HashSchema
// accepts, or null (fail closed) when git cannot source it.
describe("F6 result-tree-hash source for provenance attestation", () => {
  const resultCommitSha = "b".repeat(40);
  const listing =
    "100644 blob 1111111111111111111111111111111111111111\tsrc/a.ts\n" +
    "040000 tree 2222222222222222222222222222222222222222\tsrc\n";

  test("derives a deterministic sha256:<64hex> tree hash from the local object store", () => {
    const calls: string[][] = [];
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      spawn: ((_command: string, args?: readonly string[]) => {
        calls.push([...(args ?? [])]);
        return { status: 0, stdout: listing, stderr: "", pid: 1, output: [], signal: null } as unknown as SpawnSyncReturns<string>;
      }) as unknown as typeof import("node:child_process").spawnSync,
    });
    const hash = service.resolveResultTreeHash!({ resultCommitSha });
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Deterministic: the same tree listing always yields the same digest.
    const again = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      spawn: (() => ({ status: 0, stdout: listing, stderr: "", pid: 1, output: [], signal: null }) as unknown as SpawnSyncReturns<string>) as unknown as typeof import("node:child_process").spawnSync,
    }).resolveResultTreeHash!({ resultCommitSha });
    expect(again).toBe(hash);
    // It reads the result commit's TREE (read-only), never a mutation.
    const readArgs = calls[0]!.join(" ");
    expect(readArgs).toContain(`${resultCommitSha}^{tree}`);
    expect(readArgs).not.toMatch(/push|commit|update-ref|write-tree|checkout|reset/);
  });

  test("a different tree listing yields a different digest (binds the exact result tree)", () => {
    const base = new GitHubGitService({
      repositoryRoot: "/r", token: () => "t",
      spawn: (() => ({ status: 0, stdout: listing, stderr: "", pid: 1, output: [], signal: null }) as unknown as SpawnSyncReturns<string>) as unknown as typeof import("node:child_process").spawnSync,
    }).resolveResultTreeHash!({ resultCommitSha });
    const mutated = new GitHubGitService({
      repositoryRoot: "/r", token: () => "t",
      spawn: (() => ({ status: 0, stdout: listing + "100644 blob 3333333333333333333333333333333333333333\tsrc/b.ts\n", stderr: "", pid: 1, output: [], signal: null }) as unknown as SpawnSyncReturns<string>) as unknown as typeof import("node:child_process").spawnSync,
    }).resolveResultTreeHash!({ resultCommitSha });
    expect(mutated).not.toBe(base);
  });

  test("fails closed (returns null) when git cannot read the commit/tree", () => {
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      spawn: (() => ({ status: 128, stdout: "", stderr: "fatal: bad object", pid: 1, output: [], signal: null }) as unknown as SpawnSyncReturns<string>) as unknown as typeof import("node:child_process").spawnSync,
    });
    expect(service.resolveResultTreeHash!({ resultCommitSha })).toBeNull();
  });

  test("fails closed (returns null) when the tree listing is empty", () => {
    const service = new GitHubGitService({
      repositoryRoot: "/trusted/repository", token: () => "token",
      spawn: (() => ({ status: 0, stdout: "   \n", stderr: "", pid: 1, output: [], signal: null }) as unknown as SpawnSyncReturns<string>) as unknown as typeof import("node:child_process").spawnSync,
    });
    expect(service.resolveResultTreeHash!({ resultCommitSha })).toBeNull();
  });
});
