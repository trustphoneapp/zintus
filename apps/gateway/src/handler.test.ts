import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Engine } from "@zintus/engine";
import { ActivityStore } from "./activity-store.js";
import type { GatewayConfig } from "./auth.js";
import { createGatewayHandler, type GatewayHandlerDeps } from "./handler.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  ApprovalAuthorityConflictError,
  EngineerPublicationManager,
  EngineerSupervisor,
  IdempotencyConflictError,
  LocalArtifactStore,
  ResolutionDesk,
  ResolutionReplacementRunFactory,
  VerifiedCandidateIntegrityError,
  deriveCaseCreationInput,
  serverPricingPolicyDigest,
  type ApprovalRequestRecord,
  type EngineerRun,
} from "@zintus/engineer";
import { EngineerRunManager } from "./engineer.js";
import { deriveEngineerPrincipal } from "./engineer-identity.js";
import { EngineerCapabilityPreflight } from "./engineer-preflight.js";

function fakeEngine(overrides: Partial<Engine> = {}): Engine {
  const base: Engine = {
    async routeAndStream() {
      return {
        providerId: "groq",
        model: "test-model",
        traceId: "trace-1",
        threadId: "thread-1",
        compileTraceId: undefined,
        stream: (async function* () {
          yield "Hello";
          yield " world";
        })(),
      };
    },
    async getProviderStatus() {
      return [];
    },
    getSavings: () => ({ byProvider: {}, total: 0 }),
    getQuotaRemaining: () => 1,
    getProviderStats: () => null,
    updatePolicy: () => {},
    probeProviders: async () => [],
    listThreads: () => [],
    getThreadMessages: () => [],
    createThread: () => ({ id: "t", title: "t", createdAt: new Date(), updatedAt: new Date() }),
    getTrace: () => null,
    getLastTrace: () => null,
    listTraces: () => [],
    getThreadState: () => null,
    getCompileTrace: () => null,
    listMemory: () => [],
    upsertMemory: (input) => ({
      id: "m1",
      threadId: input.threadId ?? null,
      key: input.key,
      value: input.value,
      source: input.source,
      scope: input.scope ?? "thread",
      projectId: input.projectId,
      pinned: input.pinned ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    updateMemory: () => null,
    deleteMemory: () => false,
    async compileThreadContext() {
      return { traceId: "0", messages: [] };
    },
  };
  return { ...base, ...overrides };
}

function makeHandler(
  config: Partial<GatewayConfig> = {},
  engine = fakeEngine(),
  extraDeps: Partial<GatewayHandlerDeps> = {},
) {
  const full: GatewayConfig = {
    port: 8788,
    host: "127.0.0.1",
    token: "",
    corsOrigins: "*",
    ...config,
  };
  return createGatewayHandler({ engine, config: full, ...extraDeps });
}

describe("origin rejection (CSRF / denial-of-wallet guard)", () => {
  test("loopback gateway 403s a disallowed Origin; allows allowed + no-Origin", async () => {
    const handler = makeHandler({ corsOrigins: "loopback" });
    const url = "http://localhost:8788/health";
    const evil = await handler(
      new Request(url, { headers: { origin: "https://evil.com" } }),
    );
    expect(evil.status).toBe(403);
    const noOrigin = await handler(new Request(url));
    expect(noOrigin.status).not.toBe(403);
    const allowed = await handler(
      new Request(url, { headers: { origin: "http://localhost:3000" } }),
    );
    expect(allowed.status).not.toBe(403);
  });

  test("'*' gateway never origin-rejects", async () => {
    const handler = makeHandler({ corsOrigins: "*" });
    const res = await handler(
      new Request("http://localhost:8788/health", {
        headers: { origin: "https://evil.com" },
      }),
    );
    expect(res.status).not.toBe(403);
  });
});

describe("gateway handler", () => {
  test("legacy human-review approve returns the stable verified-candidate 409 with zero workflow calls", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "handler-human-review-bypass" });
    const calls = { resolve: 0, transition: 0, checkpoint: 0, approval: 0, git: 0, provider: 0 };
    const engineerRuns = {
      readiness: () => ({ state: "READY", error: null }), principal: () => principal,
      resolveHumanReview: async () => { calls.resolve += 1; throw new Error("must not call manager"); },
    } as unknown as EngineerRunManager;
    const handler = makeHandler({ token: "secret" }, fakeEngine({
      routeAndStream: async () => { calls.provider += 1; throw new Error("must not call provider"); },
    }), { engineerRuns });
    const response = await handler(new Request("http://x/v1/engineer/runs/review-bypass/human-review", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve", reason: "Legacy approval attempt" }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: {
      code: "ENGINEER_VERIFIED_CANDIDATE_REQUIRED",
      message: "Human review cannot approve unpromoted work. Retry verification to produce a verified candidate or reject the run.",
      action: "RETRY_OR_REJECT",
    } });
    expect(calls).toEqual({ resolve: 0, transition: 0, checkpoint: 0, approval: 0, git: 0, provider: 0 });
    const withoutReason = await handler(new Request("http://x/v1/engineer/runs/review-bypass/human-review", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    }));
    expect(withoutReason.status).toBe(409);
    expect(calls.resolve).toBe(0);
  });

  test("verified candidate checkpoint route requires bearer auth and returns the owner-safe summary", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "handler-checkpoint-owner" });
    const summary = {
      checkpointId: `sha256:${"1".repeat(64)}`, checkpointHash: `sha256:${"2".repeat(64)}`,
      resultCommitSha: "3".repeat(40), classificationResult: "READY", requiredTestCount: 2,
      allRequiredChecksPassed: true, openBlockingCriticalCount: 0,
      environmentDigest: `sha256:${"4".repeat(64)}`, createdAt: "2026-07-17T12:00:00.000Z",
    };
    let receivedPrincipal: unknown;
    const engineerRuns = {
      readiness: () => ({ state: "READY", error: null }), principal: () => principal,
      checkpoint: async (input: unknown) => { receivedPrincipal = input; return summary; },
    } as unknown as EngineerRunManager;
    const handler = makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns });
    const url = "http://x/v1/engineer/runs/checkpoint-run/checkpoint";
    expect((await handler(new Request(url))).status).toBe(401);
    const response = await handler(new Request(url, { headers: { Authorization: "Bearer secret" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ verifiedCandidate: summary });
    expect(receivedPrincipal).toEqual(principal);
  });

  test("verified candidate checkpoint route propagates promoted authority corruption", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "handler-corrupt-checkpoint-owner" });
    const engineerRuns = {
      readiness: () => ({ state: "READY", error: null }), principal: () => principal,
      checkpoint: async () => { throw new VerifiedCandidateIntegrityError("corrupt-checkpoint-run"); },
    } as unknown as EngineerRunManager;
    const handler = makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns });
    const response = await handler(new Request("http://x/v1/engineer/runs/corrupt-checkpoint-run/checkpoint", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: {
      code: "ENGINEER_VERIFIED_CANDIDATE_CORRUPT",
      message: "Verified candidate promotion references missing or corrupt durable checkpoint authority.",
    } });
  });

  test("two browser approval decisions race to one success and one actionable candidate-changed 409", async () => {
    const authority = {
      expectedVerifiedCheckpointId: `sha256:${"a".repeat(64)}`,
      expectedVerifiedCheckpointHash: `sha256:${"b".repeat(64)}`,
      expectedApprovalRevision: 3,
    };
    const approval = {
      approvalRequestId: "approval-race", status: "PENDING", riskTier: "HIGH",
      verifiedCheckpointId: authority.expectedVerifiedCheckpointId,
      verifiedCheckpointHash: authority.expectedVerifiedCheckpointHash,
      approvalRevision: authority.expectedApprovalRevision,
    };
    const principal = { ownerId: "owner-race", reviewerId: "reviewer-race" };
    const received: unknown[] = [];
    let winner = false;
    const engineerRuns = {
      readiness: () => ({ state: "READY", error: null }),
      principal: () => principal,
      approval: () => approval,
      approvalAuthority: () => authority,
      approvalView: () => ({ approval, approvalAuthority: authority }),
      get: () => ({ run: { state: winner ? "HUMAN_APPROVED" : "HUMAN_APPROVAL_PENDING" } }),
      async approve(_principal: unknown, runId: string, _reason: string, expected: unknown) {
        received.push(expected);
        await Promise.resolve();
        if (winner) throw new ApprovalAuthorityConflictError(runId);
        winner = true;
        return { status: "PUBLISHED" };
      },
    } as unknown as EngineerRunManager;
    const handler = makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns });
    const missingAuthority = await handler(new Request("http://x/v1/engineer/runs/run-race/approve", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Approve without displayed authority" }),
    }));
    expect(missingAuthority.status).toBe(400);
    expect(received).toEqual([]);
    const request = () => new Request("http://x/v1/engineer/runs/run-race/approve", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Approve exact candidate", ...authority }),
    });
    const responses = await Promise.all([handler(request()), handler(request())]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(received).toEqual([authority, authority]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(await conflict.json()).toEqual({
      error: {
        code: "ENGINEER_CANDIDATE_CHANGED",
        message: "Candidate changed since this approval was displayed. Refresh the approval and review the current checkpoint before deciding.",
        action: "REFRESH_APPROVAL",
      },
    });
    const read = await handler(new Request("http://x/v1/engineer/runs/run-race/approval", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(await read.json()).toEqual({ approval, approvalAuthority: authority });
  });

  test("every approval-control endpoint forwards the exact displayed authority", async () => {
    const authority = {
      expectedVerifiedCheckpointId: `sha256:${"c".repeat(64)}`,
      expectedVerifiedCheckpointHash: `sha256:${"d".repeat(64)}`,
      expectedApprovalRevision: 8,
    };
    const received: Array<{ action: string; expected: unknown }> = [];
    const engineerRuns = {
      readiness: () => ({ state: "READY", error: null }),
      principal: () => ({ ownerId: "owner-controls", reviewerId: "reviewer-controls" }),
      get: () => ({ run: { state: "HUMAN_APPROVAL_PENDING" } }),
      approve: async (_principal: unknown, _runId: string, _reason: string, expected: unknown) => {
        received.push({ action: "approve", expected }); return { status: "PUBLISHED" };
      },
      requestChanges: async (_principal: unknown, _runId: string, _reason: string, expected: unknown) => {
        received.push({ action: "request-changes", expected });
      },
      reject: async (_principal: unknown, _runId: string, _reason: string, expected: unknown) => {
        received.push({ action: "reject", expected });
      },
      extendApproval: async (_principal: unknown, _runId: string, _reason: string, _seconds: number, expected: unknown) => {
        received.push({ action: "extend-approval", expected }); return { status: "PENDING" };
      },
      expireApproval: async (_principal: unknown, _runId: string, expected: unknown) => {
        received.push({ action: "expire-approval", expected });
      },
    } as unknown as EngineerRunManager;
    const handler = makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns });
    for (const action of ["approve", "request-changes", "reject", "extend-approval", "expire-approval"]) {
      const response = await handler(new Request(`http://x/v1/engineer/runs/run-controls/${action}`, {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Exact displayed candidate", extensionSeconds: 60, ...authority }),
      }));
      expect(response.status).toBe(200);
    }
    expect(received).toEqual([
      { action: "approve", expected: authority },
      { action: "request-changes", expected: authority },
      { action: "reject", expected: authority },
      { action: "extend-approval", expected: authority },
      { action: "expire-approval", expected: authority },
    ]);
  });

  test("the real gateway and publication stack maps an approval CAS loser to 409", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-gateway-approval-cas-"));
    const hash = (value: string) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
    const authority = {
      expectedVerifiedCheckpointId: hash("gateway-cas-checkpoint-id"),
      expectedVerifiedCheckpointHash: hash("gateway-cas-checkpoint-hash"),
      expectedApprovalRevision: 0,
    };
    let approvalStatus: ApprovalRequestRecord["status"] = "PENDING";
    let approvalRevision = 0;
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "gateway-real-cas-identity-secret" });
    const approval = (): ApprovalRequestRecord => ({
      approvalRequestId: "approval-real-cas", runId: "run-real-cas", riskTier: "HIGH",
      assignedReviewerId: principal.reviewerId, requestedAt: "2026-07-17T09:00:00.000Z",
      deadlineAt: "2026-07-19T09:00:00.000Z", reminderSchedule: [], timeoutAction: "HUMAN_REVIEW_REQUIRED",
      manifestHash: hash("gateway-cas-manifest"), diffHash: hash("gateway-cas-diff"),
      evidenceBundleHash: hash("gateway-cas-bundle"), reviewerSessionId: "reviewer-real-cas",
      classificationHash: hash("gateway-cas-classification"), classificationResult: "READY",
      status: approvalStatus, approvalRevision, verifiedCheckpointId: authority.expectedVerifiedCheckpointId,
      verifiedCheckpointHash: authority.expectedVerifiedCheckpointHash,
    });
    const run = (): EngineerRun => ({
      runId: "run-real-cas", userId: principal.ownerId,
      repository: { repositoryId: "repo-real-cas", provider: "github", owner: "o", name: "r", baseBranch: "main", baseCommitSha: "d".repeat(40) },
      requestOriginal: "change", requestNormalized: "change", state: "HUMAN_APPROVAL_PENDING", stateVersion: 9,
      manifestHash: approval().manifestHash, riskTier: "HIGH", humanGateRequired: true,
      createdAt: "2026-07-17T09:00:00.000Z", updatedAt: "2026-07-17T09:00:00.000Z", terminalAt: null,
    });
    const evidence = () => ({
      runId: run().runId, reviewerSessionId: "reviewer-real-cas", reviewerDecision: "APPROVE" as const,
      classificationHash: approval().classificationHash!, classificationResult: "READY" as const,
      reviewerDiffHash: approval().diffHash, reviewerEvidenceBundleHash: approval().evidenceBundleHash,
      reviewerIsolationVerified: true as const, evidenceBundleId: "bundle-real-cas",
      evidenceBundleHash: approval().evidenceBundleHash, resultCommitSha: "b".repeat(40),
      allRequiredChecksPassed: true, openCriticalSecurityFindings: 0,
    });
    const supervisor = {
      getRun: () => run(), latestApprovalRequest: () => approval(), getPublicationEvidence: () => evidence(),
      async getVerifiedCandidateCheckpoint() {
        arrivals += 1;
        if (arrivals === 2) release();
        await bothArrived;
        return { checkpoint: {
          checkpointId: authority.expectedVerifiedCheckpointId, checkpointHash: authority.expectedVerifiedCheckpointHash,
          runId: run().runId, manifestHash: approval().manifestHash, diffHash: approval().diffHash,
          evidenceBundleHash: approval().evidenceBundleHash, reviewerSessionId: approval().reviewerSessionId,
          classificationHash: approval().classificationHash, classificationResult: approval().classificationResult,
        }, attestation: {} };
      },
      extendApproval: (decision: { expectedApprovalRevision: number }, deadlineAt: string, reminders: string[]) => {
        if (approvalStatus !== "PENDING" || approvalRevision !== decision.expectedApprovalRevision) {
          throw new IdempotencyConflictError(run().runId, "approval-extension:approval-real-cas");
        }
        approvalRevision += 1;
        return { ...approval(), deadlineAt, reminderSchedule: reminders };
      },
    } as unknown as EngineerSupervisor;
    const publication = new EngineerPublicationManager({
      supervisor, artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      diffForRun: () => "gateway-cas-diff", commandSigningSecret: "gateway-real-cas-signing-secret-at-least-32-bytes",
      checkpointAttestor: { algorithm: "test", keyId: "test", sign: () => "test", verify: () => true },
      gitService: {
        async inspectBaseBranch() { throw new Error("unused"); }, async createRunBranch() { throw new Error("unused"); },
        async pushVerifiedCommit() { throw new Error("unused"); }, async createPullRequest() { throw new Error("unused"); },
      },
    });
    const engineerRuns = new EngineerRunManager({
      supervisor, publication, principal,
      preflight: {
        readiness: () => ({ state: "READY", error: null }),
        assertRunAdmission: async () => {},
      } as unknown as EngineerCapabilityPreflight,
    });
    const handler = makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns });
    const request = () => new Request("http://x/v1/engineer/runs/run-real-cas/extend-approval", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Need exact review time", extensionSeconds: 60, ...authority }),
    });
    const responses = await Promise.all([handler(request()), handler(request())]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await responses.find((response) => response.status === 409)!.json()).toEqual({
      error: {
        code: "ENGINEER_CANDIDATE_CHANGED",
        message: "Candidate changed since this approval was displayed. Refresh the approval and review the current checkpoint before deciding.",
        action: "REFRESH_APPROVAL",
      },
    });
    rmSync(root, { recursive: true, force: true });
  });

  test("Engineer run intake and reads use the gateway bearer boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-gateway-engineer-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "handler-test-install-secret" });
    const preflight = new EngineerCapabilityPreflight({
      models: ["test-model"], publicationEnabled: false,
      repository: { repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "1".repeat(40), originUrl: "file:///fixture" },
      probe: {
        model: async () => ({ available: true, responsesApi: true, strictStructuredOutputs: true }),
        docker: async () => ({ available: true }), image: async () => ({ exactDigest: true }),
        repository: async () => ({ readable: true, exactBaseCommit: true }),
        publication: async () => ({ available: true, pullRequestsWritable: true }),
      },
    });
    await preflight.assertStartup();
    const artifactStore = new LocalArtifactStore({ root: join(root, "artifacts") });
    const engineerRuns = new EngineerRunManager({ supervisor, principal, preflight, artifactStore, diffForRun: () => "diff --git a/a b/a" });
    const handler = makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns });
    const repository = await handler(new Request("http://x/v1/engineer/repository", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(repository.status).toBe(200);
    expect((await repository.json()) as unknown).toEqual({ repository: {
      repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture",
      baseBranch: "main", baseCommitSha: "1".repeat(40), url: "file:///fixture",
    } });
    const repositories = await handler(new Request("http://x/v1/engineer/repositories", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(repositories.status).toBe(200);
    expect((await repositories.json()) as { repositories: unknown[] }).toEqual({ repositories: [{
      repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture",
      baseBranch: "main", baseCommitSha: "1".repeat(40), url: "file:///fixture",
    }] });
    const body = JSON.stringify({
      runId: "gateway-run-1",
      userId: "user-1",
      repository: {
        repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture",
        baseBranch: "main", baseCommitSha: "1".repeat(40),
      },
      request: "Add a bounded feature",
      budget: { tokenBudget: 0, lifetimeTokenBudget: 1_000 },
    });
    expect((await handler(new Request("http://x/v1/engineer/runs", { method: "POST", body }))).status).toBe(401);
    const created = await handler(new Request("http://x/v1/engineer/runs", {
      method: "POST", body, headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    }));
    expect(created.status).toBe(201);
    expect(supervisor.getRun("gateway-run-1").userId).not.toBe("user-1");
    const read = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { run: { state: string }; budget: { limits: { tokens: number } } };
    expect(readBody.run.state).toBe("PAUSED_BUDGET");
    expect(readBody.budget.limits.tokens).toBe(0);
    const snapshot = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/snapshot", { headers: { Authorization: "Bearer secret" } }));
    expect(snapshot.status).toBe(200);
    const snapshotBody = (await snapshot.json()) as { status: { run: { runId: string } }; data: { artifacts: unknown[]; errors: unknown[] } };
    expect(snapshotBody.status.run.runId).toBe("gateway-run-1");
    expect(snapshotBody.data.artifacts).toEqual([]);
    expect(snapshotBody.data.errors).toEqual([]);
    const paused = engineerRuns.get("gateway-run-1");
    const topUp = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/budget/top-up", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: paused.budget.revision, idempotencyKey: "gateway-top-up", addTokenBudget: 200 }),
    }));
    expect(topUp.status).toBe(200);
    const topped = (await topUp.json()) as { budget: { revision: number; limits: { tokens: number } } };
    expect(topped.budget.limits.tokens).toBe(200);
    const resume = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/resume-budget", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedStateVersion: paused.run.stateVersion, expectedBudgetRevision: topped.budget.revision, idempotencyKey: "gateway-resume" }),
    }));
    expect(resume.status).toBe(200);
    expect(((await resume.json()) as { run: { state: string } }).run.state).toBe("REQUEST_RECEIVED");
    const plan = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/plan", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(plan.status).toBe(200);
    expect((await plan.json()) as unknown).toEqual({ plan: null });
    const artifacts = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/artifacts", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(artifacts.status).toBe(200);
    expect((await artifacts.json()) as unknown).toEqual({ artifacts: [] });
    const storedArtifact = supervisor.recordArtifact(artifactStore.put({
      runId: "gateway-run-1", type: "COMMAND_STDOUT", bytes: "safe output", producerType: "EXECUTOR", producerId: "test-executor", trusted: true,
    }));
    const ordinaryRunClassifier=supervisor.isOptionalHardeningChild.bind(supervisor),
      exactRead=artifactStore.readVerifiedExact.bind(artifactStore);let exactReadCount=0;
    supervisor.isOptionalHardeningChild=(()=>true) as never;
    artifactStore.readVerifiedExact=((artifact:Parameters<typeof exactRead>[0])=>{
      exactReadCount+=1;return exactRead(artifact);}) as never;
    const preview = await handler(new Request(`http://x/v1/engineer/runs/gateway-run-1/artifacts/${storedArtifact.artifactId}`, {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { content: string; artifact: Record<string, unknown> };
    expect(previewBody.content).toBe("safe output");
    expect(previewBody.artifact).not.toHaveProperty("storageReference");
    const largeBytes = Buffer.alloc((1024 * 1024) + 2);
    for (let index = 0; index < largeBytes.byteLength; index += 1) largeBytes[index] = index % 251;
    const largeArtifact = supervisor.recordArtifact(artifactStore.put({
      runId: "gateway-run-1", type: "COMMAND_STDOUT", bytes: largeBytes, producerType: "EXECUTOR", producerId: "test-executor", trusted: true,
    }));
    const wholeFileRead = artifactStore.read.bind(artifactStore),verifiedChunks=artifactStore.verifiedChunks.bind(artifactStore);
    artifactStore.read = () => { throw new Error("evidence stream must not use the whole-file reader"); };
    artifactStore.verifiedChunks=(async function*(){throw new Error("hardening evidence stream must not use legacy chunks");}) as never;
    const evidenceStream = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/evidence-stream", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(evidenceStream.status).toBe(200);
    const streamReader = evidenceStream.body!.getReader();
    const streamChunks: Buffer[] = [];
    let largestStreamChunk = 0;
    while (true) {
      const next = await streamReader.read();
      if (next.done) break;
      largestStreamChunk = Math.max(largestStreamChunk, next.value.byteLength);
      streamChunks.push(Buffer.from(next.value));
    }
    const streamedEvidence = Buffer.concat(streamChunks).toString("utf8");
    artifactStore.read=wholeFileRead;artifactStore.verifiedChunks=verifiedChunks;
    supervisor.isOptionalHardeningChild=ordinaryRunClassifier as never;
    expect(exactReadCount).toBeGreaterThanOrEqual(3);
    expect(largestStreamChunk).toBeLessThan(largeBytes.byteLength);
    expect(streamedEvidence).toContain('"type":"artifactPayload"');
    expect(streamedEvidence).toContain('"type":"checksum"');
    expect(streamedEvidence).not.toContain("storageReference");
    expect(streamedEvidence).not.toContain("storage_reference");
    expect(streamedEvidence).not.toContain(root);
    const evidenceLines = streamedEvidence.trimEnd().split("\n");
    const checksum = JSON.parse(evidenceLines.at(-1)!) as { type: string; algorithm: string; value: string };
    expect(checksum).toEqual({ type: "checksum", algorithm: "sha256", value: `sha256:${createHash("sha256").update(`${evidenceLines.slice(0, -1).join("\n")}\n`).digest("hex")}` });
    const payload = evidenceLines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.type === "artifactPayload" && line.artifactId === largeArtifact.artifactId) as { content: string } | undefined;
    expect(payload).toBeDefined();
    expect(Buffer.from(payload!.content, "base64")).toEqual(largeBytes);
    const claims = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/claims", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(claims.status).toBe(200);
    expect((await claims.json()) as unknown).toEqual({ claims: [] });
    const evidence = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/evidence", {
      headers: { Authorization: "Bearer secret" },
    }));
    expect(evidence.status).toBe(200);
    expect((await evidence.json()) as unknown).toEqual({ evidenceBundles: [] });
    const tests = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/tests", { headers: { Authorization: "Bearer secret" } }));
    expect((await tests.json()) as unknown).toEqual({ tests: [] });
    const security = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/security", { headers: { Authorization: "Bearer secret" } }));
    expect((await security.json()) as unknown).toEqual({ securityFindings: [] });
    const failures = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/failures", { headers: { Authorization: "Bearer secret" } }));
    expect((await failures.json()) as unknown).toEqual({ failures: [] });
    const gitOperations = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/git-operations", { headers: { Authorization: "Bearer secret" } }));
    expect((await gitOperations.json()) as unknown).toEqual({ gitOperations: [] });
    const diff = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/diff", { headers: { Authorization: "Bearer secret" } }));
    expect((await diff.json()) as unknown).toEqual({ diff: "diff --git a/a b/a" });
    const approval = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/approval", { headers: { Authorization: "Bearer secret" } }));
    expect((await approval.json()) as unknown).toEqual({ approval: null, approvalAuthority: null });
    const observability = await handler(new Request("http://x/v1/engineer/observability", { headers: { Authorization: "Bearer secret" } }));
    expect(observability.status).toBe(200);
    expect(((await observability.json()) as { snapshot: { totalRuns: number; runsByState: Record<string, number> } }).snapshot).toMatchObject({
      totalRuns: 1,
      activeRuns: 1,
      stuckRuns: 0,
      estimatedCostUsd: 0,
      cachedInputTokens: 0,
      retryAttempts: 0,
      runsByState: { REQUEST_RECEIVED: 1 },
      runHealth: [{ runId: "gateway-run-1", state: "REQUEST_RECEIVED", stuck: false }],
    });
    const runList = await handler(new Request("http://x/v1/engineer/runs", { headers: { Authorization: "Bearer secret" } }));
    expect(((await runList.json()) as { runs: Array<{ runId: string }> }).runs.map((run) => run.runId)).toEqual(["gateway-run-1"]);
    const cancelled = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/cancel", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: "another-user", reason: "Attempt to cancel another user's run." }),
    }));
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { run: { state: string } }).run.state).toBe("CANCELLED");
    const resumed = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/events?afterSequence=1", { headers: { Authorization: "Bearer secret", "Last-Event-ID": "0" } }));
    expect(resumed.headers.get("X-Zintus-Engineer-Review-Approved-Terminal")).toBe("true");
    expect(resumed.headers.get("Access-Control-Expose-Headers")).toContain("X-Zintus-Engineer-Review-Approved-Terminal");
    expect(resumed.headers.get("Access-Control-Allow-Headers")).toContain("Last-Event-ID");
    const resumedText = await resumed.text();
    expect(resumedText).not.toContain("id: 1\n");
    expect(resumedText).toContain("id: 2\n");
    expect(resumedText).toContain("retry: 1000");
    supervisor.isOptionalHardeningChild=(()=>true) as never;
    artifactStore.read=()=>{throw new Error("hardening evidence export must not use legacy reads");};
    const exported = await handler(new Request("http://x/v1/engineer/runs/gateway-run-1/evidence-export", { headers: { Authorization: "Bearer secret" } }));
    expect(exported.headers.get("content-disposition")).toContain("gateway-run-1");
    const exportedBody=await exported.json() as {exportHash?:string};
    expect(exportedBody).toMatchObject({ exportHash: expect.stringMatching(/^sha256:/) });
    expect(JSON.stringify(exportedBody)).not.toContain("storageReference");
    expect(JSON.stringify(exportedBody)).not.toContain("storage_reference");
    expect(JSON.stringify(exportedBody)).not.toContain(root);
    artifactStore.read=wholeFileRead;artifactStore.readVerifiedExact=exactRead;supervisor.isOptionalHardeningChild=ordinaryRunClassifier as never;
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("Engineer startup readiness is fail-closed and recovers only through an explicit retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-gateway-engineer-readiness-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "readiness-test-install" });
    let ready = false;
    let repositoryReady = false;
    const preflight = new EngineerCapabilityPreflight({
      models: ["exact-model"], publicationEnabled: false,
      repository: { repositoryId: "repo-ready", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "1".repeat(40), originUrl: "file:///fixture" },
      probe: {
        model: async () => ({ available: ready, responsesApi: ready, strictStructuredOutputs: ready }),
        docker: async () => ({ available: ready }), image: async () => ({ exactDigest: ready }),
        repository: async () => ({ readable: repositoryReady, exactBaseCommit: repositoryReady }),
        publication: async () => ({ available: ready, pullRequestsWritable: ready }),
      },
    });
    const manager = new EngineerRunManager({ supervisor, principal, preflight });
    const handler = makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns: manager });
    expect((await handler(new Request("http://x/health"))).status).toBe(503);
    const failed = await handler(new Request("http://x/v1/engineer/readiness/retry", { method: "POST", headers: { Authorization: "Bearer secret" } }));
    expect(failed.status).toBe(503);
    expect(supervisor.listRuns()).toEqual([]);
    ready = true;
    repositoryReady = true;
    const recovered = await handler(new Request("http://x/v1/engineer/readiness/retry", { method: "POST", headers: { Authorization: "Bearer secret" } }));
    expect(recovered.status).toBe(200);
    expect((await handler(new Request("http://x/health"))).status).toBe(200);
    const created = await handler(new Request("http://x/v1/engineer/runs", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "ready-run", repository: { repositoryId: "repo-ready", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "1".repeat(40) }, request: "work" }),
    }));
    expect(created.status).toBe(201);
    repositoryReady = false;
    const blockedCreate = await handler(new Request("http://x/v1/engineer/runs", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "must-not-exist", repository: { repositoryId: "repo-ready", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "1".repeat(40) }, request: "work" }),
    }));
    expect(blockedCreate.status).toBe(503);
    expect(supervisor.listRuns().map((run) => run.runId)).toEqual(["ready-run"]);
    const blockedCancel = await handler(new Request("http://x/v1/engineer/runs/ready-run/cancel", {
      method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "must not mutate while repository capability is lost" }),
    }));
    expect(blockedCancel.status).toBe(503);
    expect(supervisor.getRun("ready-run").state).toBe("REQUEST_RECEIVED");
    expect((await handler(new Request("http://x/health"))).status).toBe(503);
    expect((await handler(new Request("http://x/v1/engineer/readiness/retry", { method: "POST", headers: { Authorization: "Bearer secret" } }))).status).toBe(503);
    repositoryReady = true;
    expect((await handler(new Request("http://x/v1/engineer/readiness/retry", { method: "POST", headers: { Authorization: "Bearer secret" } }))).status).toBe(200);
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("GET /health is public and reports auth state", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(new Request("http://x/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; auth: string };
    expect(body.ok).toBe(true);
    expect(body.auth).toBe("required");
  });

  test("GET /health reports 503 while draining", async () => {
    const handler = makeHandler({ token: "secret" }, fakeEngine(), {
      getDraining: () => true,
    });
    const res = await handler(new Request("http://x/health"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; status?: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("draining");
  });

  test("GET /health no longer leaks provider topology", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(new Request("http://x/health"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.providers).toBeUndefined();
    expect(body.savings).toBeUndefined();
  });

  test("GET /v1/status requires auth and returns provider topology", async () => {
    const handler = makeHandler({ token: "secret" });
    // Unauthenticated → 401
    const unauth = await handler(
      new Request("http://x/v1/status", { method: "GET" }),
    );
    expect(unauth.status).toBe(401);
    // Authenticated → topology + savings
    const res = await handler(
      new Request("http://x/v1/status", {
        method: "GET",
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: unknown[]; savings: unknown };
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.savings).toBeDefined();
  });

  test("rejects a structurally invalid chat body with 400 + issues", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        // content must be a string; provider must be a known id.
        body: JSON.stringify({
          messages: [{ role: "user", content: 123 }],
          provider: "not-a-real-provider",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; issues?: unknown[] };
    };
    expect(body.error.message).toBe("Invalid request body");
    expect(Array.isArray(body.error.issues)).toBe(true);
  });

  test("rejects an invalid research body with 400 + issues (zod)", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(
      new Request("http://x/v1/research", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        // depth must be one of quick|standard|deep.
        body: JSON.stringify({ query: "hi", depth: "ludicrous" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Invalid request body");
  });

  test("rate limiter returns 429 with Retry-After once budget is exhausted", async () => {
    const handler = makeHandler({ token: "secret" }, fakeEngine(), {
      rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    const make = () =>
      handler(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer secret",
            "x-forwarded-for": "1.2.3.4",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: "hi" }],
            stream: false,
          }),
        }),
      );
    const first = await make();
    expect(first.status).toBe(200);
    const second = await make();
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
  });

  test("returns 401 on protected route without a token", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(
      new Request("http://x/v1/models", { method: "GET" }),
    );
    expect(res.status).toBe(401);
  });

  test("allows protected route with a valid bearer token", async () => {
    const handler = makeHandler({ token: "secret" });
    const res = await handler(
      new Request("http://x/v1/models", {
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("GET /v1/models returns a RICH per-model catalog (OpenAI-compat triple + metadata)", async () => {
    const handler = makeHandler();
    const res = await handler(new Request("http://x/v1/models", { method: "GET" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<Record<string, unknown>>;
    };
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);

    // OpenAI-compat triple intact on every entry.
    for (const m of body.data) {
      expect(typeof m.id).toBe("string");
      expect(m.object).toBe("model");
      expect(typeof m.owned_by).toBe("string");
    }

    // A known model carries the additive metadata.
    const flash = body.data.find((m) => m.id === "gemini-2.5-flash") as
      | {
          context_window: number;
          capabilities: { vision: boolean; tools: boolean; structured_output: string };
          pricing: { input_per_1m: number | null; output_per_1m: number | null };
          free: boolean;
          local: boolean;
          data_policy: Record<string, unknown>;
        }
      | undefined;
    expect(flash).toBeDefined();
    expect(flash?.context_window).toBe(1_000_000);
    expect(flash?.capabilities.vision).toBe(true);
    expect(flash?.capabilities.tools).toBe(true);
    expect(flash?.capabilities.structured_output).toBe("json_schema");
    expect(flash?.pricing.input_per_1m).toBe(0.3);
    expect(flash?.pricing.output_per_1m).toBe(2.5);
    // `free` = a free tier/quota exists (the catalog's honest semantic); Gemini
    // 2.5 Flash has both paid list pricing AND a free tier, so free:true.
    expect(flash?.free).toBe(true);
    expect(flash?.local).toBe(false);
    expect(typeof flash?.data_policy).toBe("object");
    expect(flash?.data_policy.tag).toBeDefined();
  });

  test("GET /v1/models?vision=true narrows the catalog to vision-capable models", async () => {
    const handler = makeHandler();
    const all = (await (
      await handler(new Request("http://x/v1/models", { method: "GET" }))
    ).json()) as { data: unknown[] };
    const visionRes = await handler(
      new Request("http://x/v1/models?vision=true", { method: "GET" }),
    );
    expect(visionRes.status).toBe(200);
    const vision = (await visionRes.json()) as {
      data: Array<{ id: string; capabilities: { vision: boolean } }>;
    };
    expect(vision.data.length).toBeGreaterThan(0);
    expect(vision.data.length).toBeLessThan(all.data.length); // actually narrowed
    expect(vision.data.every((m) => m.capabilities.vision === true)).toBe(true);
    expect(vision.data.some((m) => m.id === "gemini-2.5-flash")).toBe(true);
  });

  test("GET /v1/models?provider= filters to a single provider", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/models?provider=groq", { method: "GET" }),
    );
    const body = (await res.json()) as {
      data: Array<{ owned_by: string; id: string }>;
    };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((m) => m.owned_by === "Groq")).toBe(true);
  });

  test("GET /v1/pricing returns priced models and is auth-gated", async () => {
    // Auth-gated when a token is configured.
    const guarded = makeHandler({ token: "secret" });
    expect(
      (await guarded(new Request("http://x/v1/pricing", { method: "GET" }))).status,
    ).toBe(401);

    const handler = makeHandler();
    const res = await handler(new Request("http://x/v1/pricing", { method: "GET" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{
        id: string;
        provider: string;
        input_per_1m: number;
        output_per_1m: number;
        free: boolean;
      }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    // Every entry has a concrete (non-null) price.
    for (const p of body.data) {
      expect(typeof p.input_per_1m).toBe("number");
      expect(typeof p.output_per_1m).toBe("number");
      expect(typeof p.provider).toBe("string");
    }
    const flash = body.data.find((p) => p.id === "gemini-2.5-flash");
    expect(flash?.input_per_1m).toBe(0.3);
    expect(flash?.output_per_1m).toBe(2.5);
  });

  test("GET /v1/traces?limit= returns recent traces and is auth-gated", async () => {
    const startedAt = new Date();
    const engine = fakeEngine({
      listTraces: (limit: number) =>
        Array.from({ length: Math.min(limit, 2) }, (_unused, i) => ({
          traceId: `t-${i}`,
          startedAt,
          attempts: [],
        })),
    });

    // Auth-gated when a token is configured.
    const guarded = makeHandler({ token: "secret" }, engine);
    expect((await guarded(new Request("http://x/v1/traces?limit=5"))).status).toBe(
      401,
    );

    const handler = makeHandler({}, engine);
    const res = await handler(new Request("http://x/v1/traces?limit=5"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { traces: Array<{ traceId: string }> };
    expect(body.traces).toHaveLength(2);
    expect(body.traces[0]?.traceId).toBe("t-0");
  });

  test("GET /v1/activity returns normalized usage entries, respects ?limit, and is auth-gated", async () => {
    const startedAt = new Date("2026-06-28T00:00:00.000Z");
    const engine = fakeEngine({
      // The handler fetches limit+1 to compute has_more honestly.
      listTraces: (limit: number) =>
        Array.from({ length: Math.min(limit, 3) }, (_unused, i) => ({
          traceId: `act-${i}`,
          startedAt,
          attempts: [
            {
              providerId: "groq" as const,
              model: "test-model",
              status: "success" as const,
              latencyMs: 42,
            },
          ],
          winner: { providerId: "groq" as const, model: "test-model" },
          totalLatencyMs: 100,
        })),
    });

    // Auth-gated when a token is configured.
    const guarded = makeHandler({ token: "secret" }, engine);
    expect(
      (await guarded(new Request("http://x/v1/activity"))).status,
    ).toBe(401);

    const handler = makeHandler({}, engine);
    const res = await handler(new Request("http://x/v1/activity?limit=2"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      has_more: boolean;
      data: Array<Record<string, unknown>>;
    };
    expect(body.object).toBe("list");
    // Asked for 2 → page of 2, and a 3rd existed → has_more true.
    expect(body.data).toHaveLength(2);
    expect(body.has_more).toBe(true);

    const entry = body.data[0] as {
      id: string;
      created: number;
      provider: string;
      model: string;
      tokens: { input: number; output: number; total: number };
      cost_usd: number;
      saved_vs_baseline_usd: number;
      latency_ms: number;
      cache_hit: boolean;
      route_reason?: string;
    };
    expect(entry.id).toBe("act-0");
    expect(entry.created).toBe(Math.floor(startedAt.getTime() / 1000));
    expect(entry.provider).toBe("groq");
    expect(entry.model).toBe("test-model");
    // No token usage recorded on the trace → honest zeros, never fabricated.
    expect(entry.tokens).toEqual({ input: 0, output: 0, total: 0 });
    expect(entry.cost_usd).toBe(0);
    expect(entry.saved_vs_baseline_usd).toBe(0);
    expect(entry.latency_ms).toBe(100);
    expect(entry.cache_hit).toBe(false);
    // route_reason omitted when the trace did not record one.
    expect(entry.route_reason).toBeUndefined();
  });

  test("GET /v1/activity surfaces real recorded usage and is empty when none", async () => {
    // A trace carrying optional usage telemetry → flows through normalized.
    const richEngine = fakeEngine({
      listTraces: () => [
        {
          traceId: "act-rich",
          startedAt: new Date("2026-06-28T00:00:00.000Z"),
          attempts: [],
          winner: { providerId: "cerebras" as const, model: "llama" },
          // Extended fields a trace MAY carry; read defensively.
          tokens: { input: 10, output: 5, total: 15 },
          cacheHit: true,
          routeReason: "cheapest-healthy",
        } as never,
      ],
    });
    const handler = makeHandler({}, richEngine);
    const res = await handler(new Request("http://x/v1/activity"));
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const entry = body.data[0] as Record<string, unknown>;
    expect(entry.tokens).toEqual({ input: 10, output: 5, total: 15 });
    expect(entry.cache_hit).toBe(true);
    expect(entry.route_reason).toBe("cheapest-healthy");
    expect(entry.provider).toBe("cerebras");

    // Empty list when no usage has been recorded.
    const emptyHandler = makeHandler({}, fakeEngine({ listTraces: () => [] }));
    const emptyRes = await emptyHandler(new Request("http://x/v1/activity"));
    const emptyBody = (await emptyRes.json()) as {
      data: unknown[];
      has_more: boolean;
    };
    expect(emptyBody.data).toEqual([]);
    expect(emptyBody.has_more).toBe(false);
  });

  test("GET /v1/activity reads the DURABLE store first, honoring ?since/?limit/?provider + retention_days", async () => {
    const store = new ActivityStore(
      join(mkdtempSync(join(tmpdir(), "zintus-activity-h-")), "activity.db"),
    );
    const base = Math.floor(Date.UTC(2026, 5, 28, 0, 0, 0) / 1000);
    store.recordActivity({
      traceId: "d-old",
      created: base - 10_000,
      provider: "cerebras",
      model: "llama-3.1-8b",
      inputTokens: 5,
      outputTokens: 2,
      costUsd: 0,
      savedVsBaselineUsd: 0,
      latencyMs: 30,
      cacheHit: false,
      routeReason: null,
    });
    store.recordActivity({
      traceId: "d-new",
      created: base,
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0,
      savedVsBaselineUsd: 0.0009,
      latencyMs: 120,
      cacheHit: false,
      routeReason: "cheapest-healthy",
    });

    // Engine traces are non-empty; the durable store must take precedence.
    const engine = fakeEngine({
      listTraces: () => [
        { traceId: "trace-only", startedAt: new Date(), attempts: [] },
      ],
    });
    const handler = makeHandler({}, engine, { activityStore: store });

    const res = await handler(new Request("http://x/v1/activity"));
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
      has_more: boolean;
      retention_days: number;
    };
    // Durable rows (newest-first), not the trace ring.
    expect(body.data.map((e) => e.id)).toEqual(["d-new", "d-old"]);
    expect(body.retention_days).toBe(30);
    const top = body.data[0] as Record<string, unknown>;
    expect(top.tokens).toEqual({ input: 10, output: 5, total: 15 });
    expect(top.cost_usd).toBe(0);
    expect(top.route_reason).toBe("cheapest-healthy");

    // ?since drops the older row.
    const sinceRes = await handler(
      new Request(`http://x/v1/activity?since=${base - 100}`),
    );
    const sinceBody = (await sinceRes.json()) as { data: Array<{ id: string }> };
    expect(sinceBody.data.map((e) => e.id)).toEqual(["d-new"]);

    // ?provider filter.
    const provRes = await handler(
      new Request("http://x/v1/activity?provider=cerebras"),
    );
    const provBody = (await provRes.json()) as { data: Array<{ id: string }> };
    expect(provBody.data.map((e) => e.id)).toEqual(["d-old"]);

    // ?limit caps the page and drives has_more honestly.
    const limitRes = await handler(new Request("http://x/v1/activity?limit=1"));
    const limitBody = (await limitRes.json()) as {
      data: unknown[];
      has_more: boolean;
    };
    expect(limitBody.data).toHaveLength(1);
    expect(limitBody.has_more).toBe(true);

    store.close();
  });

  test("GET /v1/activity falls back to the trace path when the durable store is empty", async () => {
    const store = new ActivityStore(
      join(mkdtempSync(join(tmpdir(), "zintus-activity-e-")), "activity.db"),
    );
    const engine = fakeEngine({
      listTraces: () => [
        {
          traceId: "fallback-trace",
          startedAt: new Date("2026-06-28T00:00:00.000Z"),
          attempts: [],
          winner: { providerId: "groq" as const, model: "test-model" },
          totalLatencyMs: 50,
        },
      ],
    });
    const handler = makeHandler({}, engine, { activityStore: store });
    const res = await handler(new Request("http://x/v1/activity"));
    const body = (await res.json()) as {
      data: Array<{ id: string }>;
      retention_days?: number;
    };
    // Empty store → trace-derived entry, and no retention_days on the fallback.
    expect(body.data.map((e) => e.id)).toEqual(["fallback-trace"]);
    expect(body.retention_days).toBeUndefined();
    store.close();
  });

  test("POST /v1/keys/validate guards its contract (no network in these paths)", async () => {
    const handler = makeHandler({}, fakeEngine({}));
    const post = (body: unknown) =>
      handler(
        new Request("http://x/v1/keys/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    // Unknown provider, local runtimes (no key concept), and a missing key are
    // all 400s with honest messages; auth applies like every /v1/* route.
    expect((await post({ providerId: "not-a-provider", key: "x" })).status).toBe(400);
    const local = await post({ providerId: "ollama", key: "x" });
    expect(local.status).toBe(400);
    expect(JSON.stringify(await local.json())).toContain("local runtime");
    expect((await post({ providerId: "groq" })).status).toBe(400);
    const badJson = await handler(
      new Request("http://x/v1/keys/validate", { method: "POST", body: "{nope" }),
    );
    expect(badJson.status).toBe(400);

    const guarded = makeHandler({ token: "secret" }, fakeEngine({}));
    const denied = await guarded(
      new Request("http://x/v1/keys/validate", {
        method: "POST",
        body: JSON.stringify({ providerId: "groq", key: "k" }),
      }),
    );
    expect(denied.status).toBe(401);
  });

  test("GET /v1/key returns per-provider quota status (null limit when unreported) and is auth-gated", async () => {
    const engine = fakeEngine({
      async getProviderStatus() {
        return [
          {
            id: "groq",
            name: "Groq",
            color: "#fff",
            priority: 1,
            available: true,
            hasKey: true,
            inCooldown: false,
            cooldownUntil: null,
            requestsToday: 3,
            tokensToday: 250,
            lastReset: null,
            tokensLimit: 1000,
          },
          {
            id: "ollama",
            name: "Ollama",
            color: "#000",
            priority: 2,
            available: true,
            hasKey: false,
            inCooldown: false,
            cooldownUntil: null,
            requestsToday: 0,
            tokensToday: 0,
            lastReset: null,
            // No tokensLimit → quota_limit must be null (never fabricated).
          },
        ];
      },
    });

    // Auth-gated.
    const guarded = makeHandler({ token: "secret" }, engine);
    expect((await guarded(new Request("http://x/v1/key"))).status).toBe(401);

    const handler = makeHandler({}, engine);
    const res = await handler(new Request("http://x/v1/key"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      label: string;
      is_free_tier: boolean;
      managed_keys_available: boolean;
      providers: Array<{
        id: string;
        has_key: boolean;
        quota_used: number;
        quota_limit: number | null;
        quota_remaining_ratio: number | null;
      }>;
    };
    expect(body.object).toBe("key_status");
    expect(body.label).toBe("zintus-gateway");
    expect(body.is_free_tier).toBe(true);
    expect(body.managed_keys_available).toBe(false);

    const groq = body.providers.find((p) => p.id === "groq");
    expect(groq?.quota_limit).toBe(1000);
    expect(groq?.quota_used).toBe(250);
    expect(groq?.quota_remaining_ratio).toBeCloseTo(0.75);

    const ollama = body.providers.find((p) => p.id === "ollama");
    expect(ollama?.has_key).toBe(false);
    // Honest: no reported denominator → null, not a fabricated cap.
    expect(ollama?.quota_limit).toBeNull();
    expect(ollama?.quota_remaining_ratio).toBeNull();
  });

  test("streams chat completions as SSE", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("Hello");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("emits a per-response metadata event with savings before [DONE]", async () => {
    const engine = fakeEngine({
      async routeAndStream(request) {
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-1",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "Hi";
            // The winning provider's usage fires when its stream completes.
            request.onUsage?.({
              providerId: "groq",
              model: "llama-3.3-70b-versatile",
              inputTokens: 100,
              outputTokens: 200,
              latencyMs: 42,
            });
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          strategy: "fastest",
        }),
      }),
    );
    const text = await res.text();
    const metaLine = text
      .split("\n")
      .find((line) => line.includes('"type":"metadata"'));
    expect(metaLine).toBeDefined();
    const meta = JSON.parse(metaLine!.replace("data: ", "")) as {
      provider: string;
      model: string;
      tokens: { input: number; output: number };
      cost_usd: number;
      saved_vs_claude_sonnet: number;
      routing_strategy: string;
    };
    expect(meta.provider).toBe("groq");
    expect(meta.tokens.output).toBe(200);
    expect(meta.cost_usd).toBe(0);
    expect(meta.routing_strategy).toBe("fastest");
    // 100 * $3/MTok + 200 * $15/MTok = 0.0003 + 0.003 = 0.0033
    expect(meta.saved_vs_claude_sonnet).toBeCloseTo(0.0033, 6);
    // Metadata must precede the stream terminator.
    expect(text.indexOf('"type":"metadata"')).toBeLessThan(
      text.indexOf("[DONE]"),
    );
  });

  test("returns a single JSON completion when stream:false", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("Hello world");
  });

  test("rejects malformed chat requests with 400", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonsense: true }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("exposes routing metadata headers on a streamed response", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "test-model",
          traceId: "trace-2",
          cacheHit: "miss",
          failoverCount: 2,
          stream: (async function* () {
            yield "ok";
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.headers.get("X-Provider-Used")).toBe("groq");
    expect(res.headers.get("X-Cache-Hit")).toBe("miss");
    expect(res.headers.get("X-Failover-Count")).toBe("2");
    await res.text();
  });

  test("forwards virtual_key and provider_weights to the engine", async () => {
    let captured: { virtualKey?: string; providerWeights?: unknown } = {};
    const engine = fakeEngine({
      async routeAndStream(request) {
        captured = {
          virtualKey: request.virtualKey,
          providerWeights: request.providerWeights,
        };
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            yield "ok";
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          virtual_key: "vk-123",
          provider_weights: { groq: 3, gemini: 1 },
        }),
      }),
    );
    await res.text();
    expect(captured.virtualKey).toBe("vk-123");
    expect(captured.providerWeights).toEqual({ groq: 3, gemini: 1 });
  });

  test("rejects an oversized body with 413", async () => {
    const handler = makeHandler({ maxBodyBytes: 50 });
    const big = "x".repeat(500);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: big }] }),
      }),
    );
    expect(res.status).toBe(413);
  });

  test("rejects too many messages with 413", async () => {
    const handler = makeHandler({ maxMessages: 2 });
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "user", content: "1" },
            { role: "assistant", content: "2" },
            { role: "user", content: "3" },
          ],
        }),
      }),
    );
    expect(res.status).toBe(413);
  });

  test("returns 408 when the engine exceeds the request timeout", async () => {
    const engine = fakeEngine({
      routeAndStream() {
        return new Promise(() => {
          // never resolves — forces the gateway timeout to fire
        });
      },
    });
    const handler = makeHandler({ requestTimeoutMs: 20 }, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(408);
  });

  test("idle watchdog aborts a stalled stream and emits an error chunk", async () => {
    // A stream that yields once then stalls forever, and records whether the
    // upstream abort signal fired (the watchdog must tear the upstream down).
    let aborted = false;
    const engine = fakeEngine({
      async routeAndStream(request) {
        request.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            yield "first";
            // Stall: never yields again, ignores the abort (worst case).
            await new Promise<void>(() => {});
          })(),
        };
      },
    });
    const handler = makeHandler({ streamIdleTimeoutMs: 25 }, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    // First chunk made it through, then the watchdog surfaced the shared error
    // shape and closed the stream cleanly.
    expect(text).toContain("first");
    expect(text).toContain('"error"');
    expect(text).toContain("stalled");
    expect(text).not.toContain("[DONE]");
    expect(aborted).toBe(true);
  });

  test("idle watchdog does NOT abort a stream that keeps sending in time", async () => {
    let aborted = false;
    const engine = fakeEngine({
      async routeAndStream(request) {
        request.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            for (let i = 0; i < 5; i += 1) {
              // 10ms between chunks, comfortably under the 50ms idle window.
              await new Promise<void>((r) => setTimeout(r, 10));
              yield `chunk-${i}`;
            }
          })(),
        };
      },
    });
    const handler = makeHandler({ streamIdleTimeoutMs: 50 }, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    const text = await res.text();
    expect(text).toContain("chunk-0");
    expect(text).toContain("chunk-4");
    expect(text).not.toContain('"error"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(aborted).toBe(false);
  });

  test("idle watchdog disabled (0) never fires and leaves no timer", async () => {
    // With the watchdog disabled, a slow-but-progressing stream completes and
    // no idle timer is created (so nothing to leak). We assert normal DONE.
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            await new Promise<void>((r) => setTimeout(r, 15));
            yield "slow";
          })(),
        };
      },
    });
    const handler = makeHandler({ streamIdleTimeoutMs: 0 }, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    const text = await res.text();
    expect(text).toContain("slow");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("non-streaming chat is bounded by the idle watchdog (408 on mid-aggregation stall)", async () => {
    // The start timeout only guards routeAndStream() RESOLVING, not consuming
    // the buffered stream. A provider that connects then stalls mid-aggregation
    // would hang the `for await` forever — so the non-streaming branch now wraps
    // the read in the same idle watchdog. Prove it: a start that resolves fast
    // (under the large requestTimeoutMs) then a stream that never yields → 408,
    // and the upstream is aborted.
    let aborted = false;
    const engine = fakeEngine({
      async routeAndStream(request) {
        request.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          // Connect succeeds, but the stream stalls forever (no chunks).
          stream: (async function* () {
            await new Promise<void>(() => {});
            yield "never";
          })(),
        };
      },
    });
    const handler = makeHandler(
      { streamIdleTimeoutMs: 25, requestTimeoutMs: 5000 },
      engine,
    );
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      }),
    );
    expect(res.status).toBe(408);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("stalled");
    expect(aborted).toBe(true);
  });

  test("non-streaming chat completes 200 when chunks keep arriving in time", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          threadId: "thread-1",
          stream: (async function* () {
            for (let i = 0; i < 3; i += 1) {
              await new Promise<void>((r) => setTimeout(r, 10));
              yield `c${i}`;
            }
          })(),
        };
      },
    });
    const handler = makeHandler({ streamIdleTimeoutMs: 50 }, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0]?.message.content).toBe("c0c1c2");
  });

  test("unknown route returns 404", async () => {
    const handler = makeHandler();
    const res = await handler(new Request("http://x/nope"));
    expect(res.status).toBe(404);
  });

  test("GET /metrics is auth-gated when GATEWAY_TOKEN is set", async () => {
    const handler = makeHandler({ token: "secret" });
    await handler(new Request("http://x/health")); // one request recorded
    // Without auth → 401
    const unauthed = await handler(new Request("http://x/metrics"));
    expect(unauthed.status).toBe(401);
    // With auth → 200
    const authed = await handler(
      new Request("http://x/metrics", {
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as { requestsTotal: number };
    expect(body.requestsTotal).toBeGreaterThanOrEqual(1);
  });

  test("GET /metrics serves Prometheus text when requested", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/metrics", { headers: { accept: "text/plain" } }),
    );
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("zintus_gateway_requests_total");
  });

  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/chat/completions", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  // --- Tokzen compression-savings headers (X-Zintus-*) ---------------------

  // A highly compressible assistant log message: ~60 near-identical timestamped
  // lines collapse under Drain template mining, so compressedTokens <<
  // originalTokens. User messages are never compressed, so the user turn stays
  // verbatim — keeping a real "prompt" present to assert it never leaks.
  const SECRET_PROMPT = "summarize-these-logs-SUPER-SECRET";
  function compressibleLogBody(): string {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(
        `2026-06-25T12:00:${String(i % 60).padStart(2, "0")}.000Z INFO ` +
          `request handled id=${i} user=u${i} latency=${i}ms ` +
          `path=/api/v1/resource/${i} status=200`,
      );
    }
    return lines.join("\n");
  }
  const ZINTUS_HEADERS = [
    "X-Zintus-Original-Tokens",
    "X-Zintus-Compressed-Tokens",
    "X-Zintus-Tokens-Saved",
    "X-Zintus-Compression-Ratio",
    "X-Zintus-Cost-Saved-Usd",
  ];

  test("emits X-Zintus compression headers on a streamed response when context is compressed", async () => {
    // Known pricing pair so the cost header is present.
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-z",
          stream: (async function* () {
            yield "ok";
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://app" },
        body: JSON.stringify({
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "user", content: SECRET_PROMPT },
            { role: "assistant", content: compressibleLogBody() },
          ],
        }),
      }),
    );

    const original = Number(res.headers.get("X-Zintus-Original-Tokens"));
    const compressed = Number(res.headers.get("X-Zintus-Compressed-Tokens"));
    const saved = Number(res.headers.get("X-Zintus-Tokens-Saved"));
    const ratio = res.headers.get("X-Zintus-Compression-Ratio");
    const cost = res.headers.get("X-Zintus-Cost-Saved-Usd");

    // Token headers present + internally consistent math.
    expect(original).toBeGreaterThan(0);
    expect(compressed).toBeGreaterThan(0);
    expect(compressed).toBeLessThan(original);
    expect(saved).toBe(original - compressed);
    // Ratio is compressed/original, formatted to 2 dp, and < 1.
    expect(ratio).not.toBeNull();
    expect(Number(ratio)).toBeLessThan(1);
    expect(ratio).toBe((compressed / original).toFixed(2));
    // Cost header present (known pricing) and a positive estimate.
    expect(cost).not.toBeNull();
    expect(Number(cost)).toBeGreaterThan(0);

    // Exposed for cross-origin reads.
    const expose = res.headers.get("Access-Control-Expose-Headers") ?? "";
    for (const h of ZINTUS_HEADERS) expect(expose).toContain(h);

    // Derived-only: no header carries the prompt/log content or any secret.
    res.headers.forEach((value) => {
      expect(value).not.toContain(SECRET_PROMPT);
      expect(value).not.toContain("request handled");
    });
    await res.text();
  });

  test("emits X-Zintus compression headers on a non-streaming response; omits cost when pricing unknown", async () => {
    // Unknown (provider, model) pricing → cost header omitted, tokens kept.
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "test-model",
          traceId: "trace-z2",
          stream: (async function* () {
            yield "ok";
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          messages: [
            { role: "user", content: SECRET_PROMPT },
            { role: "assistant", content: compressibleLogBody() },
          ],
        }),
      }),
    );
    expect(Number(res.headers.get("X-Zintus-Original-Tokens"))).toBeGreaterThan(
      0,
    );
    expect(Number(res.headers.get("X-Zintus-Tokens-Saved"))).toBeGreaterThan(0);
    // Pricing unknown for (groq, test-model) → cost header omitted only.
    expect(res.headers.get("X-Zintus-Cost-Saved-Usd")).toBeNull();
    await res.json();
  });

  test("omits ALL X-Zintus compression headers when no compression happens", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Short user message: nothing compressible → compressedTokens >= original.
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    for (const h of ZINTUS_HEADERS) {
      expect(res.headers.get(h)).toBeNull();
    }
    await res.text();
  });
});

