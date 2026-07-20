import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetPausedError, EngineerPlanningCancelledError, EngineerPlanningTimeoutError, EngineerSupervisor, LocalArtifactStore,
  EngineerWorkerLeaseManager,
  HardeningGenericOperationForbiddenError,
  VerifiedCandidateIntegrityError, createVerifiedCandidateCheckpoint, createVerifiedHardeningCandidateCheckpoint, sha256,
  type CheckpointAttestor, type EngineerRun, type WorkerLeaseGrant,
} from "@zintus/engineer";
import { EngineerRunManager } from "./engineer.js";
import { deriveEngineerPrincipal, loadOrCreateEngineerPrincipal } from "./engineer-identity.js";
import { createLocalEngineerCapabilityProbe, EngineerCapabilityPreflight, type EngineerCapabilityProbe } from "./engineer-preflight.js";

const repository = {
  repositoryId: "repo-1", provider: "local" as const, owner: "local", name: "fixture",
  baseBranch: "main", baseCommitSha: "1".repeat(40),
};
const canonicalRepository = { ...repository, originUrl: "file:///fixture" };
const checkpointAttestor: CheckpointAttestor = {
  algorithm: "test", keyId: "gateway-checkpoint-test",
  sign: (payload) => `test:${sha256(payload)}`,
  verify: (payload, signature) => signature === `test:${sha256(payload)}`,
};

async function safeCheckpoint(runId: string, userId: string) {
  return createVerifiedCandidateCheckpoint({
    schemaVersion: 1, policyVersion: "verified-candidate-checkpoint-v1", parentCheckpointId: null,
    runId, requesterUserId: userId, repositoryId: repository.repositoryId,
    requiredLaneContractHash: sha256("contract"), manifestHash: sha256("manifest"),
    baseCommitSha: "a".repeat(40), resultCommitSha: "b".repeat(40), diffHash: sha256("diff"),
    reviewerSessionId: "reviewer-safe", classificationHash: sha256("classification"), classificationResult: "READY",
    evidenceBundleId: "bundle-safe", evidenceBundleHash: sha256("bundle"),
    claimSummary: { claimIds: ["claim-safe"], claimSetHash: sha256("claims") },
    verificationSummary: {
      verificationPass: 1, testExecutionIds: ["test-a", "test-b"], testExecutionSetHash: sha256("tests"),
      provenanceEventIds: ["event-a"], provenanceHash: sha256("provenance"), allRequiredChecksPassed: true,
    },
    securitySummary: { findingIds: [], findingSetHash: sha256("findings"), openBlockingCriticalCount: 0 },
    scopeSummary: { artifactId: "scope-safe", artifactHash: sha256("scope"), policyVersion: "final-change-scope-v1" },
    environmentDigest: sha256("environment"),
    builderDispatchSummary: {
      claims: [{
        inputHash: sha256("builder-input"), agentExecutionId: "agent-safe", modelTier: "GPT-5.6_TERRA",
        workerOwnerId: "worker-safe", workerFencingToken: 1, status: "SUCCEEDED", outputArtifactId: "output-safe",
        startedAt: "2026-07-17T10:00:00.000Z", completedAt: "2026-07-17T10:01:00.000Z",
        outputArtifactAuthority: {
          artifactId: "output-safe", sha256: sha256("output"), sizeBytes: 1, createdAt: "2026-07-17T10:01:00.000Z",
          type: "BUILDER_RESULT", producerType: "SYSTEM", producerId: "builder-safe", trusted: false,
          regularFile: true, symbolicLink: false,
        },
      }],
      claimSetHash: sha256([{
        inputHash: sha256("builder-input"), agentExecutionId: "agent-safe", modelTier: "GPT-5.6_TERRA",
        workerOwnerId: "worker-safe", workerFencingToken: 1, status: "SUCCEEDED", outputArtifactId: "output-safe",
        startedAt: "2026-07-17T10:00:00.000Z", completedAt: "2026-07-17T10:01:00.000Z",
        outputArtifactAuthority: {
          artifactId: "output-safe", sha256: sha256("output"), sizeBytes: 1, createdAt: "2026-07-17T10:01:00.000Z",
          type: "BUILDER_RESULT", producerType: "SYSTEM", producerId: "builder-safe", trusted: false,
          regularFile: true, symbolicLink: false,
        },
      }]),
    },
    prePromotionEventChainSummary: {
      eventCount: 1, headEventId: "event-a", headSequence: 1, headStateVersion: 1, chainHash: sha256("chain"),
    },
    createdAt: "2026-07-17T12:00:00.000Z",
  }, checkpointAttestor);
}

function probe(overrides: Partial<EngineerCapabilityProbe> = {}): EngineerCapabilityProbe {
  return {
    model: async () => ({ available: true, responsesApi: true, strictStructuredOutputs: true }),
    docker: async () => ({ available: true }),
    image: async () => ({ exactDigest: true }),
    repository: async () => ({ readable: true, exactBaseCommit: true }),
    publication: async () => ({ available: true, pullRequestsWritable: true }),
    ...overrides,
  };
}

function preflight(customProbe = probe(), publicationEnabled = false): EngineerCapabilityPreflight {
  return new EngineerCapabilityPreflight({
    models: ["gpt-sol", "gpt-terra", "gpt-luna"], publicationEnabled,
    repository: canonicalRepository, probe: customProbe,
  });
}

