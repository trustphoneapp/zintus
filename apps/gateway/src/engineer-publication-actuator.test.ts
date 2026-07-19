import { describe, expect, test } from "bun:test";
import type { RepositoryReference } from "@zintus/engineer";
import {
  createBranchPrActuator,
  type ActuatorRunContext,
  type BranchPrActuatorGitService,
} from "./engineer-publication-actuator.js";

const REPO: RepositoryReference = {
  repositoryId: "repo-1", provider: "github", owner: "acme", name: "svc",
  baseBranch: "main", baseCommitSha: "0".repeat(40), url: "https://github.com/acme/svc.git",
};
const CONTEXT: ActuatorRunContext = { repository: REPO, title: "Fix", body: "body" };
const INPUT = {
  runId: "run-1", publicationId: "pub-1", repositoryId: "repo-1",
  baseCommitSha: "0".repeat(40), resultCommitSha: "1".repeat(40), idempotencyKey: "k",
};
const CREDS = { token: "ghp_secret" };

function okGitService(calls: string[]): BranchPrActuatorGitService {
  return {
    async createRunBranch() { calls.push("branch"); return { branchName: "zintus/run-1", remoteReference: "refs/heads/zintus/run-1" }; },
    async pushVerifiedCommit() { calls.push("push"); return { remoteReference: "refs/heads/zintus/run-1" }; },
    async createPullRequest() { calls.push("pr"); return { id: "pr-1", number: 7, url: "https://github.com/acme/svc/pull/7" }; },
  };
}

describe("branch/PR publication actuator", () => {
  test("success drives branch → push → PR in order and returns a RECEIPT bound to the result commit", async () => {
    const calls: string[] = [];
    const actuator = createBranchPrActuator({ gitService: okGitService(calls), resolveRunContext: () => CONTEXT });
    const outcome = await actuator.createBranchPr(INPUT, CREDS);
    expect(calls).toEqual(["branch", "push", "pr"]);
    expect(outcome).toEqual({ kind: "RECEIPT", prUrl: "https://github.com/acme/svc/pull/7", commitSha: "1".repeat(40) });
  });

  test("an unresolvable run context is a definite pre-remote FAILED (no git effect attempted)", async () => {
    const calls: string[] = [];
    const actuator = createBranchPrActuator({ gitService: okGitService(calls), resolveRunContext: () => null });
    const outcome = await actuator.createBranchPr(INPUT, CREDS);
    expect(outcome.kind).toBe("FAILED");
    expect(calls).toEqual([]); // nothing was written remotely
  });

  test("a thrown git error maps to AMBIGUOUS (uncertain remote state → RECONCILING, never auto-redispatch)", async () => {
    const throwing: BranchPrActuatorGitService = {
      async createRunBranch() { return { branchName: "b", remoteReference: "r" }; },
      async pushVerifiedCommit() { return { remoteReference: "r" }; },
      async createPullRequest() { throw new Error("network partition during PR create"); },
    };
    const actuator = createBranchPrActuator({ gitService: throwing, resolveRunContext: () => CONTEXT });
    const outcome = await actuator.createBranchPr(INPUT, CREDS);
    expect(outcome.kind).toBe("AMBIGUOUS");
    if (outcome.kind === "AMBIGUOUS") {
      expect(outcome.observedRemoteState).toBe("REMOTE_OUTCOME_UNKNOWN");
      expect(outcome.detail).toContain("network partition");
    }
  });

  test("the PR is created against the resolved base branch with the operation's idempotency key", async () => {
    let prInput: { baseBranch: string; idempotencyKey: string; title: string } | null = null;
    const capturing: BranchPrActuatorGitService = {
      async createRunBranch() { return { branchName: "zintus/run-1", remoteReference: "r" }; },
      async pushVerifiedCommit() { return { remoteReference: "r" }; },
      async createPullRequest(input) { prInput = input; return { id: "pr", number: 1, url: "https://github.com/acme/svc/pull/1" }; },
    };
    const actuator = createBranchPrActuator({ gitService: capturing, resolveRunContext: () => CONTEXT });
    await actuator.createBranchPr(INPUT, CREDS);
    expect(prInput!.baseBranch).toBe("main");
    expect(prInput!.idempotencyKey).toBe("k");
    expect(prInput!.title).toBe("Fix");
  });
});