describe("Engineer advisory backlog HTTP contract", () => {
  const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "advisory-handler-owner" });
  const item = {
    advisoryId: `sha256:${"a".repeat(64)}`, severity: "HIGH", category: "security",
    description: "Optional hardening", recommendedChange: "Add a defense", file: "src/a.ts",
    lineStart: 1, lineEnd: 2, actionability: "ACTIONABLE", status: "OPEN", revision: 1,
    createdAt: "2026-07-18T10:00:00.000Z", updatedAt: "2026-07-18T10:00:00.000Z",
  };
  const makeAdvisoryHandler = (overrides: Record<string, unknown> = {}) => {
    const calls: unknown[][] = [];
    const manager = {
      readiness: () => ({ state: "READY", error: null }), principal: () => principal,
      listAdvisories: (...args: unknown[]) => { calls.push(args); return { schemaVersion: 1, materializationStatus: "COMPLETE", items: [item], nextCursor: "next" }; },
      deferAdvisory: (...args: unknown[]) => { calls.push(args); return { ...item, status: "DEFERRED", revision: 2 }; },
      dismissAdvisory: (...args: unknown[]) => { calls.push(args); return { ...item, status: "DISMISSED", revision: 2 }; },
      reopenAdvisory: (...args: unknown[]) => { calls.push(args); return { ...item, status: "OPEN", revision: 2 }; },
      ...overrides,
    } as unknown as EngineerRunManager;
    return { handler: makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns: manager }), calls };
  };
  const authorized = { Authorization: "Bearer secret", "Content-Type": "application/json" };

  test("lists a filtered owner page with no-store and requires authentication", async () => {
    const { handler, calls } = makeAdvisoryHandler();
    const unauthenticated = await handler(new Request("http://x/v1/engineer/runs/run-1/advisories"));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("Cache-Control")).toBe("no-store");
    const response = await handler(new Request("http://x/v1/engineer/runs/run-1/advisories?limit=7&cursor=abc&status=OPEN&actionability=ACTIONABLE", { headers: authorized }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ schemaVersion: 1, materializationStatus: "COMPLETE", items: [item], nextCursor: "next" });
    expect(calls).toEqual([[principal, "run-1", { limit: 7, cursor: "abc", status: "OPEN", actionability: "ACTIONABLE" }]]);
  });

  test("dispatches strict lifecycle commands without accepting client actor authority", async () => {
    const { handler, calls } = makeAdvisoryHandler();
    const command = { expectedRevision: 1, idempotencyKey: "operation-1", rationale: "Later" };
    const response = await handler(new Request("http://x/v1/engineer/runs/run-1/advisories/advisory-1/defer", {
      method: "POST", headers: authorized, body: JSON.stringify(command),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ advisory: { ...item, status: "DEFERRED", revision: 2 } });
    expect(calls).toEqual([[principal, "run-1", "advisory-1", command]]);
    const actorAttempt = await handler(new Request("http://x/v1/engineer/runs/run-1/advisories/advisory-1/dismiss", {
      method: "POST", headers: authorized, body: JSON.stringify({ ...command, actorId: "attacker" }),
    }));
    expect(actorAttempt.status).toBe(400);
    expect(await actorAttempt.json()).toMatchObject({ error: { code: "ENGINEER_ADVISORY_REQUEST_INVALID" } });
    expect(calls).toHaveLength(1);
  });

  test("returns the frozen stable error codes and refresh action", async () => {
    for (const [code, status, message, action] of [
      ["CURSOR_INVALID", 400, "Advisory cursor is invalid"],
      ["NOT_FOUND", 404, "Advisory resource not found"],
      ["CHANGED", 409, "Advisory changed; refresh advisories before deciding", "REFRESH_ADVISORIES"],
      ["TRANSITION_INVALID", 409, "Advisory transition is invalid"],
      ["IDEMPOTENCY_CONFLICT", 409, "Advisory operation conflicts with an existing idempotency key"],
      ["MATERIALIZATION_REQUIRED", 409, "Advisory materialization is required"],
      ["INTEGRITY_FAILURE", 500, "Advisory authority integrity validation failed"],
    ] as const) {
      const { handler } = makeAdvisoryHandler({
        listAdvisories: () => { throw Object.assign(new Error(`safe ${code}`), { code }); },
      });
      const response = await handler(new Request("http://x/v1/engineer/runs/run-1/advisories", { headers: authorized }));
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: {
        code: `ENGINEER_ADVISORY_${code}`, message, ...(action ? { action } : {}),
      } });
    }
    const foreignHandler = makeAdvisoryHandler({ listAdvisories: () => { throw new Error("authenticated Engineer principal does not own this run"); } }).handler;
    const unknownHandler = makeAdvisoryHandler({ listAdvisories: () => { throw Object.assign(new Error("advisory backlog missing"), { code: "NOT_FOUND" }); } }).handler;
    const foreignResponse = await foreignHandler(new Request("http://x/v1/engineer/runs/foreign/advisories", { headers: authorized }));
    const unknownResponse = await unknownHandler(new Request("http://x/v1/engineer/runs/unknown/advisories", { headers: authorized }));
    expect(foreignResponse.status).toBe(404);
    expect(unknownResponse.status).toBe(404);
    expect(await foreignResponse.json()).toEqual(await unknownResponse.json());
    const internalIntegrity = makeAdvisoryHandler({ listAdvisories: () => {
      throw Object.assign(new Error("internal authority detail"), { code: "ENGINEER_ADVISORY_INTEGRITY_FAILURE" });
    } }).handler;
    const integrityResponse = await internalIntegrity(new Request("http://x/v1/engineer/runs/run-1/advisories", { headers: authorized }));
    expect(integrityResponse.status).toBe(500);
    expect(await integrityResponse.json()).toEqual({ error: { code: "ENGINEER_ADVISORY_INTEGRITY_FAILURE", message: "Advisory authority integrity validation failed" } });
    const internalIdempotency = makeAdvisoryHandler({ deferAdvisory: () => {
      throw Object.assign(new Error("key detail"), { name: "IdempotencyConflictError" });
    } }).handler;
    const conflictResponse = await internalIdempotency(new Request("http://x/v1/engineer/runs/run-1/advisories/advisory-1/defer", {
      method: "POST", headers: authorized, body: JSON.stringify({ expectedRevision: 0, idempotencyKey: "same-key", rationale: null }),
    }));
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({ error: { code: "ENGINEER_ADVISORY_IDEMPOTENCY_CONFLICT" } });
  });

  test("sets no-store on origin rejection and OPTIONS before advisory routing", async () => {
    const originRestricted = makeHandler(
      { token: "secret", corsOrigins: "loopback" },
      fakeEngine(),
      { engineerRuns: ({ readiness: () => ({ state: "READY", error: null }), principal: () => principal } as unknown as EngineerRunManager) },
    );
    const rejected = await originRestricted(new Request("http://x/v1/engineer/runs/run-1/advisories", {
      headers: { Origin: "https://evil.example", Authorization: "Bearer secret" },
    }));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("Cache-Control")).toBe("no-store");

    const { handler } = makeAdvisoryHandler();
    const preflight = await handler(new Request("http://x/v1/engineer/runs/run-1/advisories", { method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("Engineer optional hardening HTTP contract", () => {
  const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "hardening-handler-owner" });
  const quote = {
    quoteId: `sha256:${"a".repeat(64)}`, quoteHash: `sha256:${"b".repeat(64)}`, parentRunId: "run-1",
    parentCheckpointId: `sha256:${"c".repeat(64)}`, parentCheckpointHash: `sha256:${"d".repeat(64)}`,
    parentStateVersion: 4, selectionHash: `sha256:${"e".repeat(64)}`, advisoryIds: [`sha256:${"f".repeat(64)}`],
    routingPolicyVersion: "routing-v1", pricingVersion: "pricing-v1", estimatorVersion: "estimator-v1",
    estimate: { maxCostMicrousd: 1000, maxTokens: 100, maxTimeSeconds: 30, maxPlannerCalls: 0, maxBuilderCalls: 1, maxReviewerCalls: 1, automaticRepairCalls: 0 },
    assumptions: ["ESTIMATE_IS_HARD_CAP"], createdAt: "2026-07-18T10:00:00.000Z", expiresAt: "2099-07-18T10:30:00.000Z", status: "ACTIVE",
  };
  const consent = { consentId: `sha256:${"1".repeat(64)}`, consentHash: `sha256:${"2".repeat(64)}` };
  const child = {
    schemaVersion: 1, parentRunId: "run-1", rootRunId: "run-1", childRunId: "hardening-child-1",
    lineageId: `sha256:${"3".repeat(64)}`, lineageHash: `sha256:${"4".repeat(64)}`,
    state: "REQUEST_RECEIVED", stateVersion: 0, riskTier: "HIGH", humanGateRequired: true,
    budget: { costMicrousd: 1000, tokens: 100, timeSeconds: 30 }, createdAt: "2026-07-18T10:02:00.000Z",
  };
  const lineage = {
    schemaVersion: 1, policyVersion: "engineer-hardening-lineage-v1", relation: "OPTIONAL_HARDENING",
    lineageId: child.lineageId, lineageHash: child.lineageHash, rootRunId: child.rootRunId, parentRunId: child.parentRunId, childRunId: child.childRunId,
    parentCheckpointId: `sha256:${"5".repeat(64)}`, parentCheckpointHash: `sha256:${"6".repeat(64)}`,
    parentBaseCommitSha: "a".repeat(40), seedResultCommitSha: "b".repeat(40), quoteId: `sha256:${"7".repeat(64)}`,
    quoteHash: `sha256:${"8".repeat(64)}`, consentId: consent.consentId, consentHash: consent.consentHash,
    selectionHash: `sha256:${"9".repeat(64)}`, budget: child.budget, createdAt: child.createdAt,
  };
  const creation = { child, lineage };
  const startResult = { run: { runId: child.childRunId, state: "QUEUED" }, start: { operationId: `sha256:${"0".repeat(64)}`,
    childRunId: child.childRunId, createdAt: child.createdAt }, seed: { status: "VERIFIED", seedAttestationId: `sha256:${"a".repeat(64)}`,
    seedDiffHash: `sha256:${"b".repeat(64)}` }, status: "STARTED" };
  const authorized = { Authorization: "Bearer secret", "Content-Type": "application/json" };
  const quoteBody = { runId: "run-1", advisoryIds: quote.advisoryIds, expectedParentStateVersion: 4, idempotencyKey: "quote-op" };
  const consentBody = {
    quoteId: quote.quoteId, quoteHash: quote.quoteHash,
    authorizedBudget: { costMicrousd: 1000, tokens: 100, timeSeconds: 30 },
    acknowledgements: { separateRun: true, parentCandidateUnchanged: true, noAutomaticRepair: true, noOverages: true },
    expectedParentStateVersion: 4, idempotencyKey: "consent-op",
  };
  const setup = (overrides: Record<string, unknown> = {}) => {
    const calls: unknown[][] = [];
    const manager = {
      readiness: () => ({ state: "READY", error: null }), principal: () => principal,
      createHardeningQuote: (...args: unknown[]) => { calls.push(args); return quote; },
      getHardeningQuote: (...args: unknown[]) => { calls.push(args); return quote; },
      acceptHardeningConsent: (...args: unknown[]) => { calls.push(args); return consent; },
      createOptionalHardeningChild: (...args: unknown[]) => { calls.push(args); return creation; },
      startOptionalHardeningChild: (...args: unknown[]) => { calls.push(args); return startResult; },
      ...overrides,
    } as unknown as EngineerRunManager;
    return { calls, handler: makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns: manager }) };
  };

  test("dispatches strict nested quote, consent, and child routes", async () => {
    const { handler, calls } = setup();
    const created = await handler(new Request("http://x/v1/engineer/runs/run-1/hardening/quotes", { method: "POST", headers: authorized, body: JSON.stringify(quoteBody) }));
    const read = await handler(new Request(`http://x/v1/engineer/runs/run-1/hardening/quotes/${encodeURIComponent(quote.quoteId)}`, { headers: authorized }));
    const accepted = await handler(new Request("http://x/v1/engineer/runs/run-1/hardening/consents", { method: "POST", headers: authorized, body: JSON.stringify(consentBody) }));
    const childCreated = await handler(new Request("http://x/v1/engineer/runs/run-1/hardening/children", { method: "POST", headers: authorized, body: JSON.stringify(consent) }));
    const childReplayed = await handler(new Request("http://x/v1/engineer/runs/run-1/hardening/children", { method: "POST", headers: authorized, body: JSON.stringify(consent) }));
    expect([created.status, read.status, accepted.status, childCreated.status, childReplayed.status]).toEqual([201, 200, 201, 201, 201]);
    expect([created, read, accepted, childCreated, childReplayed].every((response) => response.headers.get("Cache-Control") === "no-store")).toBe(true);
    expect(await created.json()).toEqual({ quote });
    expect(await read.json()).toEqual({ quote });
    expect(await accepted.json()).toEqual({ consent });
    expect(await childCreated.clone().text()).toBe(await childReplayed.clone().text());
    expect(await childCreated.json()).toEqual(creation);
    expect(await childReplayed.json()).toEqual(creation);
    expect(calls).toEqual([
      [principal, "run-1", quoteBody],
      [principal, "run-1", quote.quoteId],
      [principal, "run-1", consentBody],
      [principal, "run-1", consent],
      [principal, "run-1", consent],
    ]);
  });

  test("rejects client authority and unsupported fields before dispatch", async () => {
    const { handler, calls } = setup();
    for (const body of [
      { ...quoteBody, actorId: "attacker" },
      { ...quoteBody, runId: "other-run" },
      { ...consentBody, requesterUserId: "attacker" },
      { ...consentBody, acknowledgements: { ...consentBody.acknowledgements, noOverages: false } },
    ]) {
      const endpoint = "quoteId" in body ? "consents" : "quotes";
      const response = await handler(new Request(`http://x/v1/engineer/runs/run-1/hardening/${endpoint}`, { method: "POST", headers: authorized, body: JSON.stringify(body) }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "ENGINEER_HARDENING_INVALID_REQUEST", message: "Hardening request is invalid" } });
    }
    expect(calls).toHaveLength(0);
  });

  test("rejects every child field beyond the two consent hashes before dispatch", async () => {
    const { handler, calls } = setup();
    for (const body of [
      {},
      { consentId: consent.consentId },
      { ...consent, actorId: "attacker" },
      { ...consent, consentHash: "not-a-hash" },
    ]) {
      const response = await handler(new Request("http://x/v1/engineer/runs/run-1/hardening/children", {
        method: "POST", headers: authorized, body: JSON.stringify(body),
      }));
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: { code: "ENGINEER_HARDENING_INVALID_REQUEST", message: "Hardening request is invalid" } });
    }
    expect(calls).toHaveLength(0);
  });

  test("starts an exact child through the nested strict owner route and rejects changed authority shapes", async () => {
    const {handler,calls}=setup();const input={expectedChildStateVersion:0,lineageId:child.lineageId,lineageHash:child.lineageHash,idempotencyKey:"start-1"};
    const response=await handler(new Request(`http://x/v1/engineer/runs/run-1/hardening/children/${encodeURIComponent(child.childRunId)}/start`,
      {method:"POST",headers:authorized,body:JSON.stringify(input)}));expect(response.status).toBe(202);expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({start:startResult});expect(calls).toEqual([[principal,"run-1",child.childRunId,input]]);
    for(const body of [{...input,expectedChildStateVersion:1},{...input,actorId:"attacker"},{...input,lineageHash:"bad"}]){
      const invalid=await handler(new Request(`http://x/v1/engineer/runs/run-1/hardening/children/${child.childRunId}/start`,
        {method:"POST",headers:authorized,body:JSON.stringify(body)}));expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({error:{code:"ENGINEER_HARDENING_INVALID_REQUEST",message:"Hardening request is invalid"}});}
    expect(calls).toHaveLength(1);
  });

  test("returns an owner-safe stable 404 for missing child authority", async () => {
    const { handler } = setup({
      createOptionalHardeningChild: () => { throw new Error(`hardening consent not found: ${consent.consentId}`); },
    });
    const response = await handler(new Request("http://x/v1/engineer/runs/run-1/hardening/children", {
      method: "POST", headers: authorized, body: JSON.stringify(consent),
    }));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "ENGINEER_HARDENING_NOT_FOUND", message: "Hardening resource not found" },
    });
  });

  test("maps stable errors uniformly and applies no-store to global early exits", async () => {
    for (const [code, status] of [
      ["ENGINEER_HARDENING_NOT_FOUND", 404], ["ENGINEER_HARDENING_IDEMPOTENCY_CONFLICT", 409],
      ["ENGINEER_HARDENING_STATE_CONFLICT", 409], ["ENGINEER_HARDENING_SELECTION_INVALID", 409],
      ["ENGINEER_HARDENING_QUOTE_EXPIRED", 409], ["ENGINEER_HARDENING_PRICING_UNAVAILABLE", 503],
      ["ENGINEER_HARDENING_AUTHORITY_INVALID", 409], ["ENGINEER_HARDENING_INTERNAL_ERROR", 500],
    ] as const) {
      const { handler } = setup({ createOptionalHardeningChild: () => { throw Object.assign(new Error("sk-TESTFAKE0123456789 secret detail"), { code }); } });
      const response = await handler(new Request("http://x/v1/engineer/runs/run-1/hardening/children", { method: "POST", headers: authorized, body: JSON.stringify(consent) }));
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect((await response.json() as { error: { code: string; message: string } }).error).toMatchObject({ code });
    }
    const { handler } = setup();
    const unauthenticated = await handler(new Request("http://x/v1/engineer/runs/run-1/hardening/children"));
    const preflight = await handler(new Request("http://x/v1/engineer/runs/run-1/hardening/children", { method: "OPTIONS" }));
    const originRestricted = makeHandler(
      { token: "secret", corsOrigins: "loopback" }, fakeEngine(),
      { engineerRuns: ({ readiness: () => ({ state: "READY", error: null }), principal: () => principal } as unknown as EngineerRunManager) },
    );
    const rejectedOrigin = await originRestricted(new Request("http://x/v1/engineer/runs/run-1/hardening/children", {
      headers: { Origin: "https://evil.example", Authorization: "Bearer secret" },
    }));
    expect(unauthenticated.headers.get("Cache-Control")).toBe("no-store");
    expect(preflight.headers.get("Cache-Control")).toBe("no-store");
    expect(rejectedOrigin.status).toBe(403);
    expect(rejectedOrigin.headers.get("Cache-Control")).toBe("no-store");
  });

  test("maps a consent budget above the signed quote caps to a stable 409 without leaking details", async () => {
    const { handler } = setup({
      acceptHardeningConsent: () => {
        throw new TypeError("consent budget exceeds the quote hard caps: sk-TESTFAKE0123456789");
      },
    });
    const response = await handler(new Request("http://x/v1/engineer/runs/run-1/hardening/consents", {
      method: "POST", headers: authorized, body: JSON.stringify(consentBody),
    }));
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "ENGINEER_HARDENING_AUTHORITY_INVALID", message: "Hardening authority is invalid" },
    });
  });
});