describe("Engineer trusted identity and admission", () => {
  // R8-3 FINDING 2: the orphaned `createCorrectedRun` bypass and its
  // `correctedRunRepository` helper are removed — the Resolution Desk's signed
  // CREATE_CORRECTED_RUN directive is the sole corrected-run authority.

  test("legacy human-review approval cannot bypass verified-candidate promotion", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const now = "2026-07-16T12:00:00.000Z";
    let run: EngineerRun = {
      runId: "stale-human-review", userId: principal.ownerId, repository,
      requestOriginal: "Review verified work", requestNormalized: "Review verified work",
      state: "HUMAN_REVIEW_REQUIRED", stateVersion: 7, manifestHash: `sha256:${"a".repeat(64)}`,
      riskTier: "MEDIUM", humanGateRequired: true, createdAt: now, updatedAt: now, terminalAt: null,
    };
    let admissionChecks = 0;
    const supervisor = {
      getRun: () => run,
      listEvidenceBundles: () => [{ evidenceBundleId: "bundle-1" }],
      getPublicationEvidence: () => ({ evidenceBundleId: "bundle-1", reviewerDecision: "HUMAN_REVIEW_REQUIRED" }),
      transition: (input: { nextState: "REVIEW_APPROVED" }) => {
        run = { ...run, state: input.nextState, stateVersion: run.stateVersion + 1 };
        return { run };
      },
    } as never;
    const manager = new EngineerRunManager({
      supervisor,
      principal,
      preflight: {
        assertRunAdmission: async () => { admissionChecks += 1; throw new Error("stale canonical admission"); },
      } as never,
    });

    await expect(manager.resolveHumanReview(principal, run.runId, "approve" as never, "Verified evidence reviewed."))
      .rejects.toMatchObject({ code: "ENGINEER_VERIFIED_CANDIDATE_REQUIRED", action: "RETRY_OR_REJECT" });
    expect(run).toMatchObject({ state: "HUMAN_REVIEW_REQUIRED", stateVersion: 7 });
    expect(admissionChecks).toBe(0);
  });

  test("blocks human approval when the latest Reviewer has no fresh evidence-bound decision", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const now = "2026-07-17T12:00:00.000Z";
    const run: EngineerRun = {
      runId: "failed-reviewer", userId: principal.ownerId, repository,
      requestOriginal: "Review verified work", requestNormalized: "Review verified work",
      state: "HUMAN_REVIEW_REQUIRED", stateVersion: 9, manifestHash: `sha256:${"a".repeat(64)}`,
      riskTier: "MEDIUM", humanGateRequired: true, createdAt: now, updatedAt: now, terminalAt: null,
    };
    let transitions = 0;
    const manager = new EngineerRunManager({
      supervisor: {
        getRun: () => run,
        listFailures: () => [],
        listEvidenceBundles: () => [{ evidenceBundleId: "stale-bundle" }],
        getPublicationEvidence: () => { throw new Error("publication blocked: latest Reviewer attempt failed"); },
        transition: () => { transitions += 1; throw new Error("must not transition"); },
      } as never,
      principal,
      preflight: preflight(),
    });

    await expect(manager.resolveHumanReview(principal, run.runId, "approve" as never, "Approve the candidate."))
      .rejects.toMatchObject({ code: "ENGINEER_VERIFIED_CANDIDATE_REQUIRED" });
    expect(transitions).toBe(0);
  });

  test("retries a failed Reviewer from the retained verification checkpoint", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const now = "2026-07-17T12:00:00.000Z";
    let run: EngineerRun = {
      runId: "retry-failed-reviewer", userId: principal.ownerId, repository,
      requestOriginal: "Review verified work", requestNormalized: "Review verified work",
      state: "HUMAN_REVIEW_REQUIRED", stateVersion: 9, manifestHash: `sha256:${"a".repeat(64)}`,
      riskTier: "MEDIUM", humanGateRequired: true, createdAt: now, updatedAt: now, terminalAt: null,
    };
    let resumed = 0;
    let cleared: string | null | undefined;
    const manager = new EngineerRunManager({
      supervisor: {
        getRun: () => run,
        listEvidenceBundles: () => [{ evidenceBundleId: "stale-bundle" }],
        latestEventSequence: () => 12,
        listEvents: () => [{ previousState: "REVIEWING", reasonCode: "PHASE3_UNEXPECTED_FAILURE" }],
        listFailures: () => [{
          failureId: "reviewer-failure", failureClass: "WORKFLOW_FAILURE",
          reasonCode: "PHASE3_UNEXPECTED_FAILURE", evidenceIds: [],
        }],
        setLastError: (_runId: string, value: string | null) => { cleared = value; },
        transition: (input: { nextState: EngineerRun["state"]; facts?: { reviewerRetryAuthorized?: boolean }; evidenceIds?: string[] }) => {
          expect(input.facts?.reviewerRetryAuthorized).toBe(true);
          expect(input.evidenceIds).toEqual(["reviewer-failure"]);
          run = { ...run, state: input.nextState, stateVersion: run.stateVersion + 1 };
          return { run };
        },
      } as never,
      verification: { resumeRecovered: () => { resumed += 1; } } as never,
      principal,
      preflight: preflight(),
    });

    await expect(manager.resolveHumanReview(principal, run.runId, "retry", "Retry only the failed review."))
      .resolves.toEqual({ run: expect.objectContaining({ state: "VERIFICATION_RECOVERY" }), publication: null });
    expect(cleared).toBeNull();
    expect(resumed).toBe(1);
  });

  test("resolves flake quarantine without requiring a not-yet-created evidence bundle", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const now = "2026-07-16T12:00:00.000Z";
    let run: EngineerRun = {
      runId: "flake-human-review", userId: principal.ownerId, repository,
      requestOriginal: "Verify a flaky candidate", requestNormalized: "Verify a flaky candidate",
      state: "HUMAN_REVIEW_REQUIRED", stateVersion: 7, manifestHash: `sha256:${"a".repeat(64)}`,
      riskTier: "MEDIUM", humanGateRequired: true, createdAt: now, updatedAt: now, terminalAt: null,
    };
    let resumed = 0;
    const manager = new EngineerRunManager({
      supervisor: {
        getRun: () => run,
        listFailures: () => [{ reasonCode: "FLAKY_TEST_QUARANTINED", evidenceIds: ["flake-evidence"] }],
        listEvidenceBundles: () => { throw new Error("flake retry must not require an evidence bundle"); },
        transition: (input: { nextState: EngineerRun["state"] }) => {
          run = { ...run, state: input.nextState, stateVersion: run.stateVersion + 1 };
          return { run };
        },
      } as never,
      verification: { resumeRecovered: () => { resumed += 1; } } as never,
      principal, preflight: preflight(),
    });

    await expect(manager.resolveHumanReview(principal, run.runId, "retry", "Retry the quarantined check once."))
      .resolves.toEqual({ run: expect.objectContaining({ state: "VERIFICATION_RECOVERY" }), publication: null });
    expect(resumed).toBe(1);
  });

  test("surfaces deferred publication decisions without treating the safe fence as an error", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const now = "2026-07-16T12:00:00.000Z";
    let run: EngineerRun = {
      runId: "deferred-publication", userId: principal.ownerId, repository,
      requestOriginal: "Review verified work", requestNormalized: "Review verified work",
      state: "HUMAN_REVIEW_REQUIRED", stateVersion: 7, manifestHash: `sha256:${"a".repeat(64)}`,
      riskTier: "MEDIUM", humanGateRequired: true, createdAt: now, updatedAt: now, terminalAt: null,
    };
    let publicationCalls = 0;
    const manager = new EngineerRunManager({
      supervisor: {
        getRun: () => run,
        listEvidenceBundles: () => [{ evidenceBundleId: "bundle-1" }],
        getPublicationEvidence: () => ({ evidenceBundleId: "bundle-1", reviewerDecision: "HUMAN_REVIEW_REQUIRED" }),
        transition: (input: { nextState: "REVIEW_APPROVED" }) => {
          run = { ...run, state: input.nextState, stateVersion: run.stateVersion + 1 };
          return { run };
        },
      } as never,
      publication: {
        start: async () => {
          publicationCalls += 1;
          return { status: "DEFERRED_DECISIONS_PENDING" as const, decisionIds: ["decision-1"] };
        },
      } as never,
      principal,
      preflight: { assertRunAdmission: async () => undefined } as never,
    });

    await expect(manager.resolveHumanReview(
      principal, run.runId, "approve" as never, "Verified evidence reviewed; deferred preference remains.",
    )).rejects.toMatchObject({ code: "ENGINEER_VERIFIED_CANDIDATE_REQUIRED" });
    expect(run).toMatchObject({ state: "HUMAN_REVIEW_REQUIRED", stateVersion: 7 });
    expect(publicationCalls).toBe(0);
  });

  test("resumes publication exactly when the final deferred decision is resolved", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const now = "2026-07-16T12:00:00.000Z";
    const run: EngineerRun = {
      runId: "resolve-final-deferred", userId: principal.ownerId, repository,
      requestOriginal: "Review verified work", requestNormalized: "Review verified work",
      state: "REVIEW_APPROVED", stateVersion: 8, manifestHash: `sha256:${"a".repeat(64)}`,
      riskTier: "MEDIUM", humanGateRequired: true, createdAt: now, updatedAt: now, terminalAt: null,
    };
    let open = true;
    let publicationCalls = 0;
    const manager = new EngineerRunManager({
      supervisor: {
        getRun: () => run,
        resolveDecision: () => { open = false; return { resolutionId: "resolution-1" }; },
        listOpenDecisions: () => open ? [{ decisionId: "decision-1", classification: "DEFER" }] : [],
      } as never,
      publication: {
        start: async () => {
          publicationCalls += 1;
          return { status: "AWAITING_APPROVAL" as const, approval: { approvalRequestId: "approval-1" } };
        },
      } as never,
      principal,
      preflight: { assertRunAdmission: async () => undefined } as never,
    });

    const result = await manager.resolveDecision(principal, run.runId, "decision-1", {
      expectedStateVersion: run.stateVersion,
      selectedOptionId: "recommended",
      rationale: "Apply the reviewed option.",
      idempotencyKey: "resolve-final-deferred-once",
    });
    expect(result.publication).toMatchObject({ status: "AWAITING_APPROVAL" });
    expect(publicationCalls).toBe(1);
  });

  test("keeps owned cancellation available when repository admission becomes stale", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-stale-cancel-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    supervisor.receiveRequest({ runId: "stale-cancel", userId: principal.ownerId, repository, request: "Stop safely" });
    const manager = new EngineerRunManager({
      supervisor,
      principal,
      preflight: preflight(probe({ repository: async () => ({ readable: true, exactBaseCommit: false }) })),
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
    });
    await manager.cancel(principal, "stale-cancel", "User requested cancellation after the base advanced.");
    expect(supervisor.getRun("stale-cancel").state).toBe("CANCELLED");
    expect(supervisor.listEvents("stale-cancel").map((event) => event.nextState)).toEqual(["CANCELLATION_PENDING", "CANCELLED"]);
    await manager.cancel(principal,"stale-cancel","Replay the same safe cancellation.");
    expect(supervisor.listEvents("stale-cancel").map((event)=>event.nextState)).toEqual(["CANCELLATION_PENDING","CANCELLED"]);
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("boot recovery autonomously completes a cancellation stranded after its durable transition", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-resume-cancel-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    let run = supervisor.receiveRequest({ runId: "pending-cancel", userId: principal.ownerId, repository, request: "Stop safely" });
    run = supervisor.transition({
      runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "CANCELLATION_PENDING",
      reasonCode: "USER_CANCELLATION_REQUESTED", idempotencyKey: "interrupted-cancel",
    }).run;
    expect(run.state).toBe("CANCELLATION_PENDING");
    let cleanupCalls=0;
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      cleanupRun:()=>{cleanupCalls+=1;},
    });
    const recoveries=manager.recoverPendingCancellations();
    expect(recoveries.map((recovery)=>recovery.runId)).toEqual([run.runId]);
    await Promise.all(recoveries.map((recovery)=>recovery.promise));
    expect(supervisor.getRun(run.runId).state).toBe("CANCELLED");
    expect(cleanupCalls).toBe(1);
    expect(manager.recoverPendingCancellations()).toEqual([]);
    expect(supervisor.listEvents(run.runId).at(-1)).toMatchObject({ nextState: "CANCELLED", reasonCode: "RUN_CLEANUP_COMPLETE" });
    expect(supervisor.listEvents(run.runId).filter((event)=>event.nextState==="CANCELLATION_PENDING")).toHaveLength(1);
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("a lease-enabled manager has no implicit cancellation timer or post-close database access", async () => {
    let closed=false,scans=0;
    const supervisor={
      listRuns:()=>{
        scans+=1;
        if(closed)throw new Error("database is closed");
        return [];
      },
    } as never;
    const manager=new EngineerRunManager({supervisor,principal:deriveEngineerPrincipal({gatewayIdentitySecret:"no-timer-owner"}),
      preflight:preflight(),leaseManager:{} as never,leaseTtlMs:1});
    closed=true;
    // The previous per-manager default fired after 250ms and touched closed
    // fixture databases. Production scheduling now belongs only to index.ts.
    await new Promise<void>((resolve)=>setTimeout(resolve,275));
    expect(scans).toBe(0);
    closed=false;
    await manager.drain();
    expect(scans).toBe(1);
  });

  test("concurrent duplicate cancellation converges on one cleanup and one terminal transition", async () => {
    const root=mkdtempSync(join(tmpdir(),"zintus-engineer-concurrent-cancel-"));
    const engineerDb=join(root,"engineer.db"),leaseDb=join(root,"worker-leases.db");
    const supervisor=new EngineerSupervisor({dbPath:engineerDb});
    const peerSupervisor=new EngineerSupervisor({dbPath:engineerDb});
    const principal=deriveEngineerPrincipal({gatewayIdentitySecret:"concurrent-cancel-owner"});
    const run=supervisor.receiveRequest({runId:"concurrent-cancel",userId:principal.ownerId,repository,request:"Stop once"});
    const leaseOptions={dbPath:leaseDb,tokenSecret:"shared-cancellation-lease-secret-at-least-32-bytes",
      maxConcurrentLeases:4,recoverExpiredLease:()=>undefined};
    const leaseA=new EngineerWorkerLeaseManager(leaseOptions);
    const leaseB=new EngineerWorkerLeaseManager(leaseOptions);
    let cleanupCalls=0,releaseCleanup!:()=>void;
    const cleanupBlocked=new Promise<void>((resolve)=>{releaseCleanup=resolve;});
    const fixedNow=()=>new Date("2026-07-18T12:00:00.000Z");
    const artifactRoot=join(root,"artifacts");
    const managerA=new EngineerRunManager({supervisor,principal,preflight:preflight(),leaseManager:leaseA,
      leaseTtlMs:1_000,now:fixedNow,
      artifactStore:new LocalArtifactStore({root:artifactRoot}),
      cleanupRun:async()=>{cleanupCalls+=1;await cleanupBlocked;}});
    // Force the peer to exercise the real post-put election race: both of its
    // pre-request reads observe the original state, while the atomic Supervisor
    // request still sees manager A's committed CANCELLATION_PENDING intent.
    let staleReads=2;
    const staleSnapshot=supervisor.getRun(run.runId);
    const stalePeer=new Proxy(peerSupervisor,{get(target,key){
      if(key==="getRun")return (runId:string)=>staleReads-->0?staleSnapshot:target.getRun(runId);
      const value=Reflect.get(target,key,target);
      return typeof value==="function"?value.bind(target):value;
    }});
    const managerB=new EngineerRunManager({supervisor:stalePeer,principal,preflight:preflight(),leaseManager:leaseB,
      leaseTtlMs:1_000,now:fixedNow,
      artifactStore:new LocalArtifactStore({root:artifactRoot}),
      cleanupRun:async()=>{cleanupCalls+=1;await cleanupBlocked;}});
    const first=managerA.cancel(principal,run.runId,"User requested stop.");
    for(let attempt=0;attempt<20&&cleanupCalls===0;attempt+=1)await new Promise<void>((resolve)=>setTimeout(resolve,1));
    expect(cleanupCalls).toBe(1);
    const second=managerB.cancel(principal,run.runId,"User requested stop.");
    await second;
    const electedArtifact=supervisor.listArtifacts(run.runId).find((artifact)=>artifact.type==="CANCELLATION_REQUEST");
    expect(electedArtifact).toBeDefined();
    expect(existsSync(electedArtifact!.storageReference)).toBe(true);
    releaseCleanup();
    await first;
    expect(supervisor.getRun(run.runId).state).toBe("CANCELLED");
    expect(supervisor.listEvents(run.runId).map((event)=>event.nextState)).toEqual(["CANCELLATION_PENDING","CANCELLED"]);
    expect(supervisor.listArtifacts(run.runId).filter((artifact)=>artifact.type==="CANCELLATION_REQUEST")).toHaveLength(1);
    await managerA.cancel(principal,run.runId,"Terminal replay.");
    await managerA.drain();await managerB.drain();leaseA.close();leaseB.close();
    peerSupervisor.close();supervisor.close();rmSync(root,{recursive:true,force:true});
  });

  test("periodic recovery converges after a live execution lease releases normally without a restart", async () => {
    const root=mkdtempSync(join(tmpdir(),"zintus-engineer-watchdog-cancel-"));
    const supervisor=new EngineerSupervisor({dbPath:join(root,"engineer.db")});
    const principal=deriveEngineerPrincipal({gatewayIdentitySecret:"owner-secret"});
    const run=supervisor.receiveRequest({runId:"watchdog-pending-cancel",userId:principal.ownerId,repository,request:"Stop safely"});
    const leaseOptions={dbPath:join(root,"worker-leases.db"),
      tokenSecret:"normal-release-cancellation-secret-at-least-32-bytes",maxConcurrentLeases:4,
      recoverExpiredLease:()=>undefined};
    const executionLeases=new EngineerWorkerLeaseManager(leaseOptions);
    const cancellationLeases=new EngineerWorkerLeaseManager(leaseOptions);
    const active=executionLeases.acquire({resourceKey:`run:${run.runId}`,ownerId:"execution-owner",ttlMs:1_000,
      idempotencyKey:"execution-active"});
    let cleanupCalls=0;
    const manager=new EngineerRunManager({supervisor,principal,preflight:preflight(),leaseManager:cancellationLeases,
      leaseTtlMs:1_000,
      artifactStore:new LocalArtifactStore({root:join(root,"artifacts")}),cleanupRun:()=>{cleanupCalls+=1;}});
    await manager.cancel(principal,run.runId,"Stop after the active worker releases.");
    expect(supervisor.getRun(run.runId).state).toBe("CANCELLATION_PENDING");
    expect(cleanupCalls).toBe(0);
    executionLeases.release({leaseId:active.lease.leaseId,ownerId:"execution-owner",
      fencingToken:active.lease.fencingToken,leaseToken:active.leaseToken,idempotencyKey:"execution-release"});
    const recoveries=manager.recoverPendingCancellations();
    expect(recoveries.map((item)=>item.runId)).toEqual([run.runId]);
    await Promise.all(recoveries.map((item)=>item.promise));
    expect(supervisor.getRun(run.runId).state).toBe("CANCELLED");
    expect(cleanupCalls).toBe(1);
    manager.resumeCancellation(run.runId);
    await new Promise<void>((resolve)=>setTimeout(resolve,0));
    expect(cleanupCalls).toBe(1);
    expect(supervisor.listEvents(run.runId).map((event)=>event.nextState)).toEqual(["CANCELLATION_PENDING","CANCELLED"]);
    await manager.drain();executionLeases.close();cancellationLeases.close();
    supervisor.close();rmSync(root,{recursive:true,force:true});
  });

  test("a cancellation owner fenced after cleanup cannot terminalize and a replacement converges", async () => {
    const root=mkdtempSync(join(tmpdir(),"zintus-engineer-stale-cancel-owner-"));
    const engineerDb=join(root,"engineer.db"),leaseDb=join(root,"worker-leases.db");
    const supervisorA=new EngineerSupervisor({dbPath:engineerDb});
    const supervisorB=new EngineerSupervisor({dbPath:engineerDb});
    const principal=deriveEngineerPrincipal({gatewayIdentitySecret:"stale-cancel-owner-secret"});
    const run=supervisorA.receiveRequest({runId:"stale-cancel-owner",userId:principal.ownerId,repository,
      request:"Fence stale cleanup authority"});
    let clockMs=Date.parse("2026-07-18T12:00:00.000Z");
    const now=()=>new Date(clockMs);
    const leaseOptions={dbPath:leaseDb,tokenSecret:"stale-owner-shared-secret-at-least-32-bytes",
      maxConcurrentLeases:4,recoverExpiredLease:()=>undefined,now};
    const leaseA=new EngineerWorkerLeaseManager(leaseOptions);
    const leaseB=new EngineerWorkerLeaseManager(leaseOptions);
    let cleanupCalls=0,replacement:ReturnType<EngineerWorkerLeaseManager["acquire"]>|null=null;
    const cleanup=()=>{
      cleanupCalls+=1;
      if(cleanupCalls!==1)return;
      // Simulate authority expiry and a new fenced owner after the external
      // cleanup side effect but before the original owner's terminal CAS.
      clockMs+=2_000;
      replacement=leaseB.acquire({resourceKey:`run:${run.runId}`,ownerId:"replacement-fence-holder",ttlMs:1_000,
        idempotencyKey:"replacement-after-cleanup"});
    };
    const managerA=new EngineerRunManager({supervisor:supervisorA,principal,preflight:preflight(),leaseManager:leaseA,
      leaseTtlMs:1_000,now,
      artifactStore:new LocalArtifactStore({root:join(root,"artifacts")}),cleanupRun:cleanup});
    await expect(managerA.cancel(principal,run.runId,"Stop with a forced post-cleanup fence."))
      .rejects.toThrow("stale, expired, released, or fenced");
    expect(supervisorA.getRun(run.runId).state).toBe("CANCELLATION_PENDING");
    expect(supervisorA.listEvents(run.runId).filter((event)=>event.nextState==="CANCELLED")).toHaveLength(0);
    expect(cleanupCalls).toBe(1);
    const replacementLease=replacement as WorkerLeaseGrant|null;
    if(!replacementLease)throw new Error("replacement lease was not acquired");
    leaseB.release({leaseId:replacementLease.lease.leaseId,ownerId:"replacement-fence-holder",
      fencingToken:replacementLease.lease.fencingToken,leaseToken:replacementLease.leaseToken,
      idempotencyKey:"release-replacement-fence"});
    const managerB=new EngineerRunManager({supervisor:supervisorB,principal,preflight:preflight(),leaseManager:leaseB,
      leaseTtlMs:1_000,now,
      artifactStore:new LocalArtifactStore({root:join(root,"artifacts")}),cleanupRun:cleanup});
    const recoveries=managerB.recoverPendingCancellations();
    expect(recoveries.map((item)=>item.runId)).toEqual([run.runId]);
    await Promise.all(recoveries.map((item)=>item.promise));
    expect(supervisorB.getRun(run.runId).state).toBe("CANCELLED");
    expect(cleanupCalls).toBe(2);
    expect(supervisorB.listEvents(run.runId).filter((event)=>event.nextState==="CANCELLED")).toHaveLength(1);
    await managerA.drain();await managerB.drain();leaseA.close();leaseB.close();
    supervisorA.close();supervisorB.close();rmSync(root,{recursive:true,force:true});
  });

  test("cancels an active planning request instead of disabling the stop path", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-active-plan-cancel-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    supervisor.receiveRequest({ runId: "active-plan-cancel", userId: principal.ownerId, repository, request: "Plan then stop" });
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => { signalReady = resolve; });
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      context: { build: async () => ({}) } as never,
      planning: { plan: (_runId: string, signal?: AbortSignal) => {
        signalReady();
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } } as never,
    });
    const planning = manager.plan(principal, "active-plan-cancel");
    await ready;
    expect(manager.get("active-plan-cancel").activity).toEqual({
      active: true,
      role: "PLANNER",
      detail: "Planner model request or reconciliation is active.",
    });
    await manager.cancel(principal, "active-plan-cancel", "Stop during planning");
    await expect(planning).rejects.toBeInstanceOf(EngineerPlanningCancelledError);
    expect(manager.get("active-plan-cancel")).toMatchObject({
      run: { state: "CANCELLED" }, lastError: null, activity: { active: false, role: null },
    });
    expect(supervisor.listFailures("active-plan-cancel")).toEqual([]);
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("persists cancellation first and returns promptly when a worker ignores abort", async () => {
    const root=mkdtempSync(join(tmpdir(),"zintus-engineer-ignored-abort-cancel-"));
    const supervisor=new EngineerSupervisor({dbPath:join(root,"engineer.db")});
    const principal=deriveEngineerPrincipal({gatewayIdentitySecret:"owner-secret"});
    const run=supervisor.receiveRequest({runId:"ignored-abort-cancel",userId:principal.ownerId,repository,
      request:"Stop an abort-ignoring worker safely"});
    let cancelled=0,finished=0;
    const manager=new EngineerRunManager({supervisor,principal,preflight:preflight(),
      artifactStore:new LocalArtifactStore({root:join(root,"artifacts")}),cancellationDrainTimeoutMs:5,
      execution:{isActive:()=>true,cancel:()=>{cancelled+=1;},waitForIdle:()=>new Promise<void>(()=>undefined),
        finishCancellation:()=>{finished+=1;}} as never});
    const started=performance.now();
    await manager.cancel(principal,run.runId,"Stop without waiting on the provider transport.");
    expect(performance.now()-started).toBeLessThan(250);
    expect(cancelled).toBe(1);
    expect(supervisor.listEvents(run.runId)[0]).toMatchObject({nextState:"CANCELLATION_PENDING",
      reasonCode:"USER_CANCELLATION_REQUESTED"});
    for(let attempt=0;attempt<20&&supervisor.getRun(run.runId).state!=="CANCELLED";attempt+=1)
      await new Promise<void>((resolve)=>setTimeout(resolve,1));
    expect(supervisor.getRun(run.runId).state).toBe("CANCELLED");
    expect(manager.get(run.runId).activity).toMatchObject({active:false,role:null});
    for(let attempt=0;attempt<20&&finished===0;attempt+=1)await new Promise<void>((resolve)=>setTimeout(resolve,1));
    expect(finished).toBe(1);
    supervisor.close();rmSync(root,{recursive:true,force:true});
  });

  test("durably enters planning and persists a retryable pipeline failure across manager restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-durable-planning-error-"));
    const dbPath = join(root, "engineer.db");
    const supervisor = new EngineerSupervisor({ dbPath });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    supervisor.receiveRequest({ runId: "durable-plan", userId: principal.ownerId, repository, request: "Plan work" });
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      context: { build: async () => ({}) } as never,
      planning: { plan: async () => { throw new Error("planner response was malformed"); } } as never,
    });
    await expect(manager.plan(principal, "durable-plan")).rejects.toThrow("planner response was malformed");
    expect(supervisor.getRun("durable-plan").state).toBe("REPLANNING");
    expect(supervisor.listEvents("durable-plan").map((event) => event.nextState)).toEqual(["REQUEST_NORMALIZED", "PLANNING", "REPLANNING"]);
    expect((await manager.snapshot(principal, "durable-plan")).data.errors).toEqual([]);
    supervisor.close();

    const reopened = new EngineerSupervisor({ dbPath });
    const restarted = new EngineerRunManager({ supervisor: reopened, principal, preflight: preflight() });
    expect(restarted.get("durable-plan").lastError).toBe("planner response was malformed");
    reopened.close(); rmSync(root, { recursive: true, force: true });
  });

  test("boot recovery resumes a planning run that has no in-memory owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-recover-planning-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    let run = supervisor.receiveRequest({
      runId: "recover-planning", userId: principal.ownerId, repository, request: "Recover planning after restart",
    });
    run = supervisor.normalizeRequest({
      runId: run.runId, expectedStateVersion: run.stateVersion,
      normalizedRequest: run.requestOriginal, idempotencyKey: "recover-planning-normalize",
    }).run;
    supervisor.transition({
      runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "PLANNING",
      reasonCode: "EVIDENCE_PLANNING_STARTED", idempotencyKey: "recover-planning-start",
    });
    let contextBuilds = 0;
    let planningCalls = 0;
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      context: { build: async () => { contextBuilds += 1; return {}; } } as never,
      planning: { plan: async () => { planningCalls += 1; return null; } } as never,
    });

    const recoveries = manager.recoverPlanning();
    expect(recoveries.map((recovery) => recovery.runId)).toEqual([run.runId]);
    await Promise.all(recoveries.map((recovery) => recovery.promise));
    expect(contextBuilds).toBe(1);
    expect(planningCalls).toBe(1);
    expect(manager.get(run.runId).activity.active).toBe(false);
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("boot recovery requires a human retry when a planner provider outcome is ambiguous", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-ambiguous-planning-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    let run = supervisor.receiveRequest({
      runId: "ambiguous-planning", userId: principal.ownerId, repository, request: "Do not repay an unknown provider call",
    });
    run = supervisor.normalizeRequest({
      runId: run.runId, expectedStateVersion: run.stateVersion,
      normalizedRequest: run.requestOriginal, idempotencyKey: "ambiguous-planning-normalize",
    }).run;
    run = supervisor.transition({
      runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "PLANNING",
      reasonCode: "EVIDENCE_PLANNING_STARTED", idempotencyKey: "ambiguous-planning-start",
    }).run;
    supervisor.recordAgentExecution({
      agentExecutionId: "planner-ambiguous", runId: run.runId, role: "PLANNER", modelTier: "GPT-5.6_TERRA",
      status: "RUNNING", inputHash: `sha256:${"a".repeat(64)}`, outputArtifactId: null,
      startedAt: run.updatedAt, completedAt: null,
    });
    let planningCalls = 0;
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      context: { build: async () => ({}) } as never,
      planning: { plan: async () => { planningCalls += 1; return null; } } as never,
    });

    expect(manager.recoverPlanning()).toEqual([]);
    expect(planningCalls).toBe(0);
    expect(supervisor.getRun(run.runId).state).toBe("MODEL_PROVIDER_RETRY_PENDING");
    expect(supervisor.listFailures(run.runId)).toContainEqual(expect.objectContaining({
      reasonCode: "PLANNING_PROVIDER_OUTCOME_AMBIGUOUS", retryable: true,
    }));
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("lease recovery waits for an active planner to abort, then starts one replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-replace-planning-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    supervisor.receiveRequest({
      runId: "replace-planning", userId: principal.ownerId, repository, request: "Replace the stale planning owner",
    });
    let calls = 0;
    let firstStarted!: () => void;
    let replacementStarted!: () => void;
    const first = new Promise<void>((resolve) => { firstStarted = resolve; });
    const replacement = new Promise<void>((resolve) => { replacementStarted = resolve; });
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      context: { build: async () => ({}) } as never,
      planning: {
        plan: async (_runId: string, signal?: AbortSignal) => {
          calls += 1;
          if (calls === 2) { replacementStarted(); return null; }
          firstStarted();
          return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
        },
      } as never,
    });

    const stale = manager.plan(principal, "replace-planning");
    await first;
    manager.resumePlanning("replace-planning");
    await expect(stale).rejects.toBeInstanceOf(EngineerPlanningCancelledError);
    await replacement;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("automatically restarts planning after a budget pause resumes to PLANNING", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-budget-resume-plan-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    let run = supervisor.receiveRequest({
      runId: "resume-plan", userId: principal.ownerId, repository, request: "Resume the exact planning checkpoint",
      budget: { tokenBudget: 0, lifetimeTokenBudget: 1_000 },
    });
    run = supervisor.transition({
      runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "REQUEST_NORMALIZED",
      reasonCode: "REQUEST_NORMALIZED", idempotencyKey: "resume-plan-normalized",
    }).run;
    run = supervisor.transition({
      runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "PLANNING",
      reasonCode: "PLANNING_STARTED", idempotencyKey: "resume-plan-started",
    }).run;
    supervisor.reconcileBudget(run.runId);
    const paused = supervisor.getRun(run.runId);
    const pausedBudget = supervisor.getBudget(run.runId);
    expect(paused).toMatchObject({ state: "PAUSED_BUDGET" });
    expect(pausedBudget).toMatchObject({ resumeState: "PLANNING" });
    const topped = supervisor.topUpBudget({
      runId: run.runId, expectedRevision: pausedBudget.revision,
      topUp: { addTokenBudget: 100, addCostBudgetUsd: 0, addTimeBudgetSeconds: 0 },
      actorId: principal.ownerId, idempotencyKey: "resume-plan-top-up",
    });
    let signalPlanning!: () => void;
    const planningStarted = new Promise<void>((resolve) => { signalPlanning = resolve; });
    let planningCalls = 0;
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      context: { build: async () => ({}) } as never,
      planning: { plan: async () => { planningCalls += 1; signalPlanning(); return null; } } as never,
    });
    const resumed = await manager.resumeBudget(principal, run.runId, {
      expectedStateVersion: paused.stateVersion, expectedBudgetRevision: topped.revision,
      idempotencyKey: "resume-plan-budget",
    });
    expect(resumed.state).toBe("PLANNING");
    await planningStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(planningCalls).toBe(1);
    expect(supervisor.listFailures(run.runId)).toEqual([]);
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("does not persist a safe execution budget pause as a red run error", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-safe-budget-error-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const run = supervisor.receiveRequest({
      runId: "safe-budget-pause", userId: principal.ownerId, repository, request: "Pause safely",
      budget: { tokenBudget: 0, lifetimeTokenBudget: 1_000 },
    });
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      execution: {
        runQueued: async () => { throw new BudgetPausedError(run.runId, "TOKEN_LIMIT_REACHED"); },
        isActive: () => false,
        drain: async () => undefined,
        destroyAll: () => undefined,
      } as never,
    });
    (manager as unknown as { launchExecution(runId: string): void }).launchExecution(run.runId);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await manager.drain();
    supervisor.setLastError(run.runId, new BudgetPausedError(run.runId, "TOKEN_LIMIT_REACHED").message);
    expect(manager.get(run.runId).lastError).toBeNull();
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("preserves the original verification error through worker cleanup and later cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-review-error-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const run = supervisor.receiveRequest({
      runId: "review-error", userId: principal.ownerId, repository, request: "Review and stop safely",
    });
    const originalError = "isolated Reviewer must submit exactly one structured review call";
    let signalVerification!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { signalVerification = resolve; });
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      execution: {
        runQueued: async () => undefined,
        isActive: () => false,
        cancel: () => undefined,
        drain: async () => undefined,
        destroyAll: () => undefined,
      } as never,
      verification: {
        verify: async () => { signalVerification(); throw new Error(originalError); },
        isActive: () => false,
        cancel: () => undefined,
      } as never,
    });

    (manager as unknown as { launchExecution(runId: string): void }).launchExecution(run.runId);
    await verificationStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(manager.get(run.runId).lastError).toBe(originalError);

    await manager.cancel(principal, run.runId, "Stop after inspecting the review failure.");
    expect(manager.get(run.runId)).toMatchObject({
      run: { state: "CANCELLED" },
      lastError: originalError,
    });
    await manager.drain();
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("graceful drain preserves resumable execution workspaces while cleaning other sandboxes", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const calls: string[] = [];
    let cleanupOptions: { preserveResumable?: boolean } | undefined;
    const manager = new EngineerRunManager({
      principal,
      preflight: preflight(),
      supervisor: { listRuns: () => [] } as never,
      execution: {
        drain: async (cleanupSandboxes: boolean) => { calls.push(`drain:${cleanupSandboxes}`); },
        destroyAll: (options?: { preserveResumable?: boolean }) => { calls.push("destroy"); cleanupOptions = options; },
      } as never,
    });

    await manager.drain();

    expect(calls).toEqual(["drain:false", "destroy"]);
    expect(cleanupOptions).toEqual({ preserveResumable: true });
  });

  test("pauses a timed-out planning attempt for an explicit human retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-planning-timeout-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    supervisor.receiveRequest({ runId: "timed-plan", userId: principal.ownerId, repository, request: "Plan work" });
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      context: { build: async () => ({}) } as never,
      planning: { plan: async () => { throw new EngineerPlanningTimeoutError(120_000); } } as never,
    });
    await expect(manager.plan(principal, "timed-plan")).rejects.toBeInstanceOf(EngineerPlanningTimeoutError);
    expect(manager.get("timed-plan")).toMatchObject({
      run: { state: "MODEL_PROVIDER_RETRY_PENDING" }, lastError: "Evidence planning exceeded the 120000ms execution limit",
    });
    expect(supervisor.listEvents("timed-plan").at(-1)).toMatchObject({
      nextState: "MODEL_PROVIDER_RETRY_PENDING", reasonCode: "PLANNING_PROVIDER_OUTCOME_AMBIGUOUS",
    });
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("keeps the legacy run list complete while exposing explicit bounded pages", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-run-list-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    for (let index = 0; index < 105; index += 1) {
      supervisor.receiveRequest({
        runId: `run-${String(index).padStart(3, "0")}`, userId: principal.ownerId,
        repository, request: `work ${index}`,
      });
    }
    supervisor.receiveRequest({
      runId: "other-owner-run", userId: "other-owner",
      repository: { ...repository, repositoryId: "repo-other", name: "other-fixture" }, request: "other",
    });
    const manager = new EngineerRunManager({ supervisor, principal, preflight: preflight() });
    const legacy = manager.list(principal);
    expect(legacy).toHaveLength(105);
    expect(legacy[0]?.runId).toBe("run-104");
    const page = manager.listPage(principal, { limit: 20 });
    expect(page.runs).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("retries a mixed read and returns status, events, and fence from one run version", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-snapshot-fence-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    supervisor.receiveRequest({ runId: "snapshot-run", userId: principal.ownerId, repository, request: "work" });
    const manager = new EngineerRunManager({ supervisor, principal, preflight: preflight() });
    const listEvents = supervisor.listEvents.bind(supervisor);
    let injected = false;
    let eventReads = 0;
    supervisor.listEvents = ((runId, afterSequence, limit) => {
      eventReads += 1;
      if (!injected) {
        injected = true;
        supervisor.transition({
          runId, expectedStateVersion: 0, nextState: "REQUEST_NORMALIZED",
          reasonCode: "REQUEST_NORMALIZED", idempotencyKey: "snapshot-race",
        });
      }
      return listEvents(runId, afterSequence, limit);
    }) as typeof supervisor.listEvents;
    const snapshot = await manager.snapshot(principal, "snapshot-run");
    expect(eventReads).toBe(2);
    expect(snapshot.status.run).toMatchObject({ state: "REQUEST_NORMALIZED", stateVersion: 1 });
    expect(snapshot.latestEventSequence).toBe(1);
    expect(snapshot.events.at(-1)).toMatchObject({ sequence: 1, nextState: "REQUEST_NORMALIZED", stateVersion: 1 });
    expect(snapshot.snapshotFence).toEqual({ stateVersion: 1, eventSequence: 1 });
    expect(snapshot.data.verifiedCandidate).toBeNull();
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("returns only the verified candidate summary and fails closed on corrupt promotion", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "checkpoint-owner-secret" });
    const signed = await safeCheckpoint("checkpoint-run", principal.ownerId);
    const run: EngineerRun = {
      runId: "checkpoint-run", userId: principal.ownerId, repository,
      requestOriginal: "work", requestNormalized: "work", state: "REQUEST_RECEIVED", stateVersion: 0,
      manifestHash: null, riskTier: "LOW", humanGateRequired: false,
      createdAt: "2026-07-17T09:00:00.000Z", updatedAt: "2026-07-17T09:00:00.000Z", terminalAt: null,
    };
    let reads = 0;
    const supervisor = {
      getRun: () => run,
      getVerifiedCandidateCheckpoint: async () => { reads += 1; return signed; },
      reconcileBudget: () => ({}), getLastError: () => null,
      latestEventSequence: () => 0, listEvents: () => [], listArtifacts: () => [],
      listFailures: () => [], listDecisions: () => [],
    } as unknown as EngineerSupervisor;
    const manager = new EngineerRunManager({ supervisor, principal, preflight: preflight(), checkpointAttestor });
    const summary = await manager.checkpoint(principal, run.runId);
    expect(summary).toEqual({
      checkpointId: signed.checkpoint.checkpointId, checkpointHash: signed.checkpoint.checkpointHash,
      resultCommitSha: signed.checkpoint.resultCommitSha, classificationResult: "READY", requiredTestCount: 2,
      allRequiredChecksPassed: true, openBlockingCriticalCount: 0,
      environmentDigest: signed.checkpoint.environmentDigest, createdAt: signed.checkpoint.createdAt,
    });
    expect(JSON.stringify(summary)).not.toContain(principal.ownerId);
    const snapshot = await manager.snapshot(principal, run.runId);
    expect(snapshot.data.verifiedCandidate).toEqual(summary);
    await expect(manager.checkpoint(deriveEngineerPrincipal({ gatewayIdentitySecret: "another-owner" }), run.runId))
      .rejects.toThrow("untrusted Engineer principal");
    expect(reads).toBe(2);
    supervisor.getVerifiedCandidateCheckpoint = async () => { throw new VerifiedCandidateIntegrityError(run.runId); };
    await expect(manager.checkpoint(principal, run.runId)).rejects.toBeInstanceOf(VerifiedCandidateIntegrityError);
    await expect(manager.snapshot(principal, run.runId)).rejects.toBeInstanceOf(VerifiedCandidateIntegrityError);
  });

  test("returns null only when no candidate was promoted", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "checkpoint-null-owner" });
    const run = { runId: "checkpoint-null", userId: principal.ownerId } as EngineerRun;
    const manager = new EngineerRunManager({
      supervisor: { getRun: () => run, getVerifiedCandidateCheckpoint: async () => null } as unknown as EngineerSupervisor,
      principal, preflight: preflight(), checkpointAttestor,
    });
    expect(await manager.checkpoint(principal, run.runId)).toBeNull();
  });

  test("dispatches optional-hardening checkpoint reads to v2 and returns the same owner-safe summary", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "hardening-checkpoint-owner" });
    const parent = await safeCheckpoint("parent-checkpoint-run", principal.ownerId);
    const { checkpointId: _id, checkpointHash: _hash, schemaVersion: _schema, policyVersion: _policy,
      parentCheckpointId: _parent, ...evidence } = parent.checkpoint;
    const signed = await createVerifiedHardeningCandidateCheckpoint({ ...evidence,
      schemaVersion: 2, policyVersion: "verified-hardening-candidate-checkpoint-v2",
      runId: "hardening-checkpoint-run", parentCheckpointId: parent.checkpoint.checkpointId,
      parentCheckpointHash: parent.checkpoint.checkpointHash, hardeningLineageId: sha256("lineage-id"),
      hardeningLineageHash: sha256("lineage-hash"), seedAttestationId: sha256("seed-id"),
      seedAttestationHash: sha256("seed-hash"),
    }, checkpointAttestor);
    const run = { runId: signed.checkpoint.runId, userId: principal.ownerId } as EngineerRun;
    let v1Reads = 0, v2Reads = 0;
    const manager = new EngineerRunManager({ supervisor: {
      getRun: () => run, isOptionalHardeningChild: () => true,
      getVerifiedCandidateCheckpoint: async () => { v1Reads += 1; return null; },
      getVerifiedHardeningCandidateCheckpoint: async () => { v2Reads += 1; return signed; },
    } as unknown as EngineerSupervisor, principal, preflight: preflight(), checkpointAttestor });
    await expect(manager.checkpoint(principal, run.runId)).resolves.toMatchObject({
      checkpointId: signed.checkpoint.checkpointId, checkpointHash: signed.checkpoint.checkpointHash,
      resultCommitSha: signed.checkpoint.resultCommitSha, allRequiredChecksPassed: true,
    });
    expect({ v1Reads, v2Reads }).toEqual({ v1Reads: 0, v2Reads: 1 });
  });

  test("retries the snapshot when state changes during asynchronous checkpoint verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-checkpoint-snapshot-race-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "checkpoint-snapshot-owner" });
    supervisor.receiveRequest({ runId: "checkpoint-snapshot-race", userId: principal.ownerId, repository, request: "work" });
    let reads = 0;
    supervisor.getVerifiedCandidateCheckpoint = (async () => {
      reads += 1;
      if (reads === 1) {
        supervisor.transition({
          runId: "checkpoint-snapshot-race", expectedStateVersion: 0, nextState: "REQUEST_NORMALIZED",
          reasonCode: "REQUEST_NORMALIZED", idempotencyKey: "checkpoint-snapshot-race",
        });
      }
      await Promise.resolve();
      return null;
    }) as typeof supervisor.getVerifiedCandidateCheckpoint;
    const manager = new EngineerRunManager({ supervisor, principal, preflight: preflight(), checkpointAttestor });
    const snapshot = await manager.snapshot(principal, "checkpoint-snapshot-race");
    expect(reads).toBe(2);
    expect(snapshot.status.run).toMatchObject({ state: "REQUEST_NORMALIZED", stateVersion: 1 });
    expect(snapshot.snapshotFence).toEqual({ stateVersion: 1, eventSequence: 1 });
    expect(snapshot.data.verifiedCandidate).toBeNull();
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("exposes approval authority only for a strict pending approval", () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "approval-view-owner" });
    const run = { runId: "approval-view", userId: principal.ownerId } as EngineerRun;
    const base = {
      status: "PENDING", verifiedCheckpointId: sha256("approval-checkpoint"),
      verifiedCheckpointHash: sha256("approval-checkpoint-hash"), approvalRevision: 4,
    };
    let approval: typeof base | null = base;
    const manager = new EngineerRunManager({
      supervisor: { getRun: () => run, latestApprovalRequest: () => approval } as unknown as EngineerSupervisor,
      principal, preflight: preflight(),
    });
    expect(manager.approvalAuthority(run.runId)).toEqual({
      expectedVerifiedCheckpointId: base.verifiedCheckpointId,
      expectedVerifiedCheckpointHash: base.verifiedCheckpointHash,
      expectedApprovalRevision: 4,
    });
    approval = { ...base, status: "APPROVED" };
    expect(manager.approvalAuthority(run.runId)).toBeNull();
    approval = { ...base, verifiedCheckpointId: null as never };
    expect(manager.approvalAuthority(run.runId)).toBeNull();
  });

  test("replays the promotion event evidence ID unchanged through the SSE cursor", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "checkpoint-sse-owner" });
    const checkpointId = sha256("sse-checkpoint");
    const run = { runId: "sse-checkpoint-run", userId: principal.ownerId, state: "REVIEW_APPROVED" } as EngineerRun;
    const event = {
      eventId: "promotion-event", runId: run.runId, sequence: 1, stateVersion: 1,
      previousState: "REVIEWING", nextState: "REVIEW_APPROVED", reasonCode: "VERIFIED_CANDIDATE_PROMOTED",
      actorType: "SUPERVISOR", actorId: "engineer-supervisor", evidenceIds: [checkpointId],
    };
    const manager = new EngineerRunManager({
      supervisor: {
        getRun: () => run, latestEventSequence: () => 1,
        listEvents: (_runId: string, after: number) => after < 1 ? [event] : [],
      } as unknown as EngineerSupervisor,
      principal, preflight: preflight(),
    });
    const text = await new Response(manager.subscribe(run.runId, 0)).text();
    expect(text).toContain(`id: 1\nevent: state\ndata: ${JSON.stringify(event)}\n\n`);
    expect((JSON.parse(text.match(/data: (.+)/)![1]!) as { evidenceIds: string[] }).evidenceIds).toEqual([checkpointId]);
  });


  test("derives stable pseudonymous authority without exposing the subject", () => {
    const first = deriveEngineerPrincipal({ gatewayIdentitySecret: "server-secret", authenticatedSubject: "person@example.com" });
    const replay = deriveEngineerPrincipal({ gatewayIdentitySecret: "server-secret", authenticatedSubject: "person@example.com" });
    const other = deriveEngineerPrincipal({ gatewayIdentitySecret: "server-secret", authenticatedSubject: "other@example.com" });
    expect(first).toEqual(replay);
    expect(first).not.toEqual(other);
    expect(JSON.stringify(first)).not.toContain("person@example.com");
    expect(first.safetyIdentifier).toMatch(/^[a-f0-9]{64}$/);
  });

  test("persists install identity across restarts and separates installs", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-identity-"));
    const first = loadOrCreateEngineerPrincipal(join(root, "one", "identity.json"));
    const restarted = loadOrCreateEngineerPrincipal(join(root, "one", "identity.json"));
    const separate = loadOrCreateEngineerPrincipal(join(root, "two", "identity.json"));
    expect(restarted).toEqual(first);
    expect(separate).not.toEqual(first);
    rmSync(root, { recursive: true, force: true });
  });

  test("failed capability admission leaves the run ledger untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-preflight-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const gate = preflight(probe({ repository: async () => ({ readable: true, exactBaseCommit: false }) }));
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "server-secret" });
    const manager = new EngineerRunManager({ supervisor, preflight: gate, principal });
    await expect(manager.create(principal, { runId: "must-not-exist", repository, request: "Do work" }))
      .rejects.toThrow("exact base commit");
    expect(supervisor.listRuns()).toEqual([]);
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("requires exact model features and immutable execution image", async () => {
    const incapable = new EngineerCapabilityPreflight({
      models: ["exact-model"], publicationEnabled: false,
      repository: canonicalRepository,
      execution: { imageReference: "zintus/engineer", imageDigest: `sha256:${"a".repeat(64)}` },
      probe: probe({ model: async () => ({ available: true, responsesApi: true, strictStructuredOutputs: false }) }),
    });
    await expect(incapable.assertStartup()).rejects.toThrow("structured-output");

    const mutable = new EngineerCapabilityPreflight({
      models: ["exact-model"], publicationEnabled: false,
      repository: canonicalRepository, execution: { imageReference: "zintus/engineer", imageDigest: "latest" }, probe: probe(),
    });
    await expect(mutable.assertStartup()).rejects.toThrow("immutable sha256");
  });

  test("caches successful readiness briefly and revalidates local execution boundaries after TTL", async () => {
    let modelReady = true;
    const gate = preflight(probe({
      model: async () => ({ available: modelReady, responsesApi: modelReady, strictStructuredOutputs: modelReady }),
    }));
    await gate.assertStartup();
    expect(gate.readiness()).toEqual({ state: "READY", error: null });
    modelReady = false;
    await expect(gate.assertStartup()).resolves.toBeUndefined();
    expect(gate.readiness()).toEqual({ state: "READY", error: null });

    const canonical = preflight();
    await expect(canonical.assertRunAdmission({ ...repository, owner: "spoofed-owner" }))
      .rejects.toThrow("canonical fixture");

    let exactImage = true;
    let nowMs = 10_000;
    const runtimeGate = new EngineerCapabilityPreflight({
      models: ["exact-model"], publicationEnabled: false, repository: canonicalRepository,
      execution: { imageReference: `registry.example/zintus/engineer@sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` },
      probe: probe({ image: async () => ({ exactDigest: exactImage }) }),
      successTtlMs: 1_000, now: () => nowMs,
    });
    await runtimeGate.assertRunAdmission(repository);
    exactImage = false;
    await expect(runtimeGate.assertRunAdmission(repository)).resolves.toBeUndefined();
    nowMs += 1_001;
    await expect(runtimeGate.assertRunAdmission(repository)).rejects.toThrow("image digest");
    await expect(canonical.assertRunAdmission({ ...repository, baseCommitSha: "2".repeat(40) }))
      .rejects.toThrow("canonical fixture");
  });

  test("advances only the canonical base after a credentialed stale-base recovery", async () => {
    const gate = preflight();
    await gate.assertRunAdmission(repository);
    const advanced = { ...repository, baseCommitSha: "2".repeat(40) };
    gate.acceptAdvancedBase(repository.baseCommitSha, advanced);
    expect(gate.repository().baseCommitSha).toBe(advanced.baseCommitSha);
    await expect(gate.assertRunAdmission(advanced)).resolves.toBeUndefined();
    expect(() => gate.acceptAdvancedBase(advanced.baseCommitSha, { ...advanced, owner: "attacker" }))
      .toThrow("canonical repository identity");
    expect(() => gate.acceptAdvancedBase("3".repeat(40), { ...advanced, baseCommitSha: "4".repeat(40) }))
      .toThrow("advanced concurrently");
  });

  test("strict capability proof rejects extras, duplicates, wrong types, and model mismatch", async () => {
    const capability = (output: unknown[], responseModel = "exact-model") => createLocalEngineerCapabilityProbe({
      repositoryId: repository.repositoryId, repositoryRoot: tmpdir(), expectedOriginUrl: "file:///fixture",
      transport: async () => ({
        async create() { return { id: "probe", model: responseModel, output } as never; },
      }),
    }).model("exact-model");
    expect(await capability([{ type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: true }) }]))
      .toEqual({ available: true, responsesApi: true, strictStructuredOutputs: true });
    for (const invalid of [
      [{ type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: true, extra: true }) }],
      [{ type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: "true" }) }],
      [{ type: "function_call", name: "capability_ready", arguments: "{" }],
      [
        { type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: true }) },
        { type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: true }) },
      ],
    ]) {
      expect((await capability(invalid)).strictStructuredOutputs).toBe(false);
    }
    expect((await capability([{ type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: true }) }], "different-model")).strictStructuredOutputs).toBe(false);
  });

  test("rechecks publication authority and rejects every forged principal mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-authority-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const forged = deriveEngineerPrincipal({ gatewayIdentitySecret: "attacker-secret" });
    const deniedPublication = preflight(probe({ publication: async () => ({ available: true, pullRequestsWritable: false }) }), true);
    const deniedManager = new EngineerRunManager({ supervisor, principal, preflight: deniedPublication });
    await expect(deniedManager.create(principal, { runId: "no-publication", repository, request: "work" }))
      .rejects.toThrow("publication capability");
    expect(supervisor.listRuns()).toEqual([]);

    let publicationReady = true;
    let nowMs = 20_000;
    const changingPublication = new EngineerCapabilityPreflight({
      models: ["gpt-sol", "gpt-terra", "gpt-luna"], publicationEnabled: true,
      repository: canonicalRepository,
      probe: probe({ publication: async () => ({ available: publicationReady, pullRequestsWritable: publicationReady }) }),
      successTtlMs: 1_000, now: () => nowMs,
    });
    await changingPublication.assertStartup();
    publicationReady = false;
    await expect(changingPublication.assertStartup()).resolves.toBeUndefined();
    nowMs += 1_001;
    await expect(changingPublication.assertStartup()).rejects.toThrow("publication capability");
    expect(changingPublication.readiness().state).toBe("FAILED");

    const manager = new EngineerRunManager({ supervisor, principal, preflight: preflight() });
    await manager.create(principal, { runId: "owned", repository, request: "work" });
    await expect(manager.create(forged, { runId: "forged", repository, request: "work" })).rejects.toThrow("untrusted");
    await expect(manager.plan(forged, "owned")).rejects.toThrow("untrusted");
    await expect(manager.start(forged, "owned")).rejects.toThrow("untrusted");
    await expect(manager.freeze(forged, "owned", { expectedStateVersion: 0, manifest: {} as never, idempotencyKey: "forged-freeze" })).rejects.toThrow("untrusted");
    // R8-3 P1 #3: the legacy approval WRITE methods (approve/requestChanges/
    // reject/extendApproval/expireApproval) are removed; cancel remains and still
    // proves the owner-forgery guard rejects a non-owning principal.
    await expect(manager.cancel(forged, "owned", "forged")).rejects.toThrow("untrusted");
    expect(supervisor.getRun("owned").state).toBe("REQUEST_RECEIVED");
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("failed re-admission blocks plan and start before workflow mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-readmission-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    let ready = true;
    const gate = preflight(probe({
      repository: async () => ({ readable: ready, exactBaseCommit: ready }),
    }));
    const manager = new EngineerRunManager({ supervisor, principal, preflight: gate });
    await manager.create(principal, { runId: "admission-run", repository, request: "work" });
    const before = supervisor.getRun("admission-run");
    ready = false;
    await expect(manager.plan(principal, "admission-run")).rejects.toThrow("exact base commit");
    await expect(manager.start(principal, "admission-run")).rejects.toThrow("exact base commit");
    expect(supervisor.getRun("admission-run")).toEqual(before);
    expect(supervisor.listEvents("admission-run")).toEqual([]);
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("advisory facade binds every read and command to the authenticated owner", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "advisory-owner" });
    const calls: unknown[][] = [];
    const leaked = `sk-${"a".repeat(32)}`;
    const item = { advisoryId: `sha256:${"a".repeat(64)}`, status: "OPEN", revision: 1,
      description: `description ${leaked}`, recommendedChange: `change ${leaked}` };
    const supervisor = {
      getRun: (runId: string) => ({ runId, userId: runId === "foreign-run" ? "another-owner" : principal.ownerId }),
      listAdvisoryBacklogForOwner: (...args: unknown[]) => { calls.push(args); return { schemaVersion: 1, materializationStatus: "COMPLETE", items: [item], nextCursor: null }; },
      deferAdvisoryForOwner: (...args: unknown[]) => { calls.push(args); return { ...item, status: "DEFERRED", revision: 2 }; },
      dismissAdvisoryForOwner: (...args: unknown[]) => { calls.push(args); return { ...item, status: "DISMISSED", revision: 2 }; },
      reopenAdvisoryForOwner: (...args: unknown[]) => { calls.push(args); return { ...item, status: "OPEN", revision: 3 }; },
    };
    const manager = new EngineerRunManager({ supervisor: supervisor as never, principal, preflight: {} as never });
    const command = { expectedRevision: 1, idempotencyKey: "advisory-operation", rationale: null };
    const page = await manager.listAdvisories(principal, "owned-run", { limit: 10, status: "OPEN" });
    expect(page).toMatchObject({ materializationStatus: "COMPLETE" });
    expect(page).not.toHaveProperty("status");
    expect(JSON.stringify(page)).not.toContain(leaked);
    const deferred = await manager.deferAdvisory(principal, "owned-run", "advisory-1", command);
    expect(deferred).toMatchObject({ status: "DEFERRED" });
    expect(JSON.stringify(deferred)).not.toContain(leaked);
    expect(await manager.dismissAdvisory(principal, "owned-run", "advisory-1", command)).toMatchObject({ status: "DISMISSED" });
    expect(await manager.reopenAdvisory(principal, "owned-run", "advisory-1", command)).toMatchObject({ status: "OPEN" });
    expect(calls).toEqual([
      [principal.ownerId, "owned-run", { limit: 10, status: "OPEN" }],
      [principal.ownerId, "owned-run", "advisory-1", command],
      [principal.ownerId, "owned-run", "advisory-1", command],
      [principal.ownerId, "owned-run", "advisory-1", command],
    ]);
    await expect(manager.listAdvisories(principal, "foreign-run", { limit: 10 })).rejects.toThrow("does not own");
    expect(calls).toHaveLength(4);
  });

  test("hardening facade derives owner authority and returns only the quote public view", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "hardening-owner" });
    const calls: unknown[][] = [];
    const quote = {
      schemaVersion: 1 as const, policyVersion: "engineer-hardening-estimate-v1",
      quoteId: `sha256:${"a".repeat(64)}`, quoteHash: `sha256:${"b".repeat(64)}`, parentRunId: "owned-run",
      requesterUserId: principal.ownerId, repositoryId: "repo-1", parentCheckpointId: `sha256:${"c".repeat(64)}`,
      parentCheckpointHash: `sha256:${"d".repeat(64)}`, parentStateVersion: 4, selectionHash: `sha256:${"e".repeat(64)}`,
      advisoryIds: [`sha256:${"f".repeat(64)}`], routingPolicyVersion: "routing-v1", pricingVersion: "pricing-v1",
      estimatorVersion: "deterministic-hardening-estimator-v1",
      estimate: { maxCostMicrousd: 1000, maxTokens: 100, maxTimeSeconds: 30, maxPlannerCalls: 0, maxBuilderCalls: 1, maxReviewerCalls: 1, automaticRepairCalls: 0 },
      assumptions: ["ESTIMATE_IS_HARD_CAP"], createdAt: "2026-07-18T10:00:00.000Z", expiresAt: "2026-07-18T10:15:00.000Z",
      status: "ACTIVE" as const, internalAuthority: "must-not-leak",
    };
    const consent = {
      schemaVersion: 1 as const, policyVersion: "engineer-hardening-consent-v1" as const,
      quoteId: quote.quoteId, quoteHash: quote.quoteHash, parentRunId: quote.parentRunId,
      parentCheckpointId: quote.parentCheckpointId, parentCheckpointHash: quote.parentCheckpointHash,
      parentStateVersion: quote.parentStateVersion, selectionHash: quote.selectionHash,
      requesterUserId: principal.ownerId, actorId: principal.ownerId,
      authorizedBudget: { costMicrousd: 1000, tokens: 100, timeSeconds: 30 },
      acknowledgements: { separateRun: true as const, parentCandidateUnchanged: true as const, noAutomaticRepair: true as const, noOverages: true as const },
      idempotencyKey: "consent-op", acceptedAt: "2026-07-18T10:01:00.000Z", quoteExpiresAt: quote.expiresAt,
      consentId: `sha256:${"1".repeat(64)}`, consentHash: `sha256:${"2".repeat(64)}`,
    };
    const supervisor = {
      getRun: (runId: string) => ({ runId, userId: runId === "foreign-run" ? "another-owner" : principal.ownerId }),
      createHardeningQuoteForOwner: (...args: unknown[]) => { calls.push(args); return quote; },
      getHardeningQuoteForOwner: (...args: unknown[]) => { calls.push(args); return quote; },
      acceptHardeningConsentForOwner: (...args: unknown[]) => { calls.push(args); return consent; },
    };
    const manager = new EngineerRunManager({ supervisor: supervisor as never, principal, preflight: {} as never });
    const quoteInput = { runId: "owned-run", advisoryIds: quote.advisoryIds, expectedParentStateVersion: 4, idempotencyKey: "quote-op" };
    const view = await manager.createHardeningQuote(principal, "owned-run", quoteInput);
    expect(view).not.toHaveProperty("internalAuthority");
    expect(view).toMatchObject({ quoteId: quote.quoteId, status: "ACTIVE", requesterUserId: principal.ownerId });
    await manager.getHardeningQuote(principal, "owned-run", quote.quoteId);
    const consentInput = {
      quoteId: quote.quoteId, quoteHash: quote.quoteHash, authorizedBudget: { costMicrousd: 1000, tokens: 100, timeSeconds: 30 },
      acknowledgements: { separateRun: true as const, parentCandidateUnchanged: true as const, noAutomaticRepair: true as const, noOverages: true as const },
      expectedParentStateVersion: 4, idempotencyKey: "consent-op",
    };
    await expect(manager.acceptHardeningConsent(principal, "owned-run", consentInput)).resolves.toEqual(consent);
    expect(calls).toEqual([
      [principal.ownerId, quoteInput],
      [principal.ownerId, "owned-run", quote.quoteId],
      [principal.ownerId, "owned-run", consentInput],
    ]);
    await expect(manager.createHardeningQuote(principal, "owned-run", { ...quoteInput, runId: "foreign-run" }))
      .rejects.toMatchObject({ code: "ENGINEER_HARDENING_AUTHORITY_INVALID" });
    await expect(manager.getHardeningQuote(principal, "foreign-run", quote.quoteId)).rejects.toThrow("does not own");
    expect(calls).toHaveLength(3);
  });

  test("optional hardening child facade derives owner authority and validates the public view", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "hardening-child-owner" });
    const input = { consentId: `sha256:${"1".repeat(64)}`, consentHash: `sha256:${"2".repeat(64)}` };
    const child = {
      schemaVersion: 1 as const,
      parentRunId: "owned-run",
      rootRunId: "owned-run",
      childRunId: "hardening-child-1",
      lineageId: `sha256:${"3".repeat(64)}`,
      lineageHash: `sha256:${"4".repeat(64)}`,
      state: "REQUEST_RECEIVED" as const,
      stateVersion: 0 as const,
      riskTier: "HIGH" as const,
      humanGateRequired: true as const,
      budget: { costMicrousd: 1000, tokens: 100, timeSeconds: 30 },
      createdAt: "2026-07-18T10:02:00.000Z",
    };
    const lineage = {
      schemaVersion: 1 as const, policyVersion: "engineer-hardening-lineage-v1" as const, relation: "OPTIONAL_HARDENING" as const,
      lineageId: child.lineageId, lineageHash: child.lineageHash, rootRunId: child.rootRunId, parentRunId: child.parentRunId, childRunId: child.childRunId,
      parentCheckpointId: `sha256:${"5".repeat(64)}`, parentCheckpointHash: `sha256:${"6".repeat(64)}`,
      parentBaseCommitSha: "a".repeat(40), seedResultCommitSha: "b".repeat(40), quoteId: `sha256:${"7".repeat(64)}`,
      quoteHash: `sha256:${"8".repeat(64)}`, consentId: input.consentId, consentHash: input.consentHash,
      selectionHash: `sha256:${"9".repeat(64)}`, budget: child.budget, createdAt: child.createdAt,
    };
    const creation = { child, lineage };
    const calls: unknown[][] = [];
    const supervisor = {
      getRun: (runId: string) => ({ runId, userId: runId === "foreign-run" ? "another-owner" : principal.ownerId }),
      createOptionalHardeningChildForOwner: (...args: unknown[]) => { calls.push(args); return creation; },
    };
    const manager = new EngineerRunManager({ supervisor: supervisor as never, principal, preflight: {} as never });
    await expect(manager.createOptionalHardeningChild(principal, "owned-run", input)).resolves.toEqual(creation);
    expect(calls).toEqual([[principal.ownerId, "owned-run", input]]);
    await expect(manager.createOptionalHardeningChild(principal, "foreign-run", input)).rejects.toThrow("does not own");
    await expect(manager.createOptionalHardeningChild(principal, "owned-run", { ...input, consentId: "invalid" }))
      .rejects.toThrow();
    (supervisor as { createOptionalHardeningChildForOwner: (...args: unknown[]) => unknown }).createOptionalHardeningChildForOwner = () => ({ child });
    await expect(manager.createOptionalHardeningChild(principal, "owned-run", input)).rejects.toThrow();
    (supervisor as { createOptionalHardeningChildForOwner: (...args: unknown[]) => unknown }).createOptionalHardeningChildForOwner = () => ({
      ...creation, lineage: { ...lineage, requesterUserId: principal.ownerId },
    });
    await expect(manager.createOptionalHardeningChild(principal, "owned-run", input)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("rejects missing or split optional-hardening worker-lease wiring before seed or provider work",async()=>{
    const principal=deriveEngineerPrincipal({gatewayIdentitySecret:"hardening-lease-wiring-owner"}),
      parentRunId="hardening-lease-parent",childRunId="hardening-lease-child";let preparations=0,seedWrites=0,providers=0;
    const supervisor={getRun:(runId:string)=>({runId,userId:principal.ownerId}),prepareOptionalHardeningStartForOwner:async()=>{
      preparations+=1;return {};}};
    const authorityA={} as EngineerWorkerLeaseManager,authorityB={} as EngineerWorkerLeaseManager;
    const execution={usesWorkerLeaseAuthority:(authority:unknown)=>authority===authorityA,
      materializeOptionalHardeningSeed:async()=>{seedWrites+=1;return {};}};
    const verification={usesWorkerLeaseAuthority:(authority:unknown)=>authority===authorityA,
      verify:async()=>{providers+=1;return {};}};
    const input={expectedChildStateVersion:0 as const,lineageId:sha256("lease-lineage"),
      lineageHash:sha256("lease-lineage-hash"),idempotencyKey:"lease-start"};
    const missing=new EngineerRunManager({supervisor:supervisor as never,execution:execution as never,
      verification:verification as never,principal,preflight:{} as never});
    await expect(missing.startOptionalHardeningChild(principal,parentRunId,childRunId,input)).rejects.toMatchObject({
      code:"ENGINEER_HARDENING_WORKER_LEASE_AUTHORITY_UNAVAILABLE"});
    const split=new EngineerRunManager({supervisor:supervisor as never,execution:execution as never,
      verification:verification as never,leaseManager:authorityB,principal,preflight:{} as never});
    await expect(split.startOptionalHardeningChild(principal,parentRunId,childRunId,input)).rejects.toMatchObject({
      code:"ENGINEER_HARDENING_WORKER_LEASE_AUTHORITY_UNAVAILABLE"});
    expect({preparations,seedWrites,providers}).toEqual({preparations:0,seedWrites:0,providers:0});
  });

  test("boot recovery reconstructs a committed hardening start without planning or duplicate authority", async () => {
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "hardening-recovery-owner" });
    const operation = {
      operationId: `sha256:${"1".repeat(64)}`, operationHash: `sha256:${"2".repeat(64)}`,
      requesterUserId: principal.ownerId, childRunId: "hardening-recovery-child", expectedChildStateVersion: 0 as const,
      lineageId: `sha256:${"3".repeat(64)}`, lineageHash: `sha256:${"4".repeat(64)}`, idempotencyKey: "recover-start",
      createdAt: "2026-07-18T12:00:00.000Z",
    };
    const signedSeed = { attestation: { seedAttestationId: `sha256:${"5".repeat(64)}`, seedAttestationHash: `sha256:${"a".repeat(64)}`,
      seedDiffHash: `sha256:${"6".repeat(64)}` } };
    let run = { runId: operation.childRunId, userId: principal.ownerId, state: "REQUEST_RECEIVED", stateVersion: 0 };
    const calls: string[] = [];
    const preparation = { replay: true, operation, signedSeed,
      lineage:{requesterUserId:principal.ownerId,rootRunId:"hardening-parent",parentRunId:"hardening-parent",childRunId:operation.childRunId,
        repositoryId:"repository-1",lineageId:operation.lineageId,lineageHash:operation.lineageHash},
      authority:{quoteId:`sha256:${"7".repeat(64)}`,quoteHash:`sha256:${"8".repeat(64)}`,
        consentId:`sha256:${"9".repeat(64)}`,consentHash:`sha256:${"b".repeat(64)}`},
      parentCheckpoint:{checkpointId:`sha256:${"c".repeat(64)}`,checkpointHash:`sha256:${"d".repeat(64)}`}};
    const supervisor = {
      listOptionalHardeningStartOperationsForOwner: () => [{ parentRunId: "hardening-parent", operation }],
      listExpiredOptionalHardeningStartClaimsForOwner: () => [],
      listOptionalHardeningStartClaimsForRecovery: () => [],
      getRun: (runId: string) => runId === "hardening-parent" ? { runId, userId: principal.ownerId } : run,
      prepareOptionalHardeningStartForOwner: async () => { calls.push("prepare"); return preparation; },
      claimOptionalHardeningStart: () => { calls.push("claim"); return {applied:true,fence:{claimId:`sha256:${"e".repeat(64)}`,
        fenceToken:`sha256:${"f".repeat(64)}`,generation:1,status:"PREPARING",sandboxId:null}}; },
      finalizeOptionalHardeningStart: () => { calls.push("finalize"); run = { ...run, state: "PLAN_FROZEN", stateVersion: 4 }; return { status: "READY", run }; },
      finalizeOptionalHardeningStartClaim: () => calls.push("finalize-claim"),
      isOptionalHardeningChild: () => true,
      setLastError: () => undefined,
    };
    const execution = {
      recoverOptionalHardeningSeed: async () => true,
      materializeOptionalHardeningSeed: async () => { calls.push("seed"); return signedSeed; },
      getSandbox: () => undefined,
      discardOptionalHardeningSeed: async () => calls.push("discard"),
      enqueue: () => { calls.push("enqueue"); run = { ...run, state: "QUEUED", stateVersion: 5 }; return run; },
      runQueued: async () => { calls.push("execute"); run = { ...run, state: "IMPLEMENTING", stateVersion: 6 }; return {}; },
      usesWorkerLeaseAuthority:(authority:unknown)=>authority===leaseAuthority,
    };
    const leaseAuthority={} as EngineerWorkerLeaseManager,verification={
      usesWorkerLeaseAuthority:(authority:unknown)=>authority===leaseAuthority,
      verify:async()=>{calls.push("verify");return {};},
    };
    const manager = new EngineerRunManager({ supervisor: supervisor as never, execution: execution as never,
      verification:verification as never,leaseManager:leaseAuthority,principal, preflight: {} as never, checkpointAttestor });

    const recoveries = manager.recoverOptionalHardeningStarts();
    expect(recoveries.map((recovery) => recovery.runId)).toEqual([operation.childRunId]);
    await Promise.all(recoveries.map((recovery) => recovery.promise));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["prepare", "claim", "finalize", "enqueue", "execute","verify"]);
    expect(manager.recoverOptionalHardeningStarts()).toEqual([]);
  });

  test("dedicated late hardening recovery prepares signed authority, snapshots, and resumes with zero provider calls",async()=>{
    const principal=deriveEngineerPrincipal({gatewayIdentitySecret:"hardening-verification-recovery-owner"});
    const childRunId="hardening-verification-recovery-child",parentRunId="hardening-verification-recovery-parent";
    const operation={operationId:sha256("late-operation"),operationHash:sha256("late-operation-hash"),
      requesterUserId:principal.ownerId,childRunId,expectedChildStateVersion:0 as const,lineageId:sha256("late-lineage"),
      lineageHash:sha256("late-lineage-hash"),idempotencyKey:"late-recovery",createdAt:"2026-07-18T12:00:00.000Z"};
    const preparation={replay:true,operation,signedSeed:{attestation:{seedAttestationId:sha256("late-seed"),
      seedAttestationHash:sha256("late-seed-hash")}}};
    const snapshot={runId:childRunId,state:"SECURITY_REVIEW",stateVersion:8,authorityHash:sha256("late-snapshot"),
      preparation,stage:{kind:"BUILDER"}};
    const calls:string[]=[];let outstanding=false,terminalAt:string|null=null,providerCalls=0,
      childState="SECURITY_REVIEW",childStateVersion=8;
    const supervisor={
      listOptionalHardeningStartOperationsForOwner:()=>[{parentRunId,operation}],
      getRun:(runId:string)=>runId===parentRunId?{runId,userId:principal.ownerId}:{runId,userId:principal.ownerId,
        state:childState,stateVersion:childStateVersion,terminalAt},
      hasOutstandingHardeningPaidCallRecoveryWork:()=>outstanding,
      prepareOptionalHardeningStartForOwner:async()=>{calls.push("prepare");return preparation;},
      quarantineOptionalHardeningRecovery:()=>{calls.push("quarantine");},
    };
    const execution={prepareOptionalHardeningWorkspaceRecovery:()=>{calls.push("snapshot");return snapshot;}};
    const verification={resumeOptionalHardeningRecovered:async()=>{calls.push("resume");return {runId:childRunId};}};
    const manager=new EngineerRunManager({supervisor:supervisor as never,execution:execution as never,
      verification:verification as never,principal,preflight:{} as never});
    const recoveries=manager.recoverOptionalHardeningVerification([childRunId]);
    expect(recoveries).toHaveLength(1);await recoveries[0]!.promise;
    expect(calls).toEqual(["prepare","snapshot","resume"]);expect(providerCalls).toBe(0);
    outstanding=true;expect(manager.recoverOptionalHardeningVerification([childRunId])).toEqual([]);
    outstanding=false;terminalAt="2026-07-18T12:01:00.000Z";expect(manager.recoverOptionalHardeningVerification([childRunId])).toEqual([]);

    terminalAt=null;(execution as {prepareOptionalHardeningWorkspaceRecovery:()=>unknown}).prepareOptionalHardeningWorkspaceRecovery=()=>{
      throw new HardeningGenericOperationForbiddenError();};
    const failed=manager.recoverOptionalHardeningVerification([childRunId]);
    await expect(failed[0]!.promise).rejects.toMatchObject({code:"HARDENING_WORKSPACE_RECOVERY_AUTHORITY_INVALID"});
    expect(calls.at(-1)).toBe("quarantine");expect(providerCalls).toBe(0);

    childState="SECURITY_REVIEW";childStateVersion=8;
    let releasePreparation!:(value:typeof preparation)=>void;
    (supervisor as {prepareOptionalHardeningStartForOwner:()=>Promise<typeof preparation>}).prepareOptionalHardeningStartForOwner=()=>
      new Promise((resolve)=>{releasePreparation=resolve;});
    const quarantinesBefore=calls.filter((item)=>item==="quarantine").length;
    const cancelled=manager.recoverOptionalHardeningVerification([childRunId]);
    childState="CANCELLATION_PENDING";childStateVersion=9;releasePreparation(preparation);
    await expect(cancelled[0]!.promise).resolves.toMatchObject({state:"CANCELLATION_PENDING",stateVersion:9});
    expect(calls.filter((item)=>item==="quarantine")).toHaveLength(quarantinesBefore);
    expect(providerCalls).toBe(0);

    childState="SECURITY_REVIEW";childStateVersion=8;
    (supervisor as {prepareOptionalHardeningStartForOwner:()=>Promise<typeof preparation>}).prepareOptionalHardeningStartForOwner=async()=>{
      throw new HardeningGenericOperationForbiddenError();};
    const rejectedPreparation=manager.recoverOptionalHardeningVerification([childRunId]);
    await expect(rejectedPreparation[0]!.promise).rejects.toMatchObject({code:"HARDENING_WORKSPACE_RECOVERY_AUTHORITY_INVALID"});
    expect(calls.filter((item)=>item==="quarantine")).toHaveLength(quarantinesBefore+1);
    expect(providerCalls).toBe(0);
  });

  test("boot recovery durably waits for a live hardening lease and runs exactly once after expiry", async () => {
    for(const initialState of ["REQUEST_RECEIVED","PLAN_FROZEN","QUEUED"] as const){
      const principal=deriveEngineerPrincipal({gatewayIdentitySecret:`lease-recovery-${initialState}`});const childRunId=`lease-child-${initialState}`;
      const parentRunId=`lease-parent-${initialState}`;const input={expectedChildStateVersion:0 as const,lineageId:`sha256:${"1".repeat(64)}`,
        lineageHash:`sha256:${"2".repeat(64)}`,idempotencyKey:"lease-start"};let run={runId:childRunId,userId:principal.ownerId,state:initialState,stateVersion:0};
      let starts=0,enqueues=0,executes=0;const operation={operationId:`sha256:${"3".repeat(64)}`,operationHash:`sha256:${"4".repeat(64)}`,
        requesterUserId:principal.ownerId,childRunId,expectedChildStateVersion:0,lineageId:input.lineageId,lineageHash:input.lineageHash,
        idempotencyKey:input.idempotencyKey,createdAt:"2026-07-18T12:00:00.000Z"};
      const signedSeed={attestation:{seedAttestationId:`sha256:${"5".repeat(64)}`,seedAttestationHash:`sha256:${"6".repeat(64)}`,
        seedDiffHash:`sha256:${"7".repeat(64)}`}};const preparation={replay:false,operation,signedSeed:null,
        lineage:{requesterUserId:principal.ownerId,rootRunId:parentRunId,parentRunId,childRunId,repositoryId:"repository-1",
          lineageId:input.lineageId,lineageHash:input.lineageHash},authority:{quoteId:`sha256:${"8".repeat(64)}`,quoteHash:`sha256:${"9".repeat(64)}`,
          consentId:`sha256:${"a".repeat(64)}`,consentHash:`sha256:${"b".repeat(64)}`},
        parentCheckpoint:{checkpointId:`sha256:${"c".repeat(64)}`,checkpointHash:`sha256:${"d".repeat(64)}`}};
      const expiresAt=new Date(Date.now()+25).toISOString();const supervisor={
        listOptionalHardeningStartOperationsForOwner:()=>[],listExpiredOptionalHardeningStartClaimsForOwner:()=>[],
        listOptionalHardeningStartClaimsForRecovery:()=>[{parentRunId,childRunId,leaseExpiresAt:expiresAt,input}],
        getRun:(id:string)=>id===parentRunId?{runId:id,userId:principal.ownerId}:run,
        prepareOptionalHardeningStartForOwner:async()=>{starts+=1;return preparation;},
        claimOptionalHardeningStart:()=>({applied:true,fence:{claimId:`sha256:${"e".repeat(64)}`,fenceToken:`sha256:${"f".repeat(64)}`,
          generation:2,status:"PREPARING",sandboxId:null}}),previewOptionalHardeningStart:()=>({status:"READY",manifest:{manifestHash:`sha256:${"0".repeat(64)}`}}),
        commitOptionalHardeningStartForOwner:async()=>{run={...run,state:"PLAN_FROZEN",stateVersion:4};return {...preparation,signedSeed};},
        finalizeOptionalHardeningStart:()=>({status:"READY",run}),isOptionalHardeningChild:()=>true,setLastError:()=>undefined};
      const execution={materializeOptionalHardeningSeed:async()=>signedSeed,prepareOptionalHardeningSeedCommit:()=>({sandbox:{sandboxId:"sandbox"},checkpoint:{}}),
        completeOptionalHardeningSeedCommit:()=>({sandboxId:"sandbox"}),discardOptionalHardeningSeed:async()=>undefined,
        enqueue:()=>{enqueues+=1;run={...run,state:"QUEUED",stateVersion:5};return run;},runQueued:async()=>{executes+=1;return {};},
        usesWorkerLeaseAuthority:(authority:unknown)=>authority===leaseAuthority};
      const leaseAuthority={} as EngineerWorkerLeaseManager,verification={usesWorkerLeaseAuthority:(authority:unknown)=>
        authority===leaseAuthority,verify:async()=>({})};
      const manager=new EngineerRunManager({supervisor:supervisor as never,execution:execution as never,principal,preflight:{} as never,
        verification:verification as never,leaseManager:leaseAuthority,checkpointAttestor,now:()=>new Date(Date.now())});
      const first=manager.recoverOptionalHardeningStarts(),second=manager.recoverOptionalHardeningStarts();
      expect(first).toHaveLength(1);expect(second[0]!.promise).toBe(first[0]!.promise);expect(starts).toBe(0);await first[0]!.promise;
      await new Promise((resolve)=>setTimeout(resolve,0));expect(starts).toBe(1);expect(enqueues).toBe(1);expect(executes).toBe(1);
    }
  });
});