describe("client-facing error redaction (secrets scrubbed from responses, not just logs)", () => {
  // Matches the router's redactor rule `sk-[a-zA-Z0-9\-_]{8,}` → `sk-****REDACTED****`.
  const FAKE_SECRET = "sk-TESTFAKE0123456789abcdefghijklmnopqrstuvwx";
  const REDACTED = "sk-****REDACTED****";

  test("non-streaming chat: a re-thrown provider error has its embedded key scrubbed from the 400 body", async () => {
    // Mirrors a provider 401 whose body echoes the offending key verbatim. The
    // engine rejection propagates to the handler's top-level catch.
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error(`upstream auth rejected (401): invalid api key ${FAKE_SECRET}`);
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // Key gone, redaction marker present, surrounding text preserved.
    expect(body.error.message).not.toContain(FAKE_SECRET);
    expect(body.error.message).toContain(REDACTED);
    expect(body.error.message).toContain("upstream auth rejected (401)");
  });

  test("streaming chat: a mid-stream provider error has its embedded key scrubbed from the SSE error event", async () => {
    // routeAndStream resolves, then the stream throws partway through — exercising
    // the streaming branch's error path that emits an SSE `error` event.
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            yield "partial answer";
            throw new Error(`stream aborted by provider: ${FAKE_SECRET}`);
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // No `stream` field → defaults to streaming SSE.
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("partial answer"); // earlier chunk survived
    expect(text).toContain('"error"'); // error event emitted
    expect(text).not.toContain(FAKE_SECRET); // raw key never reaches the client
    expect(text).toContain(REDACTED);
  });

  test("research SSE: a key in an upstream failure is scrubbed from the error event", async () => {
    // deepResearch calls routeAndStream during decompose; the throw surfaces as a
    // { type: "error", message } event relayed over SSE — which must be scrubbed.
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error(`search backend error: leaked ${FAKE_SECRET}`);
      },
    });
    const handler = makeHandler({ tavilyApiKey: "tvly-test" }, engine);
    const res = await handler(
      new Request("http://x/v1/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "what is zintus", depth: "standard" }),
      }),
    );
    const text = await res.text();
    expect(text).toContain('"error"');
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).toContain(REDACTED);
  });

  test("an ordinary error message (no secret) passes through unchanged", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error("model is overloaded, please retry");
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // redactSecrets is a no-op on a clean string — verbatim, including no marker.
    expect(body.error.message).toBe("model is overloaded, please retry");
    expect(body.error.message).not.toContain("REDACTED");
  });

  test("the structured UNSUPPORTED_VISION_ERROR is left intact (carries no secret)", async () => {
    // Auto-routing rejects an image request with no vision-capable candidate by
    // throwing "unsupported_capability"; the handler maps it to the structured
    // 422 error — which redaction must NOT touch.
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error("unsupported_capability");
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this?" },
                {
                  type: "image",
                  data: "iVBORw0KGgo=",
                  mimeType: "image/png",
                  bytes: 1024,
                  exifStripped: true,
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { type: string; message: string; required: string[] };
    };
    expect(body.error.type).toBe("unsupported_capability");
    expect(body.error.required).toContain("vision");
    expect(body.error.message).toContain("vision-capable provider");
  });
});

describe("tool / function calling", () => {
  const weatherTool = {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  };
  const toolCall = {
    type: "tool_call" as const,
    id: "call_x",
    name: "get_weather",
    arguments: { city: "Paris" },
  };

  test("(a) streaming: tool calls are emitted as OpenAI delta.tool_calls + finish_reason:'tool_calls' before [DONE]", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-tc",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "Let me check.";
          })(),
          toolCalls: [toolCall],
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: true,
          provider: "groq",
          tools: [weatherTool],
          messages: [{ role: "user", content: "weather in Paris?" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text
      .split("\n\n")
      .map((b) => b.replace(/^data: /, "").trim())
      .filter((l) => l.length > 0 && l !== "[DONE]");
    const events = dataLines.map((l) => JSON.parse(l) as Record<string, any>);

    // The tool-call chunk carries the OpenAI delta.tool_calls shape.
    const toolChunk = events.find(
      (e) => e.choices?.[0]?.delta?.tool_calls,
    );
    expect(toolChunk).toBeDefined();
    const tc = toolChunk!.choices[0].delta.tool_calls[0];
    expect(tc.index).toBe(0);
    expect(tc.id).toBe("call_x");
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("get_weather");
    expect(JSON.parse(tc.function.arguments)).toEqual({ city: "Paris" });

    // A terminating delta sets finish_reason: "tool_calls".
    const finish = events.find(
      (e) => e.choices?.[0]?.finish_reason === "tool_calls",
    );
    expect(finish).toBeDefined();
    expect(finish!.choices[0].delta).toEqual({});

    // …and the stream still terminates with [DONE] after the tool-call frames.
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("(b) explicit non-tool provider + tools → 422 UNSUPPORTED_TOOLS_ERROR (never reaches the engine)", async () => {
    let routed = false;
    const engine = fakeEngine({
      async routeAndStream() {
        routed = true;
        throw new Error("should not be called");
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          provider: "huggingface", // tools: false in MODEL_CAPABILITIES
          tools: [weatherTool],
          messages: [{ role: "user", content: "weather in Paris?" }],
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { type: string; required: string[]; message: string };
    };
    expect(body.error.type).toBe("unsupported_capability");
    expect(body.error.required).toContain("tools");
    expect(body.error.message).toContain("Tool/function calling");
    expect(routed).toBe(false);
  });

  test("(c) router throws unsupported_capability with tools (no images) → tools error, not vision error", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error("unsupported_capability");
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          // No explicit provider → the explicit-provider gate is skipped and the
          // router (auto-routing) throws unsupported_capability instead.
          tools: [weatherTool],
          messages: [{ role: "user", content: "weather in Paris?" }],
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { type: string; required: string[] };
    };
    expect(body.error.type).toBe("unsupported_capability");
    expect(body.error.required).toContain("tools");
    expect(body.error.required).not.toContain("vision");
  });

  test("(d) non-streaming returns tool_calls on the assistant message + finish_reason:'tool_calls'", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-tc",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "";
          })(),
          toolCalls: [toolCall],
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          provider: "groq",
          tools: [weatherTool],
          messages: [{ role: "user", content: "weather in Paris?" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };
    const choice = body.choices[0]!;
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.content).toBeNull();
    const calls = choice.message.tool_calls!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("call_x");
    expect(calls[0]!.type).toBe("function");
    expect(calls[0]!.function.name).toBe("get_weather");
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ city: "Paris" });
  });

  test("(e) round-trip: an OpenAI-native assistant tool_calls turn normalizes to internal tool_call blocks", async () => {
    // The gateway EMITS `{role:"assistant", content:null, tool_calls:[...]}`. A
    // stock OpenAI client echoes that turn back as the next request's history.
    // parseMessages must convert the top-level tool_calls (with a JSON-STRING
    // arguments) into internal tool_call content blocks, or the call is lost.
    let received: Array<{ role: string; content: unknown }> | undefined;
    const engine = fakeEngine({
      async routeAndStream(request) {
        received = request.messages;
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-rt",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "Paris is sunny.";
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          provider: "groq",
          tools: [weatherTool],
          messages: [
            { role: "user", content: "weather in Paris?" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_x",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_x", content: '{"tempC":21}' },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(received).toBeDefined();
    const assistantTurn = received!.find((m) => m.role === "assistant")!;
    expect(Array.isArray(assistantTurn.content)).toBe(true);
    const blocks = assistantTurn.content as Array<Record<string, unknown>>;
    const tcBlock = blocks.find((b) => b.type === "tool_call")!;
    expect(tcBlock.id).toBe("call_x");
    expect(tcBlock.name).toBe("get_weather");
    expect(tcBlock.arguments).toEqual({ city: "Paris" });
  });

  test("(f) malformed tool_call arguments JSON normalizes to an empty object, not a 400", async () => {
    let received: Array<{ role: string; content: unknown }> | undefined;
    const engine = fakeEngine({
      async routeAndStream(request) {
        received = request.messages;
        return {
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
          traceId: "trace-rt2",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "ok";
          })(),
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          provider: "groq",
          tools: [weatherTool],
          messages: [
            { role: "user", content: "weather?" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_y",
                  type: "function",
                  function: { name: "get_weather", arguments: "{not json" },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_y", content: "{}" },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const assistantTurn = received!.find((m) => m.role === "assistant")!;
    const blocks = assistantTurn.content as Array<Record<string, unknown>>;
    const tcBlock = blocks.find((b) => b.type === "tool_call")!;
    expect(tcBlock.arguments).toEqual({});
  });
});

describe("structured / JSON output", () => {
  const personSchema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "number" } },
    required: ["name", "age"],
  };

  test("(a) non-streaming structured request surfaces parsed + structured_output", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "gemini",
          model: "gemini-2.5-flash",
          traceId: "trace-so",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield '{"name":"Ada","age":36}';
          })(),
          structuredOutput: {
            requested: "json_schema" as const,
            servedLevel: "json_schema" as const,
            guaranteed: true,
            valid: true,
            repairAttempts: 0,
          },
          parsed: { name: "Ada", age: 36 },
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          messages: [{ role: "user", content: "describe Ada" }],
          response_format: { type: "json_schema", schema: personSchema },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      parsed: unknown;
      structured_output: {
        requested: string;
        served_level: string;
        guaranteed: boolean;
        valid: boolean;
        repair_attempts: number;
      };
    };
    // Raw assistant text is preserved on the message.
    expect(body.choices[0]?.message.content).toBe('{"name":"Ada","age":36}');
    // Top-level parsed value + snake_cased metadata.
    expect(body.parsed).toEqual({ name: "Ada", age: 36 });
    expect(body.structured_output.requested).toBe("json_schema");
    expect(body.structured_output.served_level).toBe("json_schema");
    expect(body.structured_output.guaranteed).toBe(true);
    expect(body.structured_output.valid).toBe(true);
    expect(body.structured_output.repair_attempts).toBe(0);
  });

  test("(b) strict json_schema with an invalid result → 422 structured_output_invalid", async () => {
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "openrouter",
          model: "best-effort",
          traceId: "trace-bad",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "sorry, here is some prose not JSON";
          })(),
          structuredOutput: {
            requested: "json_schema" as const,
            servedLevel: "json_object" as const,
            guaranteed: false,
            valid: false,
            repairAttempts: 2,
            issues: [{ path: "/name", message: "expected string" }],
          },
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // No explicit provider, so the capability gate is skipped and the engine
          // result (valid:false) drives the 422 instead.
          stream: false,
          messages: [{ role: "user", content: "describe Ada" }],
          response_format: { type: "json_schema", strict: true, schema: personSchema },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: {
        type: string;
        message: string;
        structured_output: { valid: boolean; repair_attempts: number };
      };
    };
    expect(body.error.type).toBe("structured_output_invalid");
    expect(body.error.structured_output.valid).toBe(false);
    expect(body.error.structured_output.repair_attempts).toBe(2);
  });

  test("(c) explicit non-json_schema provider + strict → 422 unsupported_capability required ['json_schema']", async () => {
    // groq's strongest structured level is json_object, not json_schema, so a
    // strict schema-constrained request against it must hard-error at the gate
    // (the engine is never reached).
    const engine = fakeEngine({
      async routeAndStream() {
        throw new Error("routeAndStream should not be called");
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          provider: "groq",
          messages: [{ role: "user", content: "describe Ada" }],
          response_format: { type: "json_schema", strict: true, schema: personSchema },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { type: string; required: string[]; message: string };
    };
    expect(body.error.type).toBe("unsupported_capability");
    expect(body.error.required).toContain("json_schema");
    expect(body.error.message).toContain("Gemini");
  });

  test("(d) streaming (default) strict json_schema with an invalid result → 422, NOT a 200 stream", async () => {
    // The DEFAULT path is streaming (stream omitted). The engine buffers +
    // validates the structured document before routeAndStream resolves, so a
    // strict request whose output did not validate must hard-fail 422 BEFORE the
    // SSE stream opens — never a 200 text/event-stream carrying a valid:false
    // frame + non-conformant prose.
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "openrouter",
          model: "best-effort",
          traceId: "trace-bad-stream",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "sorry, here is some prose not JSON";
          })(),
          structuredOutput: {
            requested: "json_schema" as const,
            servedLevel: "json_object" as const,
            guaranteed: false,
            valid: false,
            repairAttempts: 2,
            issues: [{ path: "/name", message: "expected string" }],
          },
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // stream omitted → defaults to streaming.
          messages: [{ role: "user", content: "describe Ada" }],
          response_format: { type: "json_schema", strict: true, schema: personSchema },
        }),
      }),
    );
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type") ?? "").not.toContain(
      "text/event-stream",
    );
    const body = (await res.json()) as {
      error: {
        type: string;
        structured_output: { valid: boolean; repair_attempts: number };
      };
    };
    expect(body.error.type).toBe("structured_output_invalid");
    expect(body.error.structured_output.valid).toBe(false);
    expect(body.error.structured_output.repair_attempts).toBe(2);
  });

  test("(e) streaming strict json_schema with a VALID result still streams 200", async () => {
    // Guard the negative: a strict streaming request that DID validate must keep
    // its 200 SSE behavior (the pre-stream gate is valid:false-only).
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "gemini",
          model: "best",
          traceId: "trace-good-stream",
          threadId: "thread-1",
          compileTraceId: undefined,
          stream: (async function* () {
            yield '{"name":"Ada","age":36}';
          })(),
          structuredOutput: {
            requested: "json_schema" as const,
            servedLevel: "json_schema" as const,
            guaranteed: true,
            valid: true,
            repairAttempts: 0,
            issues: [],
            parsed: { name: "Ada", age: 36 },
          },
        };
      },
    });
    const handler = makeHandler({}, engine);
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "describe Ada" }],
          response_format: { type: "json_schema", strict: true, schema: personSchema },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
  });
});

describe("/v1/models — honest measured provider stats", () => {
  type ModelEntry = {
    id: string;
    owned_by: string;
    stats: {
      latency_p95_ms: number | null;
      throughput_tps: number | null;
      uptime: number | null;
      samples: number;
    };
  };

  test("stats fields exist and are NULL when no accessor is wired", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request("http://x/v1/models", { method: "GET" }),
    );
    const body = (await res.json()) as { data: ModelEntry[] };
    expect(body.data.length).toBeGreaterThan(0);
    for (const m of body.data) {
      expect(m.stats).toBeDefined();
      expect(m.stats.latency_p95_ms).toBeNull();
      expect(m.stats.throughput_tps).toBeNull();
      expect(m.stats.uptime).toBeNull();
      expect(m.stats.samples).toBe(0);
    }
  });

  test("stats reflect the injected accessor; null-when-insufficient is preserved", async () => {
    const handler = makeHandler({}, fakeEngine(), {
      // groq has plenty of samples → measured numbers; everyone else has too few
      // → metrics stay null while `samples` is carried honestly.
      getProviderStats: (provider) =>
        provider === "groq"
          ? {
              latencyP95Ms: 123,
              throughputTps: 45.5,
              successRate: 0.99,
              samples: 50,
            }
          : {
              latencyP95Ms: null,
              throughputTps: null,
              successRate: null,
              samples: 1,
            },
    });
    const res = await handler(
      new Request("http://x/v1/models", { method: "GET" }),
    );
    const body = (await res.json()) as { data: ModelEntry[] };

    const measured = body.data.filter((m) => m.stats.samples === 50);
    const insufficient = body.data.filter((m) => m.stats.samples === 1);
    expect(measured.length).toBeGreaterThan(0);
    expect(insufficient.length).toBeGreaterThan(0);
    for (const m of measured) {
      expect(m.stats.latency_p95_ms).toBe(123);
      expect(m.stats.throughput_tps).toBe(45.5);
      expect(m.stats.uptime).toBe(0.99);
    }
    // Honesty: too few samples → metrics null (NOT 0), but the raw count rides along.
    for (const m of insufficient) {
      expect(m.stats.latency_p95_ms).toBeNull();
      expect(m.stats.throughput_tps).toBeNull();
      expect(m.stats.uptime).toBeNull();
      expect(m.stats.samples).toBe(1);
    }
  });
});

describe("chat provider routing (OpenRouter-style body → strategy/weights/forced)", () => {
  type Captured = {
    provider?: string;
    strategy?: string;
    providerWeights?: Record<string, number>;
  };

  function capturingHandler() {
    let captured: Captured | undefined;
    const engine = fakeEngine({
      async routeAndStream(request) {
        captured = {
          provider: request.provider,
          strategy: request.strategy,
          providerWeights: request.providerWeights,
        };
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          threadId: "th",
          compileTraceId: undefined,
          stream: (async function* () {
            yield "ok";
          })(),
        };
      },
    });
    return { handler: makeHandler({}, engine), get: () => captured };
  }

  async function post(handler: ReturnType<typeof makeHandler>, body: unknown) {
    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    await res.text(); // drain the SSE stream
    return res;
  }

  const messages = [{ role: "user", content: "hi" }];

  test('sort:"latency" selects the fastest-latency strategy (no forced provider)', async () => {
    const { handler, get } = capturingHandler();
    await post(handler, { messages, provider: { sort: "latency" } });
    expect(get()?.strategy).toBe("fastest");
    expect(get()?.provider).toBeUndefined();
  });

  test('sort:"throughput" also maps to fastest (Zintus speed signal is p95)', async () => {
    const { handler, get } = capturingHandler();
    await post(handler, { messages, provider: { sort: "throughput" } });
    expect(get()?.strategy).toBe("fastest");
  });

  test('sort:"price" maps to the economy strategy', async () => {
    const { handler, get } = capturingHandler();
    await post(handler, { messages, provider: { sort: "price" } });
    expect(get()?.strategy).toBe("economy");
  });

  test("allow_fallbacks:false pins to order[0] → single provider, no failover", async () => {
    const { handler, get } = capturingHandler();
    await post(handler, {
      messages,
      provider: { order: ["groq", "gemini"], allow_fallbacks: false },
    });
    // Forced to the single top-preference provider → the router yields exactly
    // one candidate and never fails over to gemini.
    expect(get()?.provider).toBe("groq");
    expect(get()?.providerWeights).toBeUndefined();
  });

  test("order (no sort) maps to descending per-request weights, no forced provider", async () => {
    const { handler, get } = capturingHandler();
    await post(handler, { messages, provider: { order: ["gemini", "groq"] } });
    expect(get()?.provider).toBeUndefined();
    expect(get()?.providerWeights).toEqual({ gemini: 2, groq: 1 });
  });

  test("legacy forced-provider STRING still forces that provider", async () => {
    const { handler, get } = capturingHandler();
    await post(handler, { messages, provider: "groq" });
    expect(get()?.provider).toBe("groq");
  });
});

describe("P7 Developer Resolution Desk HTTP routes", () => {
  const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "resolution-handler-owner" });
  const authorized = { Authorization: "Bearer secret", "Content-Type": "application/json" } as Record<string, string>;

  const makeResolutionHandler = (results: Record<string, unknown> = {}) => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    // Every method records its call FIRST, then returns the configured result
    // (a function is invoked with the args, so error cases still record).
    const method = (name: string, fallback: unknown) => (...args: unknown[]) => {
      calls.push({ method: name, args });
      const configured = results[name];
      if (typeof configured === "function") return (configured as (...a: unknown[]) => unknown)(...args);
      return configured !== undefined ? configured : fallback;
    };
    const desk = {
      createCase: method("createCase", { caseId: "case-1" }),
      listCases: method("listCases", []),
      getCase: method("getCase", { case: {}, events: [] }),
      issueDirective: method("issueDirective", {}),
      applyDirective: method("applyDirective", {}),
    } as unknown as GatewayHandlerDeps["resolutionDesk"];
    const engineerRuns = { principal: () => principal } as unknown as GatewayHandlerDeps["engineerRuns"];
    return { handler: makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns, resolutionDesk: desk }), calls };
  };

  test("creates a case owner-scoped and returns 201 { case }", async () => {
    const { handler, calls } = makeResolutionHandler({ createCase: (_p: unknown, runId: string) => ({ caseId: "case-1", runId, state: "OPEN" }) });
    const response = await handler(new Request("http://x/v1/engineer/runs/run-1/resolution-cases", { method: "POST", headers: authorized }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ case: { caseId: "case-1", runId: "run-1", state: "OPEN" } });
    expect(calls[0]).toEqual({ method: "createCase", args: [principal, "run-1"] });
  });

  test("lists cases for a run (newest first) as 200 { cases }", async () => {
    const { handler, calls } = makeResolutionHandler({ listCases: () => [{ caseId: "case-1" }] });
    const response = await handler(new Request("http://x/v1/engineer/runs/run-1/resolution-cases", { headers: authorized }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cases: [{ caseId: "case-1" }] });
    expect(calls[0]!.args).toEqual([principal, "run-1"]);
  });

  test("gets a single case + events", async () => {
    const { handler, calls } = makeResolutionHandler({ getCase: () => ({ case: { caseId: "case-1" }, events: [] }) });
    const response = await handler(new Request("http://x/v1/engineer/resolution-cases/case-1", { headers: authorized }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ case: { caseId: "case-1" }, events: [] });
    expect(calls[0]!.args).toEqual([principal, "case-1"]);
  });

  test("issues a directive, forwarding the Idempotency-Key and body", async () => {
    const { handler, calls } = makeResolutionHandler({ issueDirective: () => ({ directive: { directiveId: "d-1" }, case: { state: "DIRECTIVE_ISSUED" } }) });
    const body = { type: "CREATE_REVERIFY_RUN", caseVersion: 0, sourceRunVersion: 4 };
    const response = await handler(new Request("http://x/v1/engineer/resolution-cases/case-1/directives", {
      method: "POST", headers: { ...authorized, "Idempotency-Key": "idem-abc" }, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(201);
    expect(calls[0]).toEqual({ method: "issueDirective", args: [principal, "case-1", body, "idem-abc"] });
  });

  test("applies a directive and returns { replacementRunId, state }", async () => {
    const { handler, calls } = makeResolutionHandler({ applyDirective: () => ({ replacementRunId: "resolution-x", state: "READY" }) });
    const response = await handler(new Request("http://x/v1/engineer/resolution-directives/d-1/apply", {
      method: "POST", headers: { ...authorized, "Idempotency-Key": "apply-1" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ replacementRunId: "resolution-x", state: "READY" });
    expect(calls[0]).toEqual({ method: "applyDirective", args: [principal, "d-1", "apply-1"] });
  });

  test("maps a ResolutionDeskError to its exact status + code + detail", async () => {
    const { handler } = makeResolutionHandler({
      issueDirective: () => { throw Object.assign(new Error("case version compare-and-swap failed"), { name: "ResolutionDeskError", code: "CASE_VERSION_CONFLICT", status: 409, detail: { expected: 0, actual: 1 } }); },
    });
    const response = await handler(new Request("http://x/v1/engineer/resolution-cases/case-1/directives", {
      method: "POST", headers: { ...authorized, "Idempotency-Key": "k" }, body: "{}",
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "CASE_VERSION_CONFLICT", message: "case version compare-and-swap failed", detail: { expected: 0, actual: 1 } } });
  });

  test("maps a ZodError from the service seam to a typed 400 with issues", async () => {
    // A ZodError-like the service seam's `.parse` throws (formatIssues reads only issues[].path/message).
    const zodError = Object.assign(new Error("Invalid input"), { name: "ZodError", issues: [{ path: ["type"], message: "Required" }] });
    const { handler } = makeResolutionHandler({ issueDirective: () => { throw zodError; } });
    const response = await handler(new Request("http://x/v1/engineer/resolution-cases/case-1/directives", {
      method: "POST", headers: { ...authorized, "Idempotency-Key": "k" }, body: "{}",
    }));
    expect(response.status).toBe(400);
    const payload = await response.json() as { error: { message: string; issues: unknown[] } };
    expect(payload.error.message).toBe("Invalid request body");
    expect(Array.isArray(payload.error.issues)).toBe(true);
  });

  test("returns 503 when the resolution desk is not configured", async () => {
    const handler = makeHandler({ token: "secret" }, fakeEngine(), {});
    const response = await handler(new Request("http://x/v1/engineer/runs/run-1/resolution-cases", { method: "POST", headers: authorized }));
    expect(response.status).toBe(503);
  });

  test("unknown resolution sub-path is 404", async () => {
    const { handler } = makeResolutionHandler();
    const response = await handler(new Request("http://x/v1/engineer/resolution-cases/case-1/bogus", { method: "POST", headers: { ...authorized, "Idempotency-Key": "k" } }));
    expect(response.status).toBe(404);
  });
});

describe("P7 Resolution Desk — REAL create -> issue -> apply end-to-end (no 503)", () => {
  const authorized = { Authorization: "Bearer secret", "Content-Type": "application/json" } as Record<string, string>;

  function realHandler() {
    const root = mkdtempSync(join(tmpdir(), "zintus-resolution-e2e-"));
    const dbPath = join(root, "engineer.db");
    const supervisor = new EngineerSupervisor({ dbPath });
    const db = supervisor.resolutionDeskConnection();
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "resolution-e2e-owner" });
    const now = "2026-07-19T00:00:00.000Z";
    // Durable terminal source run with a correctable required-test failure.
    db.query("INSERT INTO users(id,email,created_at,updated_at) VALUES (?,NULL,?,?)").run(principal.ownerId, now, now);
    db.query("INSERT INTO repository_connections(id,user_id,provider,owner,name,created_at,updated_at) VALUES ('repo-1',?,'local','local','repo',?,?)").run(principal.ownerId, now, now);
    db.query(`INSERT INTO engineer_runs(id,user_id,repository_id,base_branch,base_commit_sha,request_original,request_normalized,state,state_version,manifest_hash,risk_tier,human_gate_required,created_at,updated_at)
      VALUES ('src-run',?,'repo-1','main',?,'build the thing','build the thing','VERIFICATION_INCOMPLETE',4,?,'MEDIUM',1,?,?)`)
      .run(principal.ownerId, "a".repeat(40), `sha256:${"1".repeat(64)}`, now, now);
    db.query(`INSERT INTO run_budgets(run_id,cost_limit_usd,token_limit,time_limit_seconds,lifetime_cost_limit_usd,lifetime_token_limit,lifetime_time_limit_seconds,status,created_at,updated_at)
      VALUES ('src-run',5,50000,3600,20,1000000,86400,'ACTIVE',?,?)`).run(now, now);
    db.query("INSERT INTO task_manifest_versions(id,run_id,version,manifest_hash,manifest_json,created_at) VALUES ('tmv-src','src-run',1,?,'{}',?)")
      .run(`sha256:${"1".repeat(64)}`, now);
    db.query(`INSERT INTO failure_records(id,run_id,failure_class,reason_code,fingerprint,evidence_ids_json,retryable,created_at)
      VALUES ('fail-1','src-run','TEST_FAILURE','REQUIRED_TEST_FAILED',?, '[]',0,?)`).run(`sha256:${"2".repeat(64)}`, now);

    const pricingDigest = serverPricingPolicyDigest();
    const desk = new ResolutionDesk(db, "e2e-signing-secret", "sha256:" + "3".repeat(64), () => new Date(), new ResolutionReplacementRunFactory());
    const resolutionDesk = {
      createCase: (_p: unknown, runId: string) => desk.createCase(deriveCaseCreationInput(db, runId, { pricingPolicyDigest: pricingDigest })),
      listCases: (_p: unknown, runId: string) => desk.listCases(runId),
      getCase: (_p: unknown, caseId: string) => ({ case: desk.getCase(caseId), events: [] }),
      issueDirective: (_p: unknown, caseId: string, body: unknown, key: string) => desk.issueDirective(caseId, body, key),
      applyDirective: (_p: unknown, directiveId: string, key: string) => desk.applyDirective(directiveId, key),
    } as unknown as GatewayHandlerDeps["resolutionDesk"];
    const engineerRuns = { principal: () => principal } as unknown as GatewayHandlerDeps["engineerRuns"];
    const handler = makeHandler({ token: "secret" }, fakeEngine(), { engineerRuns, resolutionDesk });
    return { handler, db, root, supervisor, pricingDigest };
  }

  test("create (201) -> issue corrected (201) -> apply (200) creates a real replacement run, no 503", async () => {
    const { handler, db, root, supervisor, pricingDigest } = realHandler();
    try {
      // 1. Create the case from the durable terminal run.
      const createRes = await handler(new Request("http://x/v1/engineer/runs/src-run/resolution-cases", { method: "POST", headers: authorized }));
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as { case: { caseId: string; caseVersion: number; correctionEligible: boolean; pricingPolicyDigest: string } };
      expect(created.case.correctionEligible).toBe(true);
      expect(created.case.pricingPolicyDigest).toBe(pricingDigest);
      const caseId = created.case.caseId;

      // 2. Issue a CREATE_CORRECTED_RUN directive with a fresh budget (Idempotency-Key required).
      const directiveBody = { type: "CREATE_CORRECTED_RUN", caseVersion: 0, sourceRunVersion: 4, budget: { maxCostUsd: 1, maxTokens: 5000, maxActiveSeconds: 1200, pricingPolicyDigest: pricingDigest } };
      const issueRes = await handler(new Request(`http://x/v1/engineer/resolution-cases/${caseId}/directives`, {
        method: "POST", headers: { ...authorized, "Idempotency-Key": "issue-1" }, body: JSON.stringify(directiveBody),
      }));
      expect(issueRes.status).toBe(201);
      const issued = await issueRes.json() as { directive: { directiveId: string } };
      const directiveId = issued.directive.directiveId;

      // 3. Apply the directive — the real factory creates the replacement run.
      const applyRes = await handler(new Request(`http://x/v1/engineer/resolution-directives/${directiveId}/apply`, {
        method: "POST", headers: { ...authorized, "Idempotency-Key": "apply-1" },
      }));
      expect(applyRes.status).toBe(200);
      const applied = await applyRes.json() as { replacementRunId: string; state: string };
      expect(applied.state).toBe("READY");

      // A REAL engineer_runs row now exists at the start state with ZERO inherited evidence.
      const replacement = db.query("SELECT id,state,state_version FROM engineer_runs WHERE id=?").get(applied.replacementRunId) as { id: string; state: string; state_version: number } | null;
      expect(replacement).not.toBeNull();
      expect(replacement!.state).toBe("REQUEST_RECEIVED");
      const inheritedFailures = db.query("SELECT COUNT(*) AS n FROM failure_records WHERE run_id=?").get(applied.replacementRunId) as { n: number };
      expect(Number(inheritedFailures.n)).toBe(0);

      // Idempotent apply replay returns the same replacement, still 200.
      const applyReplay = await handler(new Request(`http://x/v1/engineer/resolution-directives/${directiveId}/apply`, {
        method: "POST", headers: { ...authorized, "Idempotency-Key": "apply-1" },
      }));
      expect(applyReplay.status).toBe(200);
      expect((await applyReplay.json() as { replacementRunId: string }).replacementRunId).toBe(applied.replacementRunId);
    } finally {
      supervisor.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("apply without an Idempotency-Key is a typed 400 (not a 503)", async () => {
    const { handler, root, supervisor } = realHandler();
    try {
      const createRes = await handler(new Request("http://x/v1/engineer/runs/src-run/resolution-cases", { method: "POST", headers: authorized }));
      const caseId = (await createRes.json() as { case: { caseId: string } }).case.caseId;
      const issueRes = await handler(new Request(`http://x/v1/engineer/resolution-cases/${caseId}/directives`, {
        method: "POST", headers: { ...authorized, "Idempotency-Key": "issue-1" },
        body: JSON.stringify({ type: "CREATE_CORRECTED_RUN", caseVersion: 0, sourceRunVersion: 4, budget: { maxCostUsd: 1, maxTokens: 5000, maxActiveSeconds: 1200, pricingPolicyDigest: serverPricingPolicyDigest() } }),
      }));
      const directiveId = (await issueRes.json() as { directive: { directiveId: string } }).directive.directiveId;
      const applyRes = await handler(new Request(`http://x/v1/engineer/resolution-directives/${directiveId}/apply`, { method: "POST", headers: authorized }));
      expect(applyRes.status).toBe(400);
    } finally {
      supervisor.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
