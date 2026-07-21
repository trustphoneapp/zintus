import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  BuilderNoProgressError,
  BudgetPausedError,
  buildIsolatedReviewerRequestPlan,
  CodexBuilder,
  canonicalJson,
  DockerSandboxManager,
  EngineerExecutionManager,
    EngineerWorkerLeaseManager,
    HardeningGenericOperationForbiddenError,
  StaleWorkerLeaseError,
  EngineerSupervisor,
  GitWorkspaceManager,
  LocalArtifactStore,
  MAX_BUILDER_TOOL_CALLS_PER_RESPONSE,
  MAX_BUILDER_TOOL_CALLS_PER_RUN,
  BUILDER_CONTEXT_COMPACTION_THRESHOLD_TOKENS,
  BUILDER_MAX_OUTPUT_TOKENS,
  builderInputContextHash,
  MAX_BUILDER_MODEL_TOOL_OUTPUT_BYTES,
  MAX_BUILDER_DISCOVERY_ROUNDS_BEFORE_MUTATION,
  OpenAIResponsesTransport,
  countResponseInputTokens,
  estimateResponseInputTokens,
  isProviderModelTimeout,
  modelRetryBackoffMs,
  OfflineDependencyBundle,
  OFFLINE_DEPENDENCY_MANIFEST,
  TaskManifestSchema,
  TrustedCommandExecutor,
  WarmSandboxPool,
  isManifestPathAllowed,
  resolveEngineerModel,
  resolveManifestPath,
  ReviewerInputSchema,
  reviewerEvidenceBundleHash,
  gitCommitLockfileHash,
  sha256,
  workspaceLockfileHash,
  hashDependencyTree,
  type ResponsesTransport,
  type BuilderContinuation,
  type CheckpointAttestor,
  type SandboxRecord,
  type TaskManifest,
  type WorkspaceRecord,
} from "./index.js";
import type { OptionalHardeningStartPreparation } from "./ledger.js";
import { transitionToPlanReadyForTest } from "./test-planning-evidence.js";
import { hardeningCheckpointMilestoneKey,projectHardeningArtifactAuthority } from
  "./hardening-verification-recovery.js";

const roots: string[] = [];

const bunGitSpawn = ((command: string, args: readonly string[]) => {
  const capture = mkdtempSync(join(tmpdir(), "zintus-test-git-"));
  const stdoutPath = join(capture, "stdout");
  const stderrPath = join(capture, "stderr");
  const result = Bun.spawnSync([
    "/bin/sh", "-c", 'out="$1"; err="$2"; shift 2; "$@" >"$out" 2>"$err"',
    "zintus-test-git", stdoutPath, stderrPath, command, ...args,
  ], { stdout: "ignore", stderr: "ignore" });
  const stdout = readFileSync(stdoutPath, "utf8");
  const stderr = readFileSync(stderrPath, "utf8");
  rmSync(capture, { recursive: true, force: true });
  return {
    pid: result.pid,
    status: result.exitCode,
    signal: result.signalCode == null ? null : String(result.signalCode),
    stdout,
    stderr,
    output: [null, stdout, stderr],
    error: undefined,
  };
}) as typeof import("node:child_process").spawnSync;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zintus-engineer-phase2-")));
  roots.push(root);
  return root;
}

function initRepository(root: string, includeLockfile = false): { sha: string; path: string } {
  const path = join(root, "repository");
  mkdirSync(join(path, "src"), { recursive: true });
  writeFileSync(join(path, "src", "value.ts"), "export const value = 1;\n");
  if (includeLockfile) writeFileSync(join(path, "bun.lock"), '{"lockfileVersion":1}\n');
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "test@zintus.local"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Zintus Test"]);
  execFileSync("git", ["-C", path, "add", "."]);
  execFileSync("git", ["-C", path, "commit", "-qm", "base"]);
  const head = readFileSync(join(path, ".git", "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) throw new Error("fixture HEAD is unexpectedly detached");
  const sha = readFileSync(join(path, ".git", head.slice(5)), "utf8").trim();
  return { path, sha };
}

function manifest(runId: string, sha: string, overrides: Partial<TaskManifest> = {}): TaskManifest {
  const content = {
    manifestVersion: 1,
    runId,
    repository: {
      repositoryId: "repo-1",
      provider: "local" as const,
      owner: "local",
      name: "fixture",
      baseBranch: "main",
      baseCommitSha: sha,
    },
    request: { original: "Change value", normalized: "Change src/value.ts to export value 2." },
    acceptanceCriteria: [{
      criterionId: "criterion-1", statement: "Value is two", verificationMethod: "unit test", priority: "MUST" as const,
    }],
    testPlan: [{
      testId: "test-1", criterionIds: ["criterion-1"], type: "UNIT" as const,
      description: "Run tests", command: "bun run test",
    }],
    allowedPaths: ["src/**"],
    deniedPaths: [],
    allowedCommands: ["bun run test"],
    prohibitedCommands: [],
    riskTier: "MEDIUM" as const,
    humanGateRequired: true,
    retryBudgets: {
      sameFailureAttempts: 2, builderRepairAttempts: 4, reviewerFixAttempts: 2,
      plannerRestarts: 1, sandboxProvisioningAttempts: 3, transientModelAttempts: 3,
    },
    timeBudgetSeconds: 600,
    tokenBudget: 100_000,
    costBudgetUsd: 10,
    createdAt: "2026-07-14T12:00:00.000Z",
  };
  return TaskManifestSchema.parse({ ...content, ...overrides, manifestHash: sha256({ ...content, ...overrides }) });
}

function records(root: string, runId: string, sha: string): {
  workspace: WorkspaceRecord;
  sandbox: SandboxRecord;
} {
  const workspace = {
    workspaceIdentity: "workspace-1", runId, repositoryRoot: root, workspaceRoot: root,
    branchName: "zintus/engineer/test", baseCommitSha: sha, originUrl: null,
    createdAt: "2026-07-14T12:00:00.000Z",
  } satisfies WorkspaceRecord;
  const sandbox = {
    sandboxId: "sandbox-1", runId, workspaceIdentity: workspace.workspaceIdentity,
    imageReference: `oven/bun@sha256:${"a".repeat(64)}`,
    imageDigest: `sha256:${"a".repeat(64)}`,
    environmentDigest: `sha256:${"b".repeat(64)}`,
    networkPolicyVersion: "network-v1", sandboxPolicyVersion: "sandbox-v1",
    status: "READY" as const, source: "COLD" as const,
    createdAt: "2026-07-14T12:00:00.000Z", destroyedAt: null,
  } satisfies SandboxRecord;
  return { workspace, sandbox };
}

describe("Phase 2 immutable artifacts", () => {
  test("rejects tampered Resolution Desk lineage before queue state or provider transport", () => {
    let runReads = 0;
    let transitions = 0;
    let transports = 0;
    const supervisor = {
      isOptionalHardeningChild: () => false,
      listArtifacts: () => [],
      resolutionCorrectedRunDirective: () => { throw new Error("replacement lineage is tampered"); },
      getRun: () => { runReads += 1; throw new Error("run must not be read after failed authority"); },
      transition: () => { transitions += 1; throw new Error("transition must not be reached"); },
    };
    const manager = new EngineerExecutionManager({
      supervisor: supervisor as never,
      sandboxManager: {} as never,
      artifactStore: {} as never,
      repositoryRootFor: () => "",
      transportForRun: () => { transports += 1; throw new Error("provider must not be reached"); },
    });
    expect(() => manager.enqueue("tampered-corrected-run")).toThrow("replacement lineage is tampered");
    expect({ runReads, transitions, transports }).toEqual({ runReads: 0, transitions: 0, transports: 0 });
  });

  test("stores content-addressed bytes and detects later tampering", () => {
    const root = temporaryRoot();
    const store = new LocalArtifactStore({ root: join(root, "artifacts"), idFactory: () => "artifact-1" });
    const record = store.put({
      runId: "run-1", type: "COMMAND_STDOUT", bytes: "trusted output",
      producerType: "EXECUTOR", producerId: "sandbox-1", trusted: true,
    });
    expect(record.sha256).toBe(`sha256:${record.storageReference.split("/").at(-1)}`);
    expect(record.sha256).toBe("sha256:ddf0f2a1a25187e39d547b4c3bb3ff9a5442dc2f7d5e7ad7593409d9c733ad52");
    expect(store.read(record).toString()).toBe("trusted output");
    writeFileSync(record.storageReference, "tampered");
    expect(() => store.read(record)).toThrow("integrity check failed");
  });

  test("strict reads reject an artifact-root symlink swap even when outside bytes have the exact hash",()=>{
    const root=temporaryRoot(),artifactRoot=join(root,"artifacts"),outsideRoot=join(root,"outside-artifacts"),
      originalRoot=join(root,"original-artifacts");let attack:(()=>void)|null=null;
    const store=new LocalArtifactStore({root:artifactRoot,afterStrictReadStageForTest:(stage)=>{
      if(stage==="ROOT_OPENED")attack?.();}}),record=store.put({runId:"root-swap",type:"LOG",bytes:"trusted",
        producerType:"SYSTEM",producerId:"system",trusted:true}),digest=record.storageReference.split("/").at(-1)!;
    mkdirSync(join(outsideRoot,"root-swap"),{recursive:true});writeFileSync(join(outsideRoot,"root-swap",digest),"trusted");
    attack=()=>{attack=null;renameSync(artifactRoot,originalRoot);symlinkSync(outsideRoot,artifactRoot,"dir");};
    expect(()=>store.readVerifiedExact(record)).toThrow("strict path integrity check failed");
  });

  test("canonicalizes a legitimate ancestor alias before minting strict artifact references",()=>{
    const root=temporaryRoot(),realParent=join(root,"real-parent"),aliasParent=join(root,"alias-parent");
    mkdirSync(realParent,{recursive:true});symlinkSync(realParent,aliasParent,"dir");
    const store=new LocalArtifactStore({root:join(aliasParent,"artifacts")}),record=store.put({runId:"alias-run",type:"LOG",
      bytes:"trusted",producerType:"SYSTEM",producerId:"system",trusted:true});
    expect(record.storageReference.startsWith(`${realParent}/artifacts/alias-run/`)).toBe(true);
    expect(store.readVerifiedExact(record).toString("utf8")).toBe("trusted");
  });

  test("strict reads reject a run-directory symlink swap while legacy reads retain compatibility",()=>{
    const root=temporaryRoot(),artifactRoot=join(root,"artifacts"),outsideRun=join(root,"outside-run");let attack:(()=>void)|null=null;
    const store=new LocalArtifactStore({root:artifactRoot,afterStrictReadStageForTest:(stage)=>{
      if(stage==="RUN_OPENED")attack?.();}}),record=store.put({runId:"run-swap",type:"LOG",bytes:"trusted",
        producerType:"SYSTEM",producerId:"system",trusted:true}),runRoot=dirname(record.storageReference),
      originalRun=join(artifactRoot,"run-swap-original"),digest=record.storageReference.split("/").at(-1)!;
    mkdirSync(outsideRun,{recursive:true});writeFileSync(join(outsideRun,digest),"trusted");
    attack=()=>{attack=null;renameSync(runRoot,originalRun);symlinkSync(outsideRun,runRoot,"dir");};
    expect(()=>store.readVerifiedExact(record)).toThrow("strict path integrity check failed");
    expect(store.read(record).toString("utf8")).toBe("trusted");
  });

  test("strict reads reject leaf substitution between lstat and O_NOFOLLOW open",()=>{
    const root=temporaryRoot(),outsideFile=join(root,"outside-leaf");let attack:(()=>void)|null=null;
    const store=new LocalArtifactStore({root:join(root,"artifacts"),afterStrictReadStageForTest:(stage)=>{
      if(stage==="LEAF_VALIDATED")attack?.();}}),record=store.put({runId:"leaf-swap",type:"LOG",bytes:"trusted",
        producerType:"SYSTEM",producerId:"system",trusted:true});
    writeFileSync(outsideFile,"trusted");attack=()=>{attack=null;renameSync(record.storageReference,
      `${record.storageReference}.original`);symlinkSync(outsideFile,record.storageReference);};
    expect(()=>store.readVerifiedExact(record)).toThrow("strict path integrity check failed");
  });

  test("strict reads reject a concurrent run-root swap after the artifact descriptor is open",()=>{
    const root=temporaryRoot(),artifactRoot=join(root,"artifacts"),outsideRun=join(root,"concurrent-outside");
    let attack:(()=>void)|null=null;
    const store=new LocalArtifactStore({root:artifactRoot,afterStrictReadStageForTest:(stage)=>{
      if(stage==="ARTIFACT_OPENED")attack?.();}}),record=store.put({runId:"concurrent-swap",type:"LOG",bytes:"trusted",
        producerType:"SYSTEM",producerId:"system",trusted:true}),runRoot=dirname(record.storageReference),
      originalRun=join(artifactRoot,"concurrent-swap-original"),digest=record.storageReference.split("/").at(-1)!;
    mkdirSync(outsideRun,{recursive:true});writeFileSync(join(outsideRun,digest),"trusted");
    attack=()=>{attack=null;renameSync(runRoot,originalRun);symlinkSync(outsideRun,runRoot,"dir");};
    expect(()=>store.readVerifiedExact(record)).toThrow("strict path integrity check failed");
  });

  test("enforces the configured artifact size cap", () => {
    const root = temporaryRoot();
    const store = new LocalArtifactStore({ root, maxArtifactBytes: 3 });
    expect(() => store.put({
      runId: "run-1", type: "LOG", bytes: "four", producerType: "SYSTEM", producerId: "system", trusted: true,
    })).toThrow("byte limit");
  });

  test("rejects aggregate run artifacts before writing beyond the run cap", () => {
    const root = temporaryRoot();
    const store = new LocalArtifactStore({ root, maxArtifactBytes: 4, maxRunArtifactBytes: 8 });
    store.put({
      runId: "run-1", type: "LOG", bytes: "four", producerType: "SYSTEM", producerId: "system", trusted: true,
    });
    expect(() => store.put({
      runId: "run-1", type: "LOG", bytes: "more", producerType: "SYSTEM", producerId: "system", trusted: true,
    })).toThrow("run artifacts exceed");
    expect(store.put({
      runId: "run-2", type: "LOG", bytes: "more", producerType: "SYSTEM", producerId: "system", trusted: true,
    }).sizeBytes).toBe(4);
  });
});

describe("Phase 2 exact-base Git workspaces", () => {
  test("creates a distinct run branch at the exact requested commit", () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const manager = new GitWorkspaceManager({ workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn });
    const workspace = manager.create({ runId: "run-1", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    expect(manager.currentCommit(workspace)).toBe(repository.sha);
    expect(workspace.branchName).toStartWith("zintus/engineer/run-1-");
    expect(workspace.workspaceRoot).not.toBe(repository.path);
    manager.remove(workspace);
  });

  test("rejects a base SHA that does not exist", () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const manager = new GitWorkspaceManager({ workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn });
    expect(() => manager.create({
      runId: "run-1", repositoryRoot: repository.path, baseCommitSha: "0".repeat(40),
    })).toThrow();
  });

  test("materializes an exact verified candidate diff into a fresh base workspace", () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    writeFileSync(join(repository.path, "src", "value.ts"), "export const value = 2;\n");
    const finalDiff = execFileSync("git", ["-C", repository.path, "diff", "--binary", repository.sha], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repository.path, "checkout", "--", "src/value.ts"]);
    const manager = new GitWorkspaceManager({ workspaceRoot: join(root, "seed-workspaces") });
    const workspace = manager.create({ runId: "hardening-child", repositoryRoot: repository.path, baseCommitSha: repository.sha });

    const result = manager.materializeVerifiedSeed(workspace, {
      baseCommitSha: repository.sha,
      seedResultCommitSha: repository.sha,
      finalDiff,
      diffHash: sha256(finalDiff),
    });

    expect(result.headCommitSha).toBe(repository.sha);
    expect(result.diff).toBe(finalDiff);
    expect(result.diffHash).toBe(sha256(finalDiff));
    expect(readFileSync(join(workspace.workspaceRoot, "src", "value.ts"), "utf8")).toBe("export const value = 2;\n");
    manager.remove(workspace);
  });

  test("rejects changed or non-materializable verified seed authority", () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const manager = new GitWorkspaceManager({ workspaceRoot: join(root, "tamper-workspaces") });
    const workspace = manager.create({ runId: "hardening-tamper", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const finalDiff = "diff --git a/src/missing.ts b/src/missing.ts\ninvalid";

    expect(() => manager.materializeVerifiedSeed(workspace, {
      baseCommitSha: repository.sha,
      seedResultCommitSha: repository.sha,
      finalDiff,
      diffHash: sha256("different"),
    })).toThrow("seed source diff hash mismatch");
    expect(() => manager.materializeVerifiedSeed(workspace, {
      baseCommitSha: repository.sha,
      seedResultCommitSha: repository.sha,
      finalDiff,
      diffHash: sha256(finalDiff),
    })).toThrow("verified seed diff could not be materialized");
    manager.remove(workspace);
  });
});

describe("optional hardening verified seed sandbox", () => {
  test("uses a fresh cold sandbox, persists only after commit, and exactly reconstructs on replay", async () => {
    const root=temporaryRoot();const repository=initRepository(root,true);const {workspace,sandbox}=records(repository.path,"hardening-seed",repository.sha);
    const environmentDigest=sandbox.environmentDigest;let provisions=0,recoveries=0,destroys=0,recordsWritten=0;let durableArtifact:ReturnType<LocalArtifactStore["put"]>|null=null;
    const artifactStore=new LocalArtifactStore({root:join(root,"artifacts")});
    const sandboxManager={provisionColdAsync:async()=>{provisions+=1;return {workspace,record:sandbox};},
      recoverAsync:async()=>{recoveries+=1;return {workspace,record:sandbox};},
      workspaceManager:()=>({materializeVerifiedSeed:()=>({headCommitSha:repository.sha,treeHash:sha256("tree"),diffHash:sha256(""),diff:""}),
        verifyMaterializedSeed:()=>({headCommitSha:repository.sha,treeHash:sha256("tree"),diffHash:sha256(""),diff:""})}),
      destroyAsync:async()=>{destroys+=1;}};
    const sandboxRow={id:sandbox.sandboxId,run_id:sandbox.runId,workspace_identity:sandbox.workspaceIdentity,image_digest:sandbox.imageDigest,
      environment_digest:sandbox.environmentDigest,status:sandbox.status,created_at:sandbox.createdAt,destroyed_at:sandbox.destroyedAt};
    const supervisor={getRun:()=>({manifestHash:sha256("manifest")}),recordSandboxWithCheckpoint:(_record:unknown,artifact:typeof durableArtifact)=>{recordsWritten+=1;durableArtifact=artifact;},
      exportRunRecords:()=>({sandboxes:recordsWritten?[sandboxRow]:[]}),listArtifacts:()=>durableArtifact?[durableArtifact]:[]};
    const manager=new EngineerExecutionManager({supervisor:supervisor as never,sandboxManager:sandboxManager as never,
      artifactStore,repositoryRootFor:()=>repository.path,
      transportForRun:async()=>({create:async()=>({id:"unused",output:[]})})});
    const signer:CheckpointAttestor={algorithm:"test",keyId:"seed-test",sign:(payload)=>`test:${sha256(payload)}`,
      verify:(payload,signature)=>signature===`test:${sha256(payload)}`};
    const preparation={replay:false,operation:{operationId:sha256("operation-id"),operationHash:sha256("operation"),childRunId:"hardening-seed",
      requesterUserId:"owner",expectedChildStateVersion:0,lineageId:sha256("lineage-id"),lineageHash:sha256("lineage"),idempotencyKey:"start",createdAt:"2026-07-18T12:00:00.000Z"},
      lineage:{rootRunId:"parent",parentRunId:"parent",childRunId:"hardening-seed",requesterUserId:"owner",repositoryId:"repo-1",
        lineageId:sha256("lineage-id"),lineageHash:sha256("lineage")},parentCheckpoint:{checkpointId:sha256("checkpoint-id"),checkpointHash:sha256("checkpoint")},
      seed:{baseCommitSha:repository.sha,seedResultCommitSha:repository.sha,finalDiff:"",diffHash:sha256(""),environmentDigest},signedSeed:null} as unknown as OptionalHardeningStartPreparation;

    const signed=await manager.materializeOptionalHardeningSeed(preparation,signer);
    expect({provisions,destroys,recordsWritten}).toEqual({provisions:1,destroys:0,recordsWritten:0});
    const durable=manager.prepareOptionalHardeningSeedCommit("hardening-seed",sha256("manifest"));
    supervisor.recordSandboxWithCheckpoint(durable.sandbox,durable.checkpoint);manager.completeOptionalHardeningSeedCommit("hardening-seed");
    expect(recordsWritten).toBe(1);
    const durableCheckpoint=JSON.parse(artifactStore.read(durableArtifact!).toString("utf8"));
    expect(durableCheckpoint).toMatchObject({checkpointVersion:2,runId:"hardening-seed",
      hardeningLineageId:preparation.lineage.lineageId,hardeningLineageHash:preparation.lineage.lineageHash,
      seedAttestationId:signed.attestation.seedAttestationId,seedAttestationHash:signed.attestation.seedAttestationHash});

    const replayManager=new EngineerExecutionManager({supervisor:supervisor as never,sandboxManager:sandboxManager as never,
      artifactStore,repositoryRootFor:()=>repository.path,
      transportForRun:async()=>({create:async()=>({id:"unused",output:[]})})});
    expect(await replayManager.recoverOptionalHardeningSeed({...preparation,replay:true,signedSeed:signed})).toBe(true);
    expect({provisions,recoveries,recordsWritten,destroys}).toEqual({provisions:1,recoveries:1,recordsWritten:1,destroys:0});

    const missingRowManager=new EngineerExecutionManager({supervisor:{...supervisor,exportRunRecords:()=>({sandboxes:[]})} as never,
      sandboxManager:sandboxManager as never,artifactStore,repositoryRootFor:()=>repository.path,
      transportForRun:async()=>({create:async()=>({id:"unused",output:[]})})});
    await expect(missingRowManager.recoverOptionalHardeningSeed({...preparation,replay:true,signedSeed:signed}))
      .rejects.toThrow("exactly one durable sandbox checkpoint");

    const v1Content={checkpointVersion:1 as const,runId:"hardening-seed",manifestHash:sha256("manifest"),workspace,sandbox,
      createdAt:"2026-07-18T12:01:00.000Z"};
    const v1Artifact=artifactStore.put({runId:"hardening-seed",type:"SANDBOX_WORKSPACE_CHECKPOINT",
      bytes:JSON.stringify({...v1Content,checkpointHash:sha256(v1Content)}),producerType:"SYSTEM",producerId:"legacy",trusted:true});
    const legacyCheckpointManager=new EngineerExecutionManager({supervisor:{...supervisor,listArtifacts:()=>[v1Artifact]} as never,
      sandboxManager:sandboxManager as never,artifactStore,repositoryRootFor:()=>repository.path,
      transportForRun:async()=>({create:async()=>({id:"unused",output:[]})})});
    await expect(legacyCheckpointManager.recoverOptionalHardeningSeed({...preparation,replay:true,signedSeed:signed}))
      .rejects.toThrow("exactly one durable v2 seed checkpoint");

    const staleRowManager=new EngineerExecutionManager({supervisor:{...supervisor,
      exportRunRecords:()=>({sandboxes:[{...sandboxRow,status:"DESTROYED",destroyed_at:"2026-07-18T12:02:00.000Z"}]})} as never,
      sandboxManager:sandboxManager as never,artifactStore,repositoryRootFor:()=>repository.path,
      transportForRun:async()=>({create:async()=>({id:"unused",output:[]})})});
    await expect(staleRowManager.recoverOptionalHardeningSeed({...preparation,replay:true,signedSeed:signed}))
      .rejects.toThrow("projection is invalid");
    expect({provisions,recoveries}).toEqual({provisions:1,recoveries:1});
  });

  test("destroys a cold sandbox before persistence when seed environment authority differs", async () => {
    const root=temporaryRoot();const repository=initRepository(root);const {workspace,sandbox}=records(repository.path,"hardening-bad-seed",repository.sha);
    let destroyed=0,recorded=0;const manager=new EngineerExecutionManager({supervisor:{recordSandbox:()=>{recorded+=1;}} as never,
      sandboxManager:{provisionColdAsync:async()=>({workspace,record:sandbox}),workspaceManager:()=>({}),destroyAsync:async()=>{destroyed+=1;}} as never,
      artifactStore:new LocalArtifactStore({root:join(root,"artifacts")}),repositoryRootFor:()=>repository.path,
      transportForRun:async()=>({create:async()=>({id:"unused",output:[]})})});
    const preparation={replay:false,operation:{childRunId:"hardening-bad-seed"},lineage:{},parentCheckpoint:{},
      seed:{baseCommitSha:repository.sha,seedResultCommitSha:repository.sha,finalDiff:"",diffHash:sha256(""),environmentDigest:sha256("wrong")},signedSeed:null} as unknown as OptionalHardeningStartPreparation;
    await expect(manager.materializeOptionalHardeningSeed(preparation,{algorithm:"test",keyId:"test",sign:()=>"x",verify:()=>true})).rejects.toThrow("environment differs");
    expect({destroyed,recorded}).toEqual({destroyed:1,recorded:0});
  });

  test("prepares signed restart authority read-only and activates exact lease generations without provider calls",async()=>{
    const root=temporaryRoot(),repository=initRepository(root,true),runId="hardening-stage-recovery";
    const {workspace,sandbox}=records(repository.path,runId,repository.sha),hardeningManifest=manifest(runId,repository.sha),
      manifestHash=hardeningManifest.manifestHash;
    const artifactStore=new LocalArtifactStore({root:join(root,"stage-artifacts")});
    const artifacts:ReturnType<LocalArtifactStore["put"]>[]=[];let sandboxRows:Record<string,unknown>[]=[],
      runRecords:Record<string,Array<Record<string,unknown>>>={},events:Array<Record<string,unknown>>=[],classifiedReview:unknown=null;
    let recoveries=0,destroys=0,providerCalls=0,resetToHead:unknown=null,invalidWorkspace=false,
      loseAuthorityOnRecover=false,authorityLost=false;
    const run={runId,state:"PLAN_FROZEN",stateVersion:4,manifestHash};let claim:Record<string,unknown>|null=null;
    const sandboxManager={
      provisionColdAsync:async()=>({workspace,record:sandbox}),
      recoverAsync:async(input:{resetToHead:boolean})=>{recoveries+=1;resetToHead=input.resetToHead;
        if(loseAuthorityOnRecover)authorityLost=true;return {workspace,record:sandbox};},
      workspaceManager:()=>({
        materializeVerifiedSeed:()=>({headCommitSha:repository.sha,treeHash:sha256("stage-tree"),diffHash:sha256(""),diff:""}),
        verifyMaterializedSeed:()=>({headCommitSha:repository.sha,treeHash:invalidWorkspace?sha256("wrong-tree"):sha256("stage-tree"),
          diffHash:sha256(""),diff:""}),
      }),
      destroyAsync:async()=>{destroys+=1;},
    };
    const supervisor={
      isOptionalHardeningChild:()=>true,getRun:()=>run,getManifest:()=>hardeningManifest,latestRiskAssessment:()=>null,
      getFinalizedOptionalHardeningStartClaim:()=>claim,exportRunRecords:()=>({sandboxes:sandboxRows,...runRecords,
        artifacts:artifacts.map((artifact)=>({id:artifact.artifactId,run_id:artifact.runId,type:artifact.type,sha256:artifact.sha256,
          storage_reference:artifact.storageReference,size_bytes:artifact.sizeBytes,producer_type:artifact.producerType,
          producer_id:artifact.producerId,trusted:artifact.trusted?1:0,created_at:artifact.createdAt}))}),
      listArtifacts:()=>[...artifacts],listEvents:()=>events,latestClassifiedReview:()=>classifiedReview,
      hasExactHardeningReviewerSuccessor:()=>true,
      recordArtifact:(artifact:typeof artifacts[number])=>{artifacts.push(artifact);return artifact;},
      recordSandboxWithCheckpoint:(_record:unknown,artifact:typeof artifacts[number])=>{
        sandboxRows=[{id:sandbox.sandboxId,run_id:runId,workspace_identity:sandbox.workspaceIdentity,image_digest:sandbox.imageDigest,
          environment_digest:sandbox.environmentDigest,status:sandbox.status,created_at:sandbox.createdAt,destroyed_at:sandbox.destroyedAt}];
        artifacts.push(artifact);
      },
    };
    const signer:CheckpointAttestor={algorithm:"test",keyId:"stage-recovery",sign:(payload)=>`test:${sha256(payload)}`,
      verify:(payload,signature)=>signature===`test:${sha256(payload)}`};
    const basePreparation={replay:false,operation:{operationId:sha256("stage-operation-id"),operationHash:sha256("stage-operation"),
      childRunId:runId,requesterUserId:"owner",expectedChildStateVersion:0,lineageId:sha256("stage-lineage-id"),
      lineageHash:sha256("stage-lineage"),idempotencyKey:"stage-start",createdAt:"2026-07-18T12:00:00.000Z"},
      lineage:{rootRunId:"parent",parentRunId:"parent",childRunId:runId,requesterUserId:"owner",repositoryId:"repo-1",
        lineageId:sha256("stage-lineage-id"),lineageHash:sha256("stage-lineage")},
      parentCheckpoint:{checkpointId:sha256("stage-parent-id"),checkpointHash:sha256("stage-parent")},
      seed:{baseCommitSha:repository.sha,seedResultCommitSha:repository.sha,finalDiff:"",diffHash:sha256(""),
        environmentDigest:sandbox.environmentDigest},signedSeed:null} as unknown as OptionalHardeningStartPreparation;
    const initial=new EngineerExecutionManager({supervisor:supervisor as never,sandboxManager:sandboxManager as never,artifactStore,
      repositoryRootFor:()=>repository.path,hardeningPromptCacheSecret:"0123456789abcdef0123456789abcdef",
      transportForRun:async()=>{providerCalls+=1;return {create:async()=>({id:"forbidden",output:[]})};}});
    const signed=await initial.materializeOptionalHardeningSeed(basePreparation,signer),durable=initial.prepareOptionalHardeningSeedCommit(runId,manifestHash);
    supervisor.recordSandboxWithCheckpoint(durable.sandbox,durable.checkpoint);initial.completeOptionalHardeningSeedCommit(runId);
    claim={claimId:sha256("stage-claim"),status:"FINALIZED",sandboxId:sandbox.sandboxId,
      finalizedOperationId:basePreparation.operation.operationId,finalizedOperationHash:basePreparation.operation.operationHash,
      seedAttestationId:signed.attestation.seedAttestationId,seedAttestationHash:signed.attestation.seedAttestationHash};
    const preparation={...basePreparation,replay:true,signedSeed:signed} as OptionalHardeningStartPreparation;
    const recovery=new EngineerExecutionManager({supervisor:supervisor as never,sandboxManager:sandboxManager as never,artifactStore,
      repositoryRootFor:()=>repository.path,hardeningPromptCacheSecret:"0123456789abcdef0123456789abcdef",
      transportForRun:async()=>{providerCalls+=1;return {create:async()=>({id:"forbidden",output:[]})};}});

    const beforeArtifacts=artifacts.length,snapshot=recovery.prepareOptionalHardeningWorkspaceRecovery(preparation);
    expect(snapshot).toMatchObject({runId,state:"PLAN_FROZEN",stateVersion:4,stage:{kind:"SEED"}});
    expect({recoveries,destroys,providerCalls,artifactWrites:artifacts.length-beforeArtifacts}).toEqual({recoveries:0,destroys:0,providerCalls:0,artifactWrites:0});
    const lease1={leaseId:"lease-stage-1",ownerId:"worker-stage",fencingToken:1};
    await recovery.activateOptionalHardeningWorkspaceRecovery(snapshot,()=>undefined,()=>lease1);
    expect({recoveries,destroys,providerCalls,resetToHead}).toEqual({recoveries:1,destroys:0,providerCalls:0,resetToHead:false});
    expect(artifacts.filter((item)=>item.type==="SANDBOX_RECOVERY_ATTESTATION")).toHaveLength(1);
    await recovery.activateOptionalHardeningWorkspaceRecovery(snapshot,()=>undefined,()=>lease1);
    expect(artifacts.filter((item)=>item.type==="SANDBOX_RECOVERY_ATTESTATION")).toHaveLength(1);
    await recovery.activateOptionalHardeningWorkspaceRecovery(snapshot,()=>undefined,
      ()=>({leaseId:"lease-stage-2",ownerId:"worker-stage",fencingToken:2}));
    expect(artifacts.filter((item)=>item.type==="SANDBOX_RECOVERY_ATTESTATION")).toHaveLength(2);

    const validAttestation=artifacts.find((item)=>item.type==="SANDBOX_RECOVERY_ATTESTATION")!;
    const malformedAttestation=artifactStore.put({runId,type:"SANDBOX_RECOVERY_ATTESTATION",
      bytes:JSON.stringify({...JSON.parse(artifactStore.read(validAttestation).toString("utf8")),state:"FAILED"}),
      producerType:"SYSTEM",producerId:"engineer-hardening-recovery",trusted:true});
    artifacts.push(malformedAttestation);const malformed=new EngineerExecutionManager({supervisor:supervisor as never,
      sandboxManager:sandboxManager as never,artifactStore,repositoryRootFor:()=>repository.path,
      hardeningPromptCacheSecret:"0123456789abcdef0123456789abcdef",transportForRun:async()=>{providerCalls+=1;return {} as never;}});
    const malformedSnapshot=malformed.prepareOptionalHardeningWorkspaceRecovery(preparation),destroysBeforeMalformed=destroys;
    await expect(malformed.activateOptionalHardeningWorkspaceRecovery(malformedSnapshot,()=>undefined,
      ()=>({leaseId:"lease-stage-malformed",ownerId:"worker-stage",fencingToken:3})))
      .rejects.toBeInstanceOf(HardeningGenericOperationForbiddenError);
    expect(destroys).toBe(destroysBeforeMalformed+1);artifacts.splice(artifacts.indexOf(malformedAttestation),1);

    const raced=new EngineerExecutionManager({supervisor:supervisor as never,sandboxManager:sandboxManager as never,artifactStore,
      repositoryRootFor:()=>repository.path,hardeningPromptCacheSecret:"0123456789abcdef0123456789abcdef",transportForRun:async()=>{providerCalls+=1;return {} as never;}});
    const stale=raced.prepareOptionalHardeningWorkspaceRecovery(preparation),recoveriesBeforeRace=recoveries;run.stateVersion+=1;
    await expect(raced.activateOptionalHardeningWorkspaceRecovery(stale,()=>undefined,()=>lease1))
      .rejects.toBeInstanceOf(HardeningGenericOperationForbiddenError);
    expect(recoveries).toBe(recoveriesBeforeRace);run.stateVersion-=1;

    loseAuthorityOnRecover=true;const lostAuthority=new EngineerExecutionManager({supervisor:supervisor as never,
      sandboxManager:sandboxManager as never,artifactStore,repositoryRootFor:()=>repository.path,
      hardeningPromptCacheSecret:"0123456789abcdef0123456789abcdef",transportForRun:async()=>{providerCalls+=1;return {} as never;}});
    const lostSnapshot=lostAuthority.prepareOptionalHardeningWorkspaceRecovery(preparation),destroysBeforeLoss=destroys;
    await expect(lostAuthority.activateOptionalHardeningWorkspaceRecovery(lostSnapshot,
      ()=>{if(authorityLost)throw new Error("lease replaced");},()=>lease1)).rejects.toThrow("lease replaced");
    expect(destroys).toBe(destroysBeforeLoss);loseAuthorityOnRecover=false;authorityLost=false;

    invalidWorkspace=true;const invalid=new EngineerExecutionManager({supervisor:supervisor as never,sandboxManager:sandboxManager as never,
      artifactStore,repositoryRootFor:()=>repository.path,hardeningPromptCacheSecret:"0123456789abcdef0123456789abcdef",
      transportForRun:async()=>{providerCalls+=1;return {} as never;}});
    const invalidSnapshot=invalid.prepareOptionalHardeningWorkspaceRecovery(preparation);
    await expect(invalid.activateOptionalHardeningWorkspaceRecovery(invalidSnapshot,()=>undefined,
      ()=>({leaseId:"lease-stage-3",ownerId:"worker-stage",fencingToken:3})))
      .rejects.toBeInstanceOf(HardeningGenericOperationForbiddenError);
    expect({destroys,providerCalls}).toEqual({destroys:2,providerCalls:0});

    invalidWorkspace=false;run.state="REVIEWING";run.stateVersion=11;
    const finalDiff=artifactStore.put({runId,type:"FINAL_DIFF",bytes:"",producerType:"SYSTEM",
      producerId:"engineer-verification",trusted:true});artifacts.push(finalDiff);
    const securityReport=artifactStore.put({runId,type:"SECURITY_REPORT",bytes:"{}",producerType:"SYSTEM",
      producerId:"engineer-independent-verifier",trusted:true});artifacts.push(securityReport);
    const selectedEvent={eventId:"event-before-checkpoint",runId,sequence:10,stateVersion:10,
      previousState:"FAST_CHECKS",nextState:"SECURITY_REVIEW",reasonCode:"ENTER_SECURITY_REVIEW",evidenceIds:[],
      actorType:"SUPERVISOR",actorId:"engineer-supervisor",manifestHash,idempotencyKey:"phase3:security_review:10",
      timestamp:"2026-07-18T12:10:00.000Z"};
    const checkpointContent={version:2 as const,runId,manifestHash,diffHash:sha256(""),resultCommitSha:repository.sha,
      diffArtifactId:finalDiff.artifactId,diffArtifactHash:finalDiff.sha256,selectedEventId:selectedEvent.eventId,
      selectedEventSequence:selectedEvent.sequence,selectedEventStateVersion:selectedEvent.stateVersion,
      selectedEventState:selectedEvent.nextState,selectedEventReasonCode:selectedEvent.reasonCode,
      selectedEventEvidenceHash:sha256(selectedEvent.evidenceIds),selectedEventHash:sha256(selectedEvent),
      verified:{executions:[],securityFindings:[],trustedEvidence:[],
        securityReportArtifact:projectHardeningArtifactAuthority(securityReport)}};
    const checkpointPayload={...checkpointContent,checkpointHash:sha256(checkpointContent)};
    const independentCheckpoint=artifactStore.put({runId,type:"INDEPENDENT_VERIFICATION_CHECKPOINT",
      bytes:canonicalJson(checkpointPayload),producerType:"SYSTEM",producerId:"engineer-verification",trusted:true,
      createdAt:"2026-07-18T12:10:00.000Z"});
    artifacts.push(independentCheckpoint);events=[selectedEvent];run.state="SECURITY_REVIEW";run.stateVersion=10;
    runRecords={};classifiedReview=null;
    const r0Manager=new EngineerExecutionManager({supervisor:supervisor as never,sandboxManager:sandboxManager as never,artifactStore,
      repositoryRootFor:()=>repository.path,hardeningPromptCacheSecret:"0123456789abcdef0123456789abcdef",transportForRun:async()=>{providerCalls+=1;return {} as never;}});
    const checkpointIndex=artifacts.indexOf(independentCheckpoint),noncanonicalCheckpoint=artifactStore.put({runId,
      type:"INDEPENDENT_VERIFICATION_CHECKPOINT",bytes:JSON.stringify(checkpointPayload),producerType:"SYSTEM",
      producerId:"engineer-verification",trusted:true,createdAt:"2026-07-18T12:10:00.000Z"});artifacts.splice(checkpointIndex,1,noncanonicalCheckpoint);
    expect(()=>r0Manager.prepareOptionalHardeningWorkspaceRecovery(preparation))
      .toThrow(HardeningGenericOperationForbiddenError);expect(providerCalls).toBe(0);
    artifacts.splice(checkpointIndex,1,independentCheckpoint);
    const r0=r0Manager.prepareOptionalHardeningWorkspaceRecovery(preparation);
    expect(r0.stage).toMatchObject({kind:"INDEPENDENT",classified:null});expect(providerCalls).toBe(0);

    const reviewerInputContent={reviewSessionId:"reviewer-session",runId,reviewAttempt:1,manifest:hardeningManifest,
      manifestHash,finalDiff:"",diffHash:sha256(""),trustedEvidence:[],riskAssessment:null,
      resultCommitSha:repository.sha,reviewPolicyVersion:"engineer-isolated-reviewer-v6",
      createdAt:"2026-07-18T12:10:00.004Z"};
    const reviewerInput=ReviewerInputSchema.parse({...reviewerInputContent,
      evidenceBundleHash:reviewerEvidenceBundleHash(reviewerInputContent)});
    const semanticProjection={riskTier:"MEDIUM" as const,humanGateRequired:true},semanticContent={
      policyVersion:"engineer-hardening-review-semantic-authority-v1" as const,
      ledgerSets:["agent_executions","audit_events","command_executions","engineer_run_lineage","git_operations",
        "hardening_start_operations","required_lane_contracts","risk_assessments","security_findings",
        "task_manifest_versions","test_executions"].map((table)=>({table,rows:[],
          setHash:sha256([])})),
      artifacts:[],artifactSetHash:sha256([]),runRiskProjection:{...semanticProjection,
        projectionHash:sha256(semanticProjection)}},semanticAuthority={...semanticContent,
          authorityHash:sha256(semanticContent)};
    const authorityContent={version:2 as const,policyVersion:"engineer-hardening-review-input-authority-v2" as const,
      runId,manifestHash,diffHash:sha256(""),resultCommitSha:repository.sha,
      checkpointArtifactId:independentCheckpoint.artifactId,checkpointArtifactHash:independentCheckpoint.sha256,
      checkpointHash:checkpointPayload.checkpointHash,reviewerInput,evidenceAuthority:[],evidenceAuthorityHash:sha256([]),
      semanticAuthority,requestAuthority:buildIsolatedReviewerRequestPlan(reviewerInput,{hardeningPromptCacheIdentity:{
        secret:"0123456789abcdef0123456789abcdef",requesterUserId:"owner",childRunId:runId}}).authority};
    const reviewInputAuthority=artifactStore.put({runId,type:"HARDENING_REVIEW_INPUT_AUTHORITY",
      bytes:canonicalJson({...authorityContent,authorityHash:sha256(authorityContent)}),producerType:"SYSTEM",
      producerId:"engineer-verification",trusted:true,createdAt:"2026-07-18T12:10:00.004Z"});artifacts.push(reviewInputAuthority);
    const completionKey=hardeningCheckpointMilestoneKey({kind:"COMPLETED",runId,artifactId:independentCheckpoint.artifactId,
      artifactHash:independentCheckpoint.sha256,checkpointHash:checkpointPayload.checkpointHash,selectedEventId:selectedEvent.eventId,
      selectedEventSequence:selectedEvent.sequence,selectedEventStateVersion:selectedEvent.stateVersion,
      selectedEventHash:checkpointContent.selectedEventHash});
    events=[selectedEvent,{eventId:"event-review-ready",runId,sequence:11,stateVersion:11,
      previousState:"SECURITY_REVIEW",nextState:"REVIEWING",reasonCode:"INDEPENDENT_VERIFICATION_COMPLETE",
      evidenceIds:[independentCheckpoint.artifactId,independentCheckpoint.sha256,checkpointPayload.checkpointHash,
        reviewInputAuthority.artifactId,reviewInputAuthority.sha256],actorType:"SUPERVISOR",
      actorId:"engineer-supervisor",manifestHash,idempotencyKey:completionKey,timestamp:"2026-07-18T12:10:00.005Z"}];
    run.state="REVIEWING";run.stateVersion=11;
    const completedEvents=events,authorityIndex=artifacts.indexOf(reviewInputAuthority);artifacts.splice(authorityIndex,1);
    expect(()=>r0Manager.prepareOptionalHardeningWorkspaceRecovery(preparation))
      .toThrow(HardeningGenericOperationForbiddenError);expect(providerCalls).toBe(0);artifacts.push(reviewInputAuthority);
    events=[selectedEvent];run.state="SECURITY_REVIEW";run.stateVersion=10;
    expect(()=>r0Manager.prepareOptionalHardeningWorkspaceRecovery(preparation))
      .toThrow(HardeningGenericOperationForbiddenError);expect(providerCalls).toBe(0);
    events=completedEvents;run.state="REVIEWING";run.stateVersion=11;
    runRecords={agent_executions:[{id:"partial-reviewer",run_id:runId,role:"REVIEWER",status:"RUNNING"}]};
    expect(()=>r0Manager.prepareOptionalHardeningWorkspaceRecovery(preparation))
      .toThrow(HardeningGenericOperationForbiddenError);expect(providerCalls).toBe(0);runRecords={};

    const reviewerAgentId="reviewer-agent",reviewerSessionId="reviewer-session",reservationId="reviewer-reservation",
      finalizationId="reviewer-finalization",classificationHash=sha256("review-classification"),
      reviewCompletedAt="2026-07-18T12:12:00.000Z",reviewOutput=artifactStore.put({runId,type:"REVIEWER_OUTPUT",
        bytes:"{}",producerType:"SYSTEM",producerId:reviewerAgentId,trusted:false}),
      rawOutput=artifactStore.put({runId,type:"REVIEWER_RAW_OUTPUT",bytes:"{}",producerType:"SYSTEM",
        producerId:reviewerSessionId,trusted:true}),providerOutput=artifactStore.put({runId,type:"MODEL_PROVIDER_RESPONSE",
        bytes:"{}",producerType:"SYSTEM",producerId:"engineer-provider-response-recorder",trusted:true});
    artifacts.push(reviewOutput,rawOutput,providerOutput);
    const session={reviewerSessionId,runId,attempt:1,modelTier:"GPT-5.6_SOL",resolvedModel:"gpt-5.6",
      inputHash:sha256("review-input"),manifestHash,diffHash:sha256(""),evidenceBundleHash:sha256("review-evidence"),
      policyVersion:"engineer-isolated-reviewer-v6",cacheKey:sha256("review-cache"),cacheHit:false,
      startedAt:"2026-07-18T12:11:30.000Z",completedAt:reviewCompletedAt,decision:"READY",isolationVerified:true,output:{}};
    const classification={runId,manifestHash,classificationHash,contractHash:sha256("review-contract"),policyVersion:"review-policy",
      createdAt:reviewCompletedAt,result:"READY",normalizedOutputHash:sha256("normalized-review"),classifications:[],
      rawOutput:{artifactId:rawOutput.artifactId,sha256:rawOutput.sha256,byteLength:rawOutput.sizeBytes,mediaType:"application/json"}};
    classifiedReview={session,classification,findings:[],reviewerInput};
    runRecords={
      agent_executions:[{id:reviewerAgentId,run_id:runId,role:"REVIEWER",status:"SUCCEEDED",output_artifact_id:reviewOutput.artifactId}],
      hardening_child_model_reservations:[{id:reservationId,child_run_id:runId,agent_execution_id:reviewerAgentId,role:"REVIEWER",
        status:"SETTLED",provider_response_artifact_id:providerOutput.artifactId}],
      hardening_paid_call_finalizations:[{id:finalizationId,child_run_id:runId,agent_execution_id:reviewerAgentId,role:"REVIEWER",
        reservation_id:reservationId,status:"APPLIED"}],
      model_routing_decisions:[{id:"review-route",agent_execution_id:reviewerAgentId,agent_role:"REVIEWER"}],
      hardening_model_call_slots:[{id:"review-slot",child_run_id:runId,role:"REVIEWER"}],
      model_calls:[{id:"review-call",agent_execution_id:reviewerAgentId}],
      reviewer_sessions:[{id:reviewerSessionId}],
      review_classification_batches:[{classification_hash:classificationHash,raw_output_artifact_id:rawOutput.artifactId}],
      review_findings:[],review_finding_classifications:[],claim_evidence:[],evidence_bundles:[],
      audit_events:[{id:"classification-audit",run_id:runId,action:"REVIEW_CLASSIFICATION_RECORDED",actor_type:"SYSTEM",
        actor_id:classification.policyVersion,created_at:classification.createdAt,details_json:JSON.stringify({reviewerSessionId,
          contractHash:classification.contractHash,classificationHash,rawOutputArtifactId:rawOutput.artifactId,
          rawOutputHash:rawOutput.sha256,normalizedOutputHash:classification.normalizedOutputHash,result:classification.result})}],
    };
    const r2=r0Manager.prepareOptionalHardeningWorkspaceRecovery(preparation);
    expect(r2.stage).toMatchObject({kind:"INDEPENDENT",classified:{reviewerSessionId,classificationHash,
      agentExecutionId:reviewerAgentId,reservationId,finalizationId}});expect(providerCalls).toBe(0);
    const sameIdBefore=r2.authorityHash;(runRecords.reviewer_sessions![0] as Record<string,unknown>).decision="BLOCKED";
    const sameIdAfter=r0Manager.prepareOptionalHardeningWorkspaceRecovery(preparation).authorityHash;
    expect(sameIdAfter).not.toBe(sameIdBefore);expect(()=>r0Manager.assertOptionalHardeningRecoveryAuthority(r2))
      .toThrow(HardeningGenericOperationForbiddenError);
    delete (runRecords.reviewer_sessions![0] as Record<string,unknown>).decision;
    const extraRaw=artifactStore.put({runId,type:"REVIEWER_RAW_OUTPUT",bytes:"{\"extra\":true}",producerType:"SYSTEM",
      producerId:"extra-session",trusted:true});artifacts.push(extraRaw);
    expect(()=>r0Manager.prepareOptionalHardeningWorkspaceRecovery(preparation))
      .toThrow(HardeningGenericOperationForbiddenError);artifacts.splice(artifacts.indexOf(extraRaw),1);
    expect(providerCalls).toBe(0);
  });
});

describe("Phase 2 manifest file boundary", () => {
  test("honors allowed and denied globs and permanently blocks .git", () => {
    const task = manifest("run-1", "1".repeat(40), { deniedPaths: ["src/private/**"] });
    expect(isManifestPathAllowed("src/value.ts", task)).toBe(true);
    expect(isManifestPathAllowed("src/private/key.ts", task)).toBe(false);
    expect(() => isManifestPathAllowed(".git/config", task)).toThrow(".git");
  });

  test("keeps explicit deny rules authoritative over broad allow rules", () => {
    const task = manifest("run-1", "1".repeat(40), {
      allowedPaths: ["src/**"],
      deniedPaths: ["src/private/**"],
    });
    expect(isManifestPathAllowed("src/public/value.ts", task)).toBe(true);
    expect(isManifestPathAllowed("src/private/key.ts", task)).toBe(false);
  });

  test("rejects a symlink even when its apparent path is allowed", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "src"));
    symlinkSync("/tmp", join(root, "src", "escape"));
    expect(() => resolveManifestPath(root, "src/escape", manifest("run-1", "1".repeat(40)))).toThrow("symlinks");
  });

  test("rejects a write parent whose canonical path only shares the root prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "engineer-root-"));
    const sibling = `${root}-sibling`;
    mkdirSync(sibling, { recursive: true });
    mkdirSync(join(root, "src"));
    symlinkSync(sibling, join(root, "src", "linked"));
    const task = manifest("run-prefix", "1".repeat(40), { allowedPaths: ["src/**"] });
    expect(() => resolveManifestPath(root, "src/linked/new.txt", task, true)).toThrow("write parent resolved outside workspace root");
  });
});

describe("Phase 2 trusted executor", () => {
  test("runs an exact manifest command without a shell and captures trusted artifacts", () => {
    const root = temporaryRoot();
    const { workspace, sandbox } = records(root, "run-1", "1".repeat(40));
    let invocation: unknown[] = [];
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      workspace, sandbox, manifest: manifest("run-1", "1".repeat(40)), currentCommit: () => "1".repeat(40),
      runner(executable, args, options) {
        invocation = [executable, args, options.cwd, options.env.TMPDIR];
        return { status: 0, stdout: "1 pass", stderr: "" };
      },
    });
    const result = executor.execute("bun run test", "command-1");
    expect(invocation).toEqual(["bun", ["run", "test"], root, "/tmp"]);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.environmentDigest).toBe(sandbox.environmentDigest);
    expect(readFileSync(result.stdoutArtifact.storageReference, "utf8")).toBe("1 pass");
    expect(executor.execute("bun run test", "command-1")).toEqual(result);
  });

  test("uses the ledger's canonical artifact identities in returned and replayed command evidence", () => {
    const root = temporaryRoot();
    const { workspace, sandbox } = records(root, "run-1", "1".repeat(40));
    const canonicalStdoutId = randomUUID();
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      workspace,
      sandbox,
      manifest: manifest("run-1", "1".repeat(40)),
      currentCommit: () => "1".repeat(40),
      runner: () => ({ status: 0, stdout: "shared output", stderr: "" }),
      onRecord: (record) => ({
        ...record,
        // This models content-addressed ledger deduplication of identical
        // command stdout across distinct verification commands.
        stdoutArtifact: { ...record.stdoutArtifact, artifactId: canonicalStdoutId },
      }),
    });

    const first = executor.execute("bun run test", "command-1");
    const replay = executor.execute("bun run test", "command-1");

    expect(first.stdoutArtifact.artifactId).toBe(canonicalStdoutId);
    expect(replay).toEqual(first);
  });

  test("rejects shell injection before invoking a runner", () => {
    const root = temporaryRoot();
    const { workspace, sandbox } = records(root, "run-1", "1".repeat(40));
    let invoked = false;
    const task = manifest("run-1", "1".repeat(40), { allowedCommands: ["bun run test && rm -rf ."] });
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), workspace, sandbox, manifest: task,
      currentCommit: () => "1".repeat(40), runner: () => { invoked = true; return { status: 0, stdout: "", stderr: "" }; },
    });
    expect(() => executor.execute("bun run test && rm -rf .", "command-1")).toThrow("metacharacters");
    expect(invoked).toBe(false);
  });
});

describe("Phase 2 Docker sandbox", () => {
  test("pins the image and wraps commands in a hardened offline container", () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn });
    const digest = `sha256:${"a".repeat(64)}`;
    const calls: string[][] = [];
    const dockerSpawn = ((executable: string, args: string[]) => {
      calls.push([executable, ...args]);
      if (args[0] === "info") return { status: 0, stdout: "27", stderr: "" };
      if (args[0] === "image") return { status: 0, stdout: `[\"oven/bun@${digest}\"]`, stderr: "" };
      return { status: 0, stdout: "ok", stderr: "" };
    }) as typeof import("node:child_process").spawnSync;
    const manager = new DockerSandboxManager({
      workspaceManager, imageReference: `oven/bun@${digest}`, imageDigest: digest, dockerSpawn,
    });
    const sandbox = manager.provision({ runId: "run-1", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    sandbox.commandRunner("bun", ["run", "test"], {
      cwd: sandbox.workspace.workspaceRoot, timeoutMs: 1_000, maxOutputBytes: 1_000, env: { PATH: "/bin" },
    });
    const run = calls.find((call) => call[1] === "run")!;
    expect(run).toContain("--network=none");
    expect(run).toContain("--read-only");
    expect(run).toContain("--cap-drop=ALL");
    expect(run).toContain("no-new-privileges");
    expect(run).toContain("1000:1000");
    expect(run).toContain("/workspace/node_modules/.vite-temp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000,mode=700");
    expect(run).toContain("--env");
    expect(run).toContain("PATH=/bin");
    expect(run).toContain(`type=bind,src=${sandbox.workspace.workspaceRoot},dst=/workspace`);
    expect(run.some((argument) => argument.endsWith("dst=/workspace,rw"))).toBe(false);
    manager.destroy(sandbox);
  });

  test("atomically claims a validated warm workspace once and never returns it to the pool", () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({
      workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn,
    });
    const digest = `sha256:${"a".repeat(64)}`;
    const dockerSpawn = ((_: string, args: string[]) => {
      if (args[0] === "info") return { status: 0, stdout: "27", stderr: "" };
      if (args[0] === "image") return { status: 0, stdout: `[\"oven/bun@${digest}\"]`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    }) as typeof import("node:child_process").spawnSync;
    const pool = new WarmSandboxPool({ root: join(root, "warm-pool") });
    const manager = new DockerSandboxManager({
      workspaceManager,
      imageReference: `oven/bun@${digest}`,
      imageDigest: digest,
      dockerSpawn,
      warmPool: {
        pool,
        lockfileHash: workspaceLockfileHash(repository.path),
        toolchainHash: sha256("bun-toolchain-v1"),
      },
    });
    manager.prewarm({
      repositoryId: "repo-1", repositoryRoot: repository.path, baseCommitSha: repository.sha,
    });
    const claim = manager.claimWarm({
      runId: "run-warm", repositoryId: "repo-1", repositoryRoot: repository.path, baseCommitSha: repository.sha,
    });
    expect(claim.status).toBe("CLAIMED");
    if (claim.status !== "CLAIMED") throw new Error("warm claim unexpectedly failed");
    expect(claim.sandbox.record.source).toBe("WARM");
    expect(manager.claimWarm({
      runId: "run-warm-2", repositoryId: "repo-1", repositoryRoot: repository.path, baseCommitSha: repository.sha,
    }).status).toBe("UNAVAILABLE");
    expect(manager.destroy(claim.sandbox).status).toBe("DESTROYED");
  });
});

describe("Phase 2 offline dependency bundle", () => {
  test("derives dependency identity from the exact base instead of a dirty working tree", () => {
    const root = temporaryRoot();
    const repository = initRepository(root, true);
    const exactBaseHash = gitCommitLockfileHash(repository.path, repository.sha);
    expect(exactBaseHash).toBe(workspaceLockfileHash(repository.path));

    writeFileSync(join(repository.path, "bun.lock"), "dirty working-tree lockfile\n");
    expect(workspaceLockfileHash(repository.path)).not.toBe(exactBaseHash);
    expect(gitCommitLockfileHash(repository.path, repository.sha)).toBe(exactBaseHash);
  });

  test("requires production bundles to match the exact repository commit", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root, true);
    const bundleRoot = join(root, "commit-bound-bundle");
    mkdirSync(join(bundleRoot, "node_modules", "fixture"), { recursive: true });
    writeFileSync(join(bundleRoot, "node_modules", "fixture", "index.js"), "export {};\n");
    const lockfileHash = workspaceLockfileHash(repository.path);
    const toolchainHash = sha256("commit-bound-toolchain");
    const contentHash = await hashDependencyTree(join(bundleRoot, "node_modules"));
    writeFileSync(join(bundleRoot, OFFLINE_DEPENDENCY_MANIFEST), JSON.stringify({
      schemaVersion: 1, lockfileHash, toolchainHash, contentHash, nodeModulesPath: "node_modules",
    }));
    expect(() => new OfflineDependencyBundle({
      root: bundleRoot, expectedLockfileHash: lockfileHash, expectedToolchainHash: toolchainHash, expectedRepositoryCommit: repository.sha,
    })).toThrow("not bound to a repository commit");
    writeFileSync(join(bundleRoot, OFFLINE_DEPENDENCY_MANIFEST), JSON.stringify({
      schemaVersion: 2, lockfileHash, toolchainHash, repositoryCommit: "f".repeat(40), contentHash, nodeModulesPath: "node_modules",
    }));
    expect(() => new OfflineDependencyBundle({
      root: bundleRoot, expectedLockfileHash: lockfileHash, expectedToolchainHash: toolchainHash, expectedRepositoryCommit: repository.sha,
    })).toThrow("repository commit mismatch");
  });

  test("binds dependency bytes to the exact lockfile and detects later tampering", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root, true);
    const bundleRoot = join(root, "dependency-bundle");
    mkdirSync(join(bundleRoot, "node_modules", "fixture"), { recursive: true });
    mkdirSync(join(bundleRoot, "node_modules", ".vite-temp"), { recursive: true });
    writeFileSync(join(bundleRoot, "node_modules", "fixture", "index.js"), "export const fixture = true;\n");
    const contentHash = await hashDependencyTree(join(bundleRoot, "node_modules"));
    const lockfileHash = workspaceLockfileHash(repository.path);
    const toolchainHash = sha256("bun-test-toolchain");
    writeFileSync(join(bundleRoot, OFFLINE_DEPENDENCY_MANIFEST), JSON.stringify({
      schemaVersion: 1, lockfileHash, toolchainHash, contentHash, nodeModulesPath: "node_modules",
    }));
    const bundle = new OfflineDependencyBundle({ root: bundleRoot, expectedLockfileHash: lockfileHash, expectedToolchainHash: toolchainHash });
    await expect(bundle.verify()).resolves.toBeUndefined();
    writeFileSync(join(bundle.nodeModulesRoot, "fixture", "index.js"), "tampered\n");
    await expect(bundle.verify()).rejects.toThrow("content hash mismatch");
  });

  test("rejects a bundle that lacks the writable Vite tmpfs mountpoint before execution", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root, true);
    const bundleRoot = join(root, "missing-vite-mountpoint-bundle");
    mkdirSync(join(bundleRoot, "node_modules", "fixture"), { recursive: true });
    writeFileSync(join(bundleRoot, "node_modules", "fixture", "index.js"), "export {};\n");
    const lockfileHash = workspaceLockfileHash(repository.path);
    const toolchainHash = sha256("vite-mountpoint-toolchain");
    writeFileSync(join(bundleRoot, OFFLINE_DEPENDENCY_MANIFEST), JSON.stringify({
      schemaVersion: 2, lockfileHash, toolchainHash, repositoryCommit: repository.sha,
      contentHash: await hashDependencyTree(join(bundleRoot, "node_modules")), nodeModulesPath: "node_modules",
    }));
    const bundle = new OfflineDependencyBundle({
      root: bundleRoot, expectedLockfileHash: lockfileHash, expectedToolchainHash: toolchainHash, expectedRepositoryCommit: repository.sha,
    });
    await expect(bundle.verify()).rejects.toThrow("required node_modules/.vite-temp mountpoint");
  });

  test("fails closed without a bundle and mounts an admitted bundle read-only", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root, true);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn });
    const digest = `sha256:${"d".repeat(64)}`;
    const imageReference = `oven/bun@${digest}`;
    const dockerCalls: string[][] = [];
    let observedCommandSignal: AbortSignal | undefined;
    const dockerRunAsync = async (args: string[], options?: { signal?: AbortSignal }) => {
      dockerCalls.push(args);
      if (args[0] === "info") return { status: 0, signal: null, stdout: "27.0", stderr: "" };
      if (args[0] === "image") return { status: 0, signal: null, stdout: JSON.stringify([`oven/bun@${digest}`]), stderr: "" };
      observedCommandSignal = options?.signal;
      return { status: 0, signal: null, stdout: "ok", stderr: "" };
    };
    const withoutBundle = new DockerSandboxManager({ workspaceManager, imageReference, imageDigest: digest, dockerRunAsync });
    await expect(withoutBundle.provisionColdAsync({ runId: "run-no-deps", repositoryRoot: repository.path, baseCommitSha: repository.sha }))
      .rejects.toThrow("require an immutable offline dependency bundle");

    const bundleRoot = join(root, "dependency-bundle");
    mkdirSync(join(bundleRoot, "node_modules", "fixture"), { recursive: true });
    mkdirSync(join(bundleRoot, "node_modules", ".vite-temp"), { recursive: true });
    writeFileSync(join(bundleRoot, "node_modules", "fixture", "index.js"), "export {};\n");
    const lockfileHash = workspaceLockfileHash(repository.path);
    const toolchainHash = sha256("bun-test-toolchain");
    writeFileSync(join(bundleRoot, OFFLINE_DEPENDENCY_MANIFEST), JSON.stringify({
      schemaVersion: 1, lockfileHash, toolchainHash,
      contentHash: await hashDependencyTree(join(bundleRoot, "node_modules")), nodeModulesPath: "node_modules",
    }));
    const offlineDependencies = new OfflineDependencyBundle({ root: bundleRoot, expectedLockfileHash: lockfileHash, expectedToolchainHash: toolchainHash });
    const manager = new DockerSandboxManager({ workspaceManager, imageReference, imageDigest: digest, dockerRunAsync, offlineDependencies });
    const sandbox = await manager.provisionColdAsync({ runId: "run-with-deps", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const cancellation = new AbortController();
    await sandbox.commandRunnerAsync!("bun", ["test"], {
      cwd: sandbox.workspace.workspaceRoot, timeoutMs: 1_000, maxOutputBytes: 1024, env: {}, signal: cancellation.signal,
    });
    expect(observedCommandSignal).toBe(cancellation.signal);
    const runArgs = dockerCalls.find((args) => args[0] === "run") ?? [];
    expect(runArgs).toContain("--network=none");
    expect(runArgs).toContain(`type=bind,src=${sandbox.workspace.workspaceRoot},dst=/workspace`);
    expect(runArgs.some((argument) => argument.endsWith("dst=/workspace,rw"))).toBe(false);
    expect(runArgs).toContain(`type=bind,src=${offlineDependencies.nodeModulesRoot},dst=/workspace/node_modules,readonly`);
    expect(runArgs).toContain("/workspace/node_modules/.vite-temp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000,mode=700");
    await manager.destroyAsync(sandbox);
  });
});

describe("Phase 2 Codex Builder", () => {
  test("binds a trusted correction action into the Builder input identity", () => {
    const task = manifest("run-correction-context", "a".repeat(40));
    const withoutCorrection = builderInputContextHash(task);
    const withCorrection = builderInputContextHash(task, undefined, [{
      code: "GENERATE_NON_SECRET_TEST_FIXTURES",
      sourceRecordIds: ["finding-1"],
      file: "test/value.test.ts",
      lineStart: 6,
      lineEnd: 6,
    }]);
    expect(withCorrection).not.toBe(withoutCorrection);
  });

  test("authority loss after reservation escapes before provider retry classification", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "authority-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-authority-fence", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-authority-fence", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "authority-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "tests passed", stderr: "" }),
    });
    let authorityChecks = 0;
    let reservations = 0;
    let providerCalls = 0;
    let retryClassifications = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: {
        async countInputTokens() { return 10; },
        async create() { providerCalls += 1; throw new Error("provider must remain fenced"); },
      },
      assertAuthority: () => {
        authorityChecks += 1;
        if (authorityChecks === 3) throw new StaleWorkerLeaseError("authority revoked after reservation");
      },
      reserveModelCall: () => { reservations += 1; return "reservation-before-fence"; },
      authorizeModelRetry: () => { retryClassifications += 1; return true; },
    });
    await expect(builder.run()).rejects.toBeInstanceOf(StaleWorkerLeaseError);
    expect(authorityChecks).toBe(3);
    expect(reservations).toBe(1);
    expect(providerCalls).toBe(0);
    expect(retryClassifications).toBe(0);
    workspaceManager.remove(workspace);
  });

  test("a replayed hardening reservation fails closed before transport construction", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({
      workspaceRoot: join(root, "reservation-replay-workspaces"),
      gitSpawn: bunGitSpawn,
    });
    const workspace = workspaceManager.create({
      runId: "run-reservation-replay",
      repositoryRoot: repository.path,
      baseCommitSha: repository.sha,
    });
    const task = manifest("run-reservation-replay", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "reservation-replay-artifacts") }),
      workspace,
      sandbox,
      manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "tests passed", stderr: "" }),
    });
    let transportConstructions = 0;
    let providerCalls = 0;
    const builder = new CodexBuilder({
      manifest: task,
      workspace,
      workspaceManager,
      executor,
      conservativeLocalInputAccounting: true,
      hardeningPromptCacheIdentity: {
        secret: "0123456789abcdef0123456789abcdef",
        requesterUserId: "user-reservation-replay",
        childRunId: task.runId,
      },
      reserveModelCall: () => ({ reservationId: "existing-reservation", dispatchAllowed: false }),
      beforeModelDispatch: () => undefined,
      onModelResponseReceived: () => undefined,
      onReservedUnsentFailure: () => undefined,
      transportAfterReservation: () => {
        transportConstructions += 1;
        return {
          async create() {
            providerCalls += 1;
            throw new Error("provider transport must not be reached");
          },
        };
      },
    });

    await expect(builder.run()).rejects.toThrow("reservation replay is not dispatchable");
    expect(transportConstructions).toBe(0);
    expect(providerCalls).toBe(0);
    workspaceManager.remove(workspace);
  });

  test("rejects an incomplete hardening Builder dispatch protocol before reservation or provider construction", async () => {
    for (const missing of ["beforeModelDispatch", "onModelResponseReceived", "onReservedUnsentFailure"] as const) {
      const root = temporaryRoot();
      const repository = initRepository(root);
      const workspaceManager = new GitWorkspaceManager({
        workspaceRoot: join(root, `incomplete-builder-${missing}-workspaces`),
        gitSpawn: bunGitSpawn,
      });
      const workspace = workspaceManager.create({
        runId: `run-incomplete-builder-${missing}`,
        repositoryRoot: repository.path,
        baseCommitSha: repository.sha,
      });
      const task = manifest(`run-incomplete-builder-${missing}`, repository.sha);
      const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
      const executor = new TrustedCommandExecutor({
        artifactStore: new LocalArtifactStore({ root: join(root, `incomplete-builder-${missing}-artifacts`) }),
        workspace,
        sandbox,
        manifest: task,
        currentCommit: () => workspaceManager.currentCommit(workspace),
        runner: () => ({ status: 0, stdout: "tests passed", stderr: "" }),
      });
      let reservations = 0;
      let transportConstructions = 0;
      let providerCalls = 0;
      let cleanupCalls = 0;
      const builder = new CodexBuilder({
        manifest: task,
        workspace,
        workspaceManager,
        executor,
        conservativeLocalInputAccounting: true,
        hardeningPromptCacheIdentity: {
          secret: "0123456789abcdef0123456789abcdef",
          requesterUserId: "user-incomplete-builder",
          childRunId: task.runId,
        },
        reserveModelCall: () => {
          reservations += 1;
          return {
            reservationId: `incomplete-builder-${missing}-reservation`,
            dispatchAllowed: true,
            clientRequestId: `incomplete-builder-${missing}-request`,
          };
        },
        ...(missing === "beforeModelDispatch" ? {} : { beforeModelDispatch: () => undefined }),
        ...(missing === "onModelResponseReceived" ? {} : { onModelResponseReceived: () => undefined }),
        ...(missing === "onReservedUnsentFailure" ? {} : {
          onReservedUnsentFailure: () => { cleanupCalls += 1; },
        }),
        transportAfterReservation: () => {
          transportConstructions += 1;
          return {
            async create() {
              providerCalls += 1;
              throw new Error("Builder provider transport must not be reached");
            },
          };
        },
      });

      await expect(builder.run()).rejects.toThrow("hardening Builder dispatch protocol is incomplete");
      expect({ missing, reservations, transportConstructions, providerCalls, cleanupCalls }).toEqual({
        missing, reservations: 0, transportConstructions: 0, providerCalls: 0, cleanupCalls: 0,
      });
      workspaceManager.remove(workspace);
    }
  });

  test("reports omitted provider cache details as explicit null after one hardening Builder dispatch", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({
      workspaceRoot: join(root, "missing-cache-workspaces"),
      gitSpawn: bunGitSpawn,
    });
    const workspace = workspaceManager.create({
      runId: "run-builder-missing-cache",
      repositoryRoot: repository.path,
      baseCommitSha: repository.sha,
    });
    const task = manifest("run-builder-missing-cache", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "missing-cache-artifacts") }),
      workspace,
      sandbox,
      manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "tests passed", stderr: "" }),
    });
    let providerCalls = 0;
    const received: Array<{ cachedInputTokens: number | null; cacheWriteInputTokens: number | null }> = [];
    const completed: Array<{ cachedInputTokens: number | null; cacheWriteInputTokens: number | null }> = [];
    const builder = new CodexBuilder({
      manifest: task,
      workspace,
      workspaceManager,
      executor,
      conservativeLocalInputAccounting: true,
      hardeningPromptCacheIdentity: {
        secret: "0123456789abcdef0123456789abcdef",
        requesterUserId: "user-builder-missing-cache",
        childRunId: task.runId,
      },
      reserveModelCall: () => ({
        reservationId: "builder-missing-cache-reservation",
        dispatchAllowed: true,
        clientRequestId: "builder-missing-cache-request",
      }),
      beforeModelDispatch: () => undefined,
      onReservedUnsentFailure: () => undefined,
      transportAfterReservation: () => ({
        async create() {
          providerCalls += 1;
          return {
            id: "builder-missing-cache-response",
            usage: { input_tokens: 100, output_tokens: 10 },
            output: [
              { type: "function_call", call_id: "missing-cache-write", name: "write_file", arguments: JSON.stringify({
                path: "src/value.ts", content: "export const value = 2;\n",
              }) },
              { type: "function_call", call_id: "missing-cache-test", name: "run_command", arguments: JSON.stringify({
                command: "bun run test",
              }) },
            ],
          };
        },
      }),
      onModelResponseReceived: (observation) => {
        received.push({
          cachedInputTokens: observation.cachedInputTokens,
          cacheWriteInputTokens: observation.cacheWriteInputTokens,
        });
      },
      onModelCall: (observation) => {
        completed.push({
          cachedInputTokens: observation.cachedInputTokens,
          cacheWriteInputTokens: observation.cacheWriteInputTokens,
        });
      },
    });
    const result = await builder.run();
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    expect(providerCalls).toBe(1);
    expect(received).toEqual([{ cachedInputTokens: null, cacheWriteInputTokens: null }]);
    expect(completed).toEqual(received);
    workspaceManager.remove(workspace);
  });

  test("rechecks authority before every tool in one provider response", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "multi-tool-authority-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-multi-tool-authority", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-multi-tool-authority", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const originalBytes = readFileSync(join(workspace.workspaceRoot, "src/value.ts"));
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "multi-tool-authority-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "tests passed", stderr: "" }),
    });
    let authorityChecks = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() { return {
        id: "multi-tool-response", usage: { input_tokens: 10, output_tokens: 10 },
        output: [
          { type: "function_call", call_id: "safe-read", name: "read_file", arguments: JSON.stringify({ path: "src/value.ts" }) },
          { type: "function_call", call_id: "forbidden-write", name: "write_file", arguments: JSON.stringify({ path: "src/value.ts", content: "export const value = 999;\n" }) },
        ],
      }; } },
      assertAuthority: () => {
        authorityChecks += 1;
        if (authorityChecks === 6) throw new StaleWorkerLeaseError("authority revoked between response tools");
      },
      reserveModelCall: () => "multi-tool-reservation",
    });
    await expect(builder.run()).rejects.toBeInstanceOf(StaleWorkerLeaseError);
    expect(authorityChecks).toBe(6);
    expect(readFileSync(join(workspace.workspaceRoot, "src/value.ts"))).toEqual(originalBytes);
    workspaceManager.remove(workspace);
  });

  test("uses literal search and bounded line ranges to converge on an edit", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "targeted-discovery-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-targeted-discovery", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-targeted-discovery", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "targeted-discovery-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "tests passed", stderr: "" }),
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create(request) {
        calls += 1;
        if (calls === 1) {
          expect(JSON.stringify(request.tools)).toContain("search_files");
          expect(JSON.stringify(request.tools)).toContain("read_file_range");
          expect(String(request.instructions)).toContain("Discovery must converge");
          expect(request.parallel_tool_calls).toBe(true);
          return { id: "targeted-search", output: [{
            type: "function_call", call_id: "targeted-search-call", name: "search_files",
            arguments: JSON.stringify({ query: "export const value" }),
          }] };
        }
        if (calls === 2) {
          expect(JSON.stringify(request.input)).toContain("src/value.ts");
          expect(JSON.stringify(request.input)).toContain("line");
          return { id: "targeted-range", output: [{
            type: "function_call", call_id: "targeted-range-call", name: "read_file_range",
            arguments: JSON.stringify({ path: "src/value.ts", startLine: 1, endLine: 1 }),
          }] };
        }
        if (calls === 3) {
          expect(JSON.stringify(request.input)).toContain("export const value = 1");
          return { id: "targeted-write", output: [{
            type: "function_call", call_id: "targeted-write-call", name: "write_file",
            arguments: JSON.stringify({ path: "src/value.ts", content: "export const value = 2;\n" }),
          }] };
        }
        return { id: "targeted-test", output: [{
          type: "function_call", call_id: "targeted-test-call", name: "run_command",
          arguments: JSON.stringify({ command: "bun run test" }),
        }] };
      } },
    });
    const result = await builder.run();
    expect(calls).toBe(4);
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    expect(await workspaceManager.diffAsync(workspace)).toContain("export const value = 2");
    workspaceManager.remove(workspace);
  });

  test("keeps search and ranged reads inside the frozen manifest scope", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    writeFileSync(join(repository.path, "outside.txt"), "outside-marker classified-payload\n");
    execFileSync("git", ["-C", repository.path, "add", "outside.txt"]);
    execFileSync("git", ["-C", repository.path, "commit", "-m", "out-of-scope fixture"]);
    const baseCommitSha = execFileSync("git", ["-C", repository.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "scoped-discovery-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-scoped-discovery", repositoryRoot: repository.path, baseCommitSha });
    const task = manifest("run-scoped-discovery", baseCommitSha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, baseCommitSha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "scoped-discovery-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create(request) {
        calls += 1;
        const serialized = JSON.stringify(request.input);
        if (calls === 1) return { id: "scoped-search", output: [{
          type: "function_call", call_id: "scoped-search-call", name: "search_files",
          arguments: JSON.stringify({ query: "outside-marker" }),
        }] };
        if (calls === 2) {
          expect(serialized).not.toContain("classified-payload");
          return { id: "scoped-range", output: [{
            type: "function_call", call_id: "scoped-range-call", name: "read_file_range",
            arguments: JSON.stringify({ path: "outside.txt", startLine: 1, endLine: 1 }),
          }] };
        }
        expect(serialized).toContain("outside the frozen manifest scope");
        expect(serialized).not.toContain("classified-payload");
        return { id: "scoped-finish", output: [], output_text: "No authorized change made." };
      } },
    });
    const result = await builder.run();
    expect(calls).toBe(3);
    expect(result.changedFiles).toEqual([]);
    workspaceManager.remove(workspace);
  });

  test("suppresses repeated large-file evidence before stopping a no-progress loop", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    writeFileSync(join(repository.path, "src", "large.ts"), `needle\n${"x".repeat(MAX_BUILDER_MODEL_TOOL_OUTPUT_BYTES * 2)}`);
    execFileSync("git", ["-C", repository.path, "add", "src/large.ts"]);
    execFileSync("git", ["-C", repository.path, "commit", "-m", "large duplicate fixture"]);
    const baseCommitSha = execFileSync("git", ["-C", repository.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "duplicate-evidence-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-duplicate-evidence", repositoryRoot: repository.path, baseCommitSha });
    const task = manifest("run-duplicate-evidence", baseCommitSha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, baseCommitSha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "duplicate-evidence-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create(request) {
        calls += 1;
        const serialized = JSON.stringify(request.input);
        if (calls === 2) expect(serialized).toContain("MODEL_VIEW_TRUNCATED");
        if (calls === 3) {
          expect(serialized).toContain("duplicateEvidence");
          expect(serialized.match(/MODEL_VIEW_TRUNCATED/g)?.length).toBe(1);
          expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(MAX_BUILDER_MODEL_TOOL_OUTPUT_BYTES * 2);
        }
        return { id: `duplicate-evidence-${calls}`, output: [{
          type: "function_call", call_id: `duplicate-evidence-call-${calls}`, name: "read_file",
          arguments: JSON.stringify({ path: "src/large.ts" }),
        }] };
      } },
    });
    await expect(builder.run()).rejects.toThrow("repeated evidence was suppressed");
    expect(calls).toBe(3);
    workspaceManager.remove(workspace);
  });

  test("stops unique read-only discovery before it can consume the full paid round budget", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "bounded-discovery-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-bounded-discovery", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-bounded-discovery", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "bounded-discovery-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let paidCalls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        paidCalls += 1;
        return { id: `bounded-discovery-${paidCalls}`, output: [{
          type: "function_call", call_id: `bounded-discovery-call-${paidCalls}`, name: "search_files",
          arguments: JSON.stringify({ query: `unique-query-${paidCalls}` }),
        }] };
      } },
    });
    await expect(builder.run()).rejects.toThrow("paid discovery rounds without producing an authorized candidate diff");
    expect(paidCalls).toBe(MAX_BUILDER_DISCOVERY_ROUNDS_BEFORE_MUTATION);
    expect(paidCalls).toBeLessThan(MAX_BUILDER_TOOL_CALLS_PER_RUN);
    expect(await workspaceManager.diffAsync(workspace)).toBe("");
    workspaceManager.remove(workspace);
  });

  test("does not let a reverted write reset the paid discovery ceiling", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "reverted-discovery-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-reverted-discovery", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-reverted-discovery", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "reverted-discovery-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let paidCalls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        paidCalls += 1;
        if (paidCalls === 1) return { id: "reverted-discovery-write", output: [{
          type: "function_call", call_id: "reverted-discovery-write-call", name: "write_file",
          arguments: JSON.stringify({ path: "src/value.ts", content: "export const value = 1;\n" }),
        }] };
        return { id: `reverted-discovery-${paidCalls}`, output: [{
          type: "function_call", call_id: `reverted-discovery-call-${paidCalls}`, name: "search_files",
          arguments: JSON.stringify({ query: `reverted-query-${paidCalls}` }),
        }] };
      } },
    });
    await expect(builder.run()).rejects.toThrow("paid discovery rounds without producing an authorized candidate diff");
    expect(paidCalls).toBe(MAX_BUILDER_DISCOVERY_ROUNDS_BEFORE_MUTATION);
    expect(await workspaceManager.diffAsync(workspace)).toBe("");
    workspaceManager.remove(workspace);
  });

  test("preserves the discovery ceiling across a budget pause and resume", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "discovery-resume-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-discovery-resume", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-discovery-resume", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "discovery-resume-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let paidCalls = 0;
    let reservations = 0;
    let continuation: BuilderContinuation | undefined;
    const interrupted = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        paidCalls += 1;
        return { id: `discovery-resume-${paidCalls}`, output: [{
          type: "function_call", call_id: `discovery-resume-call-${paidCalls}`, name: "search_files",
          arguments: JSON.stringify({ query: `resume-query-${paidCalls}` }),
        }] };
      } },
      reserveModelCall: () => {
        reservations += 1;
        if (reservations === MAX_BUILDER_DISCOVERY_ROUNDS_BEFORE_MUTATION) {
          throw new BudgetPausedError(task.runId, "discovery resume checkpoint");
        }
        return `discovery-reservation-${reservations}`;
      },
      onContinuation: (checkpoint) => { continuation = checkpoint; },
    });
    await expect(interrupted.run()).rejects.toThrow("discovery resume checkpoint");
    expect(paidCalls).toBe(MAX_BUILDER_DISCOVERY_ROUNDS_BEFORE_MUTATION - 1);
    expect(continuation?.discoveryRoundsBeforeMutation).toBe(MAX_BUILDER_DISCOVERY_ROUNDS_BEFORE_MUTATION - 1);

    let resumedCalls = 0;
    const resumed = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor, continuation,
      transport: { async create() {
        paidCalls += 1;
        resumedCalls += 1;
        return { id: "discovery-resume-final", output: [{
          type: "function_call", call_id: "discovery-resume-final-call", name: "search_files",
          arguments: JSON.stringify({ query: "resume-final-query" }),
        }] };
      } },
    });
    await expect(resumed.run()).rejects.toThrow("paid discovery rounds without producing an authorized candidate diff");
    expect(resumedCalls).toBe(1);
    expect(paidCalls).toBe(MAX_BUILDER_DISCOVERY_ROUNDS_BEFORE_MUTATION);
    workspaceManager.remove(workspace);
  });

  test("rejects an exhausted legacy discovery checkpoint before another paid call", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "legacy-discovery-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-legacy-discovery", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-legacy-discovery", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "legacy-discovery-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    const legacyContinuation: BuilderContinuation = {
      version: 1, runId: task.runId, manifestHash: task.manifestHash,
      inputContextHash: sha256(task.request.normalized), nextRound: 11,
      input: [], responseIds: [], requestedCommands: [], commandExecutionIds: [],
      mutations: 0, successfulEvidenceMutation: -1, successfulEvidenceCommand: null,
      toolCallCount: 11, consecutiveNoProgressRounds: 0, candidateDiffHash: sha256(""),
      seenSemanticEvidence: [], failedCommands: [],
    };
    let paidCalls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor, continuation: legacyContinuation,
      transport: { async create() { paidCalls += 1; return { id: "must-not-run", output: [] }; } },
    });
    await expect(builder.run()).rejects.toThrow("no additional model call was admitted");
    expect(paidCalls).toBe(0);
    workspaceManager.remove(workspace);
  });

  test("never purchases a thirteenth Builder turn at the tool-round boundary", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "round-boundary-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-round-boundary", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-round-boundary", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "round-boundary-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 1, stdout: "", stderr: "still iterating" }),
    });
    let paidCalls = 0;
    const result = await new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        paidCalls += 1;
        return { id: `round-boundary-${paidCalls}`, output: [{
          type: "function_call", call_id: `round-boundary-call-${paidCalls}`, name: "write_file",
          arguments: JSON.stringify({ path: "src/value.ts", content: `export const value = ${paidCalls + 1};\n` }),
        }] };
      } },
    }).run();
    expect(paidCalls).toBe(12);
    expect(result.responseIds).toHaveLength(12);
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    expect(result.implementationSummary).toContain("paid tool ceiling");
    workspaceManager.remove(workspace);
  });

  test("stops repeated identical command failures before exhausting tool rounds", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "no-progress-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-no-progress", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-no-progress", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "no-progress-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 2, stdout: "", stderr: "same dependency failure" }),
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() { calls += 1; return {
        id: `no-progress-${calls}`,
        output: [{ type: "function_call", call_id: `no-progress-call-${calls}`, name: "run_command", arguments: JSON.stringify({ command: "bun run test" }) }],
      }; } },
    });
    await expect(builder.run()).rejects.toBeInstanceOf(BuilderNoProgressError);
    expect(calls).toBe(2);
    workspaceManager.remove(workspace);
  });

  test("gives the Builder bounded redacted diagnostics before it repairs a failed command", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "diagnostic-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-command-diagnostic", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-command-diagnostic", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    let commandRuns = 0;
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "diagnostic-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => {
        commandRuns += 1;
        return commandRuns === 1
          ? { status: 1, stdout: "partial test output", stderr: "Assertion failed at /Users/tester/project/test.ts token=sk-abcdefghijklmnop" }
          : { status: 0, stdout: "1 pass", stderr: "" };
      },
    });
    const requests: Record<string, unknown>[] = [];
    let calls = 0;
    const result = await new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create(request) {
        requests.push(request);
        calls += 1;
        if (calls === 1) return { id: "diagnostic-fail", output: [{
          type: "function_call", call_id: "diagnostic-fail-call", name: "run_command", arguments: JSON.stringify({ command: "bun run test" }),
        }] };
        if (calls === 2) return { id: "diagnostic-write", output: [{
          type: "function_call", call_id: "diagnostic-write-call", name: "write_file", arguments: JSON.stringify({ path: "src/value.ts", content: "export const value = 2;\n" }),
        }] };
        return { id: "diagnostic-pass", output: [{
          type: "function_call", call_id: "diagnostic-pass-call", name: "run_command", arguments: JSON.stringify({ command: "bun run test" }),
        }] };
      } },
    }).run();
    const repairInput = JSON.stringify(requests[1]);
    expect(repairInput).toContain("Assertion failed");
    expect(repairInput).toContain("partial test output");
    expect(repairInput).toContain("[REDACTED_PATH]");
    expect(repairInput).toContain("[REDACTED_SECRET]");
    expect(repairInput).not.toContain("/Users/tester");
    expect(repairInput).not.toContain("sk-abcdefghijklmnop");
    expect(commandRuns).toBe(2);
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    workspaceManager.remove(workspace);
  });

  test("stops alternating tool failures after two model rounds without semantic progress", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "alternating-failure-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-alternating-failures", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-alternating-failures", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "alternating-failure-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => { throw new Error("an unauthorized command must never reach the runner"); },
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        calls += 1;
        return calls === 1
          ? { id: "policy-failure", output: [{
            type: "function_call", call_id: "policy-failure-call", name: "run_command",
            arguments: JSON.stringify({ command: "bun run unauthorized" }),
          }] }
          : { id: "path-failure", output: [{
            type: "function_call", call_id: "path-failure-call", name: "read_file",
            arguments: JSON.stringify({ path: "../outside.ts" }),
          }] };
      } },
    });
    await expect(builder.run()).rejects.toThrow("no semantic progress in 2 consecutive model rounds");
    expect(calls).toBe(2);
    workspaceManager.remove(workspace);
  });

  test("does not treat write counters as progress when a round restores the candidate diff", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "no-op-mutation-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-no-op-mutations", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-no-op-mutations", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "no-op-mutation-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        calls += 1;
        return { id: `no-op-mutation-${calls}`, output: [
          { type: "function_call", call_id: `change-${calls}`, name: "write_file", arguments: JSON.stringify({
            path: "src/value.ts", content: "export const value = 2;\n",
          }) },
          { type: "function_call", call_id: `restore-${calls}`, name: "write_file", arguments: JSON.stringify({
            path: "src/value.ts", content: "export const value = 1;\n",
          }) },
        ] };
      } },
    });
    await expect(builder.run()).rejects.toThrow("no semantic progress in 2 consecutive model rounds");
    expect(calls).toBe(2);
    expect(await workspaceManager.diffAsync(workspace)).toBe("");
    workspaceManager.remove(workspace);
  });

  test("rolls back candidate mutations authored by an allowed repository command", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "command-mutation-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-command-mutation", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-command-mutation", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "command-mutation-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => {
        writeFileSync(join(workspace.workspaceRoot, "src", "value.ts"), "export const value = 999;\n");
        return { status: 0, stdout: "tests passed", stderr: "" };
      },
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        calls += 1;
        return { id: `command-mutation-${calls}`, output: [{
          type: "function_call", call_id: `command-mutation-call-${calls}`, name: "run_command",
          arguments: JSON.stringify({ command: "bun run test" }),
        }] };
      } },
    });
    await expect(builder.run()).rejects.toThrow("no semantic progress in 2 consecutive model rounds");
    expect(readFileSync(join(workspace.workspaceRoot, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await workspaceManager.diffAsync(workspace)).toBe("");
    expect(calls).toBe(2);
    workspaceManager.remove(workspace);
  });

  test("bounds large tool results before they enter the next paid model request", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    writeFileSync(join(repository.path, "src", "large.ts"), "x".repeat(MAX_BUILDER_MODEL_TOOL_OUTPUT_BYTES * 2));
    execFileSync("git", ["-C", repository.path, "add", "src/large.ts"]);
    execFileSync("git", ["-C", repository.path, "commit", "-m", "large fixture"]);
    const baseCommitSha = execFileSync("git", ["-C", repository.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "bounded-output-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-bounded-output", repositoryRoot: repository.path, baseCommitSha });
    const task = manifest("run-bounded-output", baseCommitSha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, baseCommitSha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "bounded-output-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let calls = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create(request) {
        calls += 1;
        if (calls === 1) return { id: "bounded-output-read", output: [{
          type: "function_call", call_id: "bounded-output-read-call", name: "read_file",
          arguments: JSON.stringify({ path: "src/large.ts" }),
        }] };
        const serialized = JSON.stringify(request.input);
        expect(serialized).toContain("MODEL_VIEW_TRUNCATED");
        expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(MAX_BUILDER_MODEL_TOOL_OUTPUT_BYTES + 4_000);
        return { id: "bounded-output-finish", output: [], output_text: "Inspected bounded source context." };
      } },
    });
    await builder.run();
    expect(calls).toBe(2);
    workspaceManager.remove(workspace);
  });

  test("resumes a durable Builder continuation without replaying completed paid rounds", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "continuation-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-continuation", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-continuation", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "continuation-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let paidCalls = 0;
    let reservations = 0;
    let continuation: BuilderContinuation | undefined;
    const interrupted = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        paidCalls += 1;
        return { id: "continuation-write", output: [{
          type: "function_call", call_id: "continuation-write-call", name: "write_file",
          arguments: JSON.stringify({ path: "src/value.ts", content: "export const value = 2;\n" }),
        }] };
      } },
      reserveModelCall: () => {
        reservations += 1;
        if (reservations === 2) throw new BudgetPausedError(task.runId, "continuation checkpoint test");
        return `reservation-${reservations}`;
      },
      onContinuation: (checkpoint) => { continuation = checkpoint; },
    });
    await expect(interrupted.run()).rejects.toThrow("continuation checkpoint test");
    expect(paidCalls).toBe(1);
    expect(continuation).toBeDefined();

    const result = await new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor, continuation,
      transport: { async create(request) {
        paidCalls += 1;
        expect(JSON.stringify(request.input)).toContain("continuation-write-call");
        return { id: "continuation-finish", output: [], output_text: "Resumed from the durable tool transcript." };
      } },
    }).run();
    expect(paidCalls).toBe(2);
    expect(result.responseIds).toEqual(["continuation-write", "continuation-finish"]);
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    workspaceManager.remove(workspace);
  });

  test("rejects a response above its tool-call ceiling before executing any call", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "response-call-limit-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-response-call-limit", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-response-call-limit", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "response-call-limit-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() { return {
        id: "too-many-calls",
        output: Array.from({ length: MAX_BUILDER_TOOL_CALLS_PER_RESPONSE + 1 }, (_, index) => ({
          type: "function_call", call_id: `call-${index}`, name: "write_file",
          arguments: JSON.stringify({ path: "src/value.ts", content: `export const value = ${index + 2};\n` }),
        })),
      }; } },
    });
    await expect(builder.run()).rejects.toThrow(`${MAX_BUILDER_TOOL_CALLS_PER_RESPONSE}-call per-response tool limit`);
    expect(readFileSync(join(workspace.workspaceRoot, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    workspaceManager.remove(workspace);
  });

  test("rejects calls above the Builder-run ceiling before executing the crossing response", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "run-call-limit-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-call-limit", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-call-limit", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "run-call-limit-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    let response = 0;
    const builder = new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: { async create() {
        response += 1;
        const count = response <= MAX_BUILDER_TOOL_CALLS_PER_RUN / MAX_BUILDER_TOOL_CALLS_PER_RESPONSE
          ? MAX_BUILDER_TOOL_CALLS_PER_RESPONSE
          : 1;
        return { id: `run-limit-${response}`, output: Array.from({ length: count }, (_, index) => ({
          type: "function_call", call_id: `run-limit-${response}-${index}`, name: "write_file",
          arguments: JSON.stringify({
            path: "src/value.ts",
            content: `// round ${response} call ${index + 1}\nexport const value = ${response};\n`,
          }),
        })) };
      } },
    });
    await expect(builder.run()).rejects.toThrow(`${MAX_BUILDER_TOOL_CALLS_PER_RUN}-call per-run tool limit`);
    expect(response).toBe(6);
    expect(readFileSync(join(workspace.workspaceRoot, "src", "value.ts"), "utf8")).toContain("round 5 call 8");
    workspaceManager.remove(workspace);
  });

  test("classifies provider timeouts without treating unrelated failures as timeouts", () => {
    const timeout = new Error("Request timed out.");
    timeout.name = "APIConnectionTimeoutError";
    expect(isProviderModelTimeout(timeout)).toBe(true);
    expect(isProviderModelTimeout(new Error("dependency timed out while installing"))).toBe(false);
    expect(isProviderModelTimeout(new Error("rate limit"))).toBe(false);
  });

  test("backs retryable model failures off with bounded full jitter", () => {
    expect(modelRetryBackoffMs(1, () => 0)).toBe(0);
    expect(modelRetryBackoffMs(1, () => 0.999999)).toBe(249);
    expect(modelRetryBackoffMs(5, () => 0.999999)).toBe(3_999);
    expect(modelRetryBackoffMs(20, () => 0.999999)).toBe(3_999);
    expect(() => modelRetryBackoffMs(0)).toThrow("positive integer");
  });

  test("counts the exact provider input instead of treating UTF-8 bytes as tokens", async () => {
    const request = { model: "gpt-5.6-sol", instructions: "Plan safely", input: "a".repeat(120_000), max_output_tokens: 8_000 };
    const localEstimate = estimateResponseInputTokens(request);
    expect(localEstimate).toBe(Buffer.byteLength(JSON.stringify({ model: request.model, instructions: request.instructions, input: request.input })));
    const fallback = await countResponseInputTokens({ async create() { return { id: "unused", output: [] }; } }, request);
    expect(fallback).toBe(localEstimate);

    const countBodies: Array<Record<string, unknown>> = [];
    const transport = new OpenAIResponsesTransport({
      apiKey: "sk-test-never-in-prompt",
      fetch: (async (url, init) => {
        if (String(url).endsWith("/responses/input_tokens")) {
          countBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ object: "response.input_tokens", input_tokens: 31_337 }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error("unexpected endpoint");
      }) as typeof fetch,
    });
    expect(await countResponseInputTokens(transport, request)).toBe(31_337);
    expect(countBodies).toEqual([{ model: request.model, instructions: request.instructions, input: request.input }]);
  });

  test("keeps the OpenAI credential in the transport header and requests no provider storage", async () => {
    let observedBody = "";
    const transport = new OpenAIResponsesTransport({
      apiKey: "sk-test-never-in-prompt",
      fetch: (async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test-never-in-prompt");
        observedBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ id: "response-1", output: [] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    await transport.create({ model: "gpt-5.6-sol", input: [], store: false });
    expect(observedBody).not.toContain("sk-test-never-in-prompt");
    expect(JSON.parse(observedBody).store).toBe(false);
  });

  test("executes Responses function calls and returns a real scoped Git diff", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-1", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-1", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, "run-1", repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }), workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "pass", stderr: "" }),
    });
    let requestCount = 0;
    const cacheKeys: string[] = [];
    const transport: ResponsesTransport = {
      async create(request) {
        requestCount += 1;
        expect(request.model).toBe("gpt-5.6-terra");
        expect(request.store).toBe(false);
        expect(request.max_output_tokens).toBe(BUILDER_MAX_OUTPUT_TOKENS);
        expect(request.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
        expect(request.context_management).toEqual([{ type: "compaction", compact_threshold: BUILDER_CONTEXT_COMPACTION_THRESHOLD_TOKENS }]);
        expect(request.input).toEqual(expect.arrayContaining([expect.objectContaining({
          content: expect.arrayContaining([expect.objectContaining({ prompt_cache_breakpoint: { mode: "explicit" } })]),
        })]));
        cacheKeys.push(String(request.prompt_cache_key));
        if (requestCount === 1) return {
          id: "resp-1",
          output: [{ type: "function_call", call_id: "call-1", name: "write_file", arguments: JSON.stringify({
            path: "src/value.ts", content: "export const value = 2;\n",
          }) }],
        };
        return { id: "resp-2", output: [], output_text: "Updated the requested value." };
      },
    };
    const result = await new CodexBuilder({
      transport, manifest: task, workspace, workspaceManager, executor,
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    }).run();
    expect(result.model).toBe("gpt-5.6-terra");
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    expect(result.diff).toContain("value = 2");
    expect(result.responseIds).toEqual(["resp-1", "resp-2"]);
    expect(new Set(cacheKeys).size).toBe(1);
    expect(cacheKeys[0]).not.toBe("undefined");
    workspaceManager.remove(workspace);
  });

  test("hands off immediately after executor evidence succeeds for the latest mutation", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "evidence-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = workspaceManager.create({ runId: "run-evidence-handoff", repositoryRoot: repository.path, baseCommitSha: repository.sha });
    const task = manifest("run-evidence-handoff", repository.sha);
    const { sandbox } = records(workspace.workspaceRoot, task.runId, repository.sha);
    const executor = new TrustedCommandExecutor({
      artifactStore: new LocalArtifactStore({ root: join(root, "evidence-artifacts") }),
      workspace, sandbox, manifest: task,
      currentCommit: () => workspaceManager.currentCommit(workspace),
      runner: () => ({ status: 0, stdout: "pass", stderr: "" }),
    });
    let calls = 0;
    const result = await new CodexBuilder({
      manifest: task, workspace, workspaceManager, executor,
      transport: {
        async create() {
          calls += 1;
          if (calls === 1) return {
            id: "evidence-write", output: [{
              type: "function_call", call_id: "evidence-write-call", name: "write_file",
              arguments: JSON.stringify({ path: "src/value.ts", content: "export const value = 2;\n" }),
            }],
          };
          if (calls === 2) return {
            id: "evidence-command", output: [{
              type: "function_call", call_id: "evidence-command-call", name: "run_command",
              arguments: JSON.stringify({ command: "bun run test" }),
            }],
          };
          throw new Error("a final narrative model call must not be made");
        },
      },
    }).run();
    expect(calls).toBe(2);
    expect(result.responseIds).toEqual(["evidence-write", "evidence-command"]);
    expect(result.implementationSummary).toContain("independent verification is pending");
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    workspaceManager.remove(workspace);
  });

  test("resolves every fixed role without cross-tier fallback", () => {
    expect(resolveEngineerModel("BUILDER").model).toBe("gpt-5.6-terra");
    expect(resolveEngineerModel("PLANNER").model).toBe("gpt-5.6-terra");
    expect(resolveEngineerModel("DOCS").model).toBe("gpt-5.6-luna");
    expect(resolveEngineerModel("BUILDER", { terra: "pinned-terra" }).model).toBe("pinned-terra");
    expect(() => resolveEngineerModel("BUILDER", { terra: " " })).toThrow("must not be empty");
  });
});

describe("Phase 2 authoritative execution worker", () => {
  test("cleans an interrupted workspace and durably requeues from IMPLEMENTING", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "recovery.db") });
    const received = supervisor.receiveRequest({
      runId: "run-recovery", userId: "user-1",
      repository: { repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: repository.sha },
      request: "Change value",
    });
    const taskForRun = manifest(received.runId, repository.sha);
    const { manifestHash: _proposalHash, ...proposal } = taskForRun;
    const planReady = transitionToPlanReadyForTest({
      supervisor, received, normalizedRequest: proposal.request.normalized, manifest: proposal,
      key: "recovery", artifactRoot: join(root, "recovery-planning-artifacts"),
    });
    let run = supervisor.freezePlan({
      runId: planReady.runId, expectedStateVersion: planReady.stateVersion, manifest: proposal,
      actorId: "test-planner", idempotencyKey: "freeze-recovery",
    }).run;
    for (const nextState of ["QUEUED", "SANDBOX_COLD_PROVISIONING", "SANDBOX_PREFLIGHT", "SANDBOX_READY", "CONTEXT_BUILDING", "IMPLEMENTING"] as const) {
      run = supervisor.transition({
        runId: run.runId, expectedStateVersion: run.stateVersion, nextState,
        reasonCode: `TEST_${nextState}`, manifestHash: run.manifestHash,
        idempotencyKey: `recovery-state:${nextState}`,
      }).run;
    }
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(root, "recovery-workspaces"), gitSpawn: bunGitSpawn });
    const workspace = await workspaceManager.createAsync({ runId: run.runId, repositoryRoot: repository.path, baseCommitSha: repository.sha });
    supervisor.recordSandbox({
      sandboxId: "recovery-sandbox", runId: run.runId, workspaceIdentity: workspace.workspaceIdentity,
      imageReference: `oven/bun@sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}`,
      environmentDigest: `sha256:${"b".repeat(64)}`, networkPolicyVersion: "network-v1", sandboxPolicyVersion: "sandbox-v1",
      status: "READY", source: "COLD", createdAt: "2026-07-14T12:00:00.000Z", destroyedAt: null,
    });
    const artifactStore = new LocalArtifactStore({ root: join(root, "recovery-artifacts") });
    const imageDigest = `sha256:${"a".repeat(64)}`;
    const sandboxManager = new DockerSandboxManager({
      workspaceManager, imageReference: `oven/bun@sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}`,
      dockerRunAsync: async (args) => ({
        status: 0, signal: null,
        stdout: args[0] === "image" ? JSON.stringify([`oven/bun@${imageDigest}`]) : "",
        stderr: "",
      }),
    });
    writeFileSync(join(workspace.workspaceRoot, "src/value.ts"), "export const value = 99;\n");
    const staleContinuation: BuilderContinuation = {
      version: 1, runId: run.runId, manifestHash: taskForRun.manifestHash,
      workspaceIdentity: workspace.workspaceIdentity,
      inputContextHash: sha256(taskForRun.request.normalized), nextRound: 1,
      input: [{ type: "stale" }], responseIds: ["stale-response"], requestedCommands: [], commandExecutionIds: [],
      mutations: 1, successfulEvidenceMutation: -1, successfulEvidenceCommand: null, toolCallCount: 1,
      // The stale checkpoint deliberately matches the fresh workspace's empty
      // diff; workspace identity, not diff equality, must reject it.
      consecutiveNoProgressRounds: 0, candidateDiffHash: sha256(""), seenSemanticEvidence: [], failedCommands: [],
    };
    supervisor.recordArtifact(artifactStore.put({
      runId: run.runId, type: "BUILDER_CONTINUATION", bytes: JSON.stringify(staleContinuation),
      producerType: "SYSTEM", producerId: "engineer-builder-checkpoint", trusted: true,
    }));
    let modelRound = 0;
    const manager = new EngineerExecutionManager({
      supervisor, sandboxManager, artifactStore,
      repositoryRootFor: () => repository.path,
      transportForRun: async () => ({
        countInputTokens: async () => 10,
        create: async () => {
          modelRound += 1;
          return modelRound === 1
            ? { id: "fresh-write", output: [{ type: "function_call", call_id: "fresh-write-call", name: "write_file", arguments: JSON.stringify({ path: "src/value.ts", content: "export const value = 2;\n" }) }] }
            : { id: "fresh-test", output: [{ type: "function_call", call_id: "fresh-test-call", name: "run_command", arguments: JSON.stringify({ command: "bun run test" }) }] };
        },
      }),
    });
    expect(await manager.recoverInterrupted(run.runId, "expired-lease-1")).toBe("REQUEUED");
    expect(existsSync(workspace.workspaceRoot)).toBe(false);
    expect(supervisor.getRun(run.runId).state).toBe("QUEUED");
    expect(supervisor.listFailures(run.runId)).toMatchObject([{
      reasonCode: "WORKER_PROCESS_INTERRUPTED", retryable: true, evidenceIds: ["expired-lease-1"],
    }]);
    const audit = new Database(join(root, "recovery.db"), { readonly: true });
    expect(audit.query("SELECT status FROM sandboxes WHERE run_id = ?").get(run.runId)).toEqual({ status: "DESTROYED" });
    audit.close();
    const recoveredResult = await manager.runQueued(run.runId);
    expect(recoveredResult.changedFiles).toEqual(["src/value.ts"]);
    expect(recoveredResult.responseIds).toEqual(["fresh-write", "fresh-test"]);
    expect(supervisor.getRun(run.runId).state).toBe("FAST_CHECKS");
    expect(supervisor.listEvents(run.runId)).not.toContainEqual(expect.objectContaining({ reasonCode: "BUILDER_EXECUTION_FAILED" }));
    expect(await manager.recoverInterrupted(run.runId, "expired-lease-1")).toBe("IGNORED");
    supervisor.close();
  });

  test("moves a frozen run to FAST_CHECKS and persists executor artifacts", async () => {
    const root = temporaryRoot();
    const repository = initRepository(root);
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const received = supervisor.receiveRequest({
      runId: "run-worker",
      userId: "user-1",
      repository: {
        repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture",
        baseBranch: "main", baseCommitSha: repository.sha,
      },
      request: "Change value",
    });
    const taskForRun = manifest(received.runId, repository.sha);
    const { manifestHash: _proposalHash, ...proposalContent } = taskForRun;
    let run = transitionToPlanReadyForTest({
      supervisor,
      received,
      normalizedRequest: "Change src/value.ts to export value 2.",
      manifest: proposalContent,
      key: "worker",
      artifactRoot: join(root, "planning-artifacts"),
    });
    const frozen = supervisor.freezePlan({
      runId: run.runId,
      expectedStateVersion: run.stateVersion,
      manifest: (() => {
        const task = manifest(run.runId, repository.sha);
        const { manifestHash: _manifestHash, ...content } = task;
        return content;
      })(),
      actorId: "test-planner",
      idempotencyKey: "freeze-worker",
    }).run;
    expect(frozen.state).toBe("PLAN_FROZEN");

    const digest = `sha256:${"a".repeat(64)}`;
    const dockerSpawn = ((_: string, args: string[]) => {
      if (args[0] === "info") return { status: 0, stdout: "27", stderr: "" };
      if (args[0] === "image") return { status: 0, stdout: `[\"oven/bun@${digest}\"]`, stderr: "" };
      return { status: 0, stdout: "1 pass", stderr: "" };
    }) as typeof import("node:child_process").spawnSync;
    const workspaceManager = new GitWorkspaceManager({
      workspaceRoot: join(root, "workspaces"), gitSpawn: bunGitSpawn,
    });
    const sandboxManager = new DockerSandboxManager({
      workspaceManager, imageReference: `oven/bun@${digest}`, imageDigest: digest, dockerSpawn,
    });
    let response = 0;
    let transportMode: "normal" | "partial-budget" | "partial-timeout" | "recovered" = "normal";
    let budgetResponse = 0;
    let timeoutResponse = 0;
    const transport: ResponsesTransport = {
      async countInputTokens() { return 100; },
      async create() {
        if (transportMode === "partial-budget") {
          budgetResponse += 1;
          if (budgetResponse === 1) return {
            id: "worker-budget-partial", usage: { input_tokens: 100, output_tokens: 6_000 },
            output: [{ type: "function_call", call_id: "budget-write", name: "write_file", arguments: JSON.stringify({
              path: "src/value.ts", content: "export const value = 4;\n",
            }) }],
          };
          throw new Error("a second budget model request must be stopped before transport");
        }
        if (transportMode === "partial-timeout") {
          timeoutResponse += 1;
          if (timeoutResponse === 1) return {
            id: "worker-timeout-partial", usage: { input_tokens: 50, output_tokens: 25 },
            output: [{ type: "function_call", call_id: "timeout-write", name: "write_file", arguments: JSON.stringify({
              path: "src/value.ts", content: "export const value = 3;\n",
            }) }],
          };
          const error = new Error("Request timed out.");
          error.name = "APIConnectionTimeoutError";
          throw error;
        }
        if (transportMode === "recovered") return {
          id: "worker-recovered", usage: { input_tokens: 50, output_tokens: 10 }, output: [],
          output_text: "Recovered from the retained workspace checkpoint.",
        };
        response += 1;
        if (response === 1) throw new Error("transient provider failure");
        if (response === 2) return {
          id: "worker-response-1", usage: { input_tokens: 100, output_tokens: 100 },
          output: [{ type: "function_call", call_id: "write-1", name: "write_file", arguments: JSON.stringify({
            path: "src/value.ts", content: "export const value = 2;\n",
          }) }],
        };
        if (response === 3) return {
          id: "worker-response-2", usage: { input_tokens: 100, output_tokens: 100 },
          output: [{ type: "function_call", call_id: "command-1", name: "run_command", arguments: JSON.stringify({
            command: "bun run test",
          }) }],
        };
        return { id: "worker-response-3", usage: { input_tokens: 100, output_tokens: 100 }, output: [], output_text: "Implementation complete; executor evidence is separate." };
      },
    };
    const leaseManager = new EngineerWorkerLeaseManager({
      dbPath: join(root, "worker-leases.db"),
      tokenSecret: "a".repeat(64),
      maxConcurrentLeases: 1,
      recoverExpiredLease: () => undefined,
    });
    const artifactStore = new LocalArtifactStore({ root: join(root, "artifacts") });
    const createExecutionManager = () => new EngineerExecutionManager({
      supervisor, sandboxManager, artifactStore,
      repositoryRootFor: (repositoryId) => {
        expect(repositoryId).toBe("repo-1");
        return repository.path;
      },
      transportForRun: () => transport,
      leaseManager,
      workerOwnerId: "test-worker",
      leaseTtlMs: 30_000,
    });
    const loserReceived = supervisor.receiveRequest({
      runId: "run-worker-dispatch-loser", userId: "user-1",
      repository: {
        repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture",
        baseBranch: "main", baseCommitSha: repository.sha,
      },
      request: "Change value",
    });
    const loserTask = manifest(loserReceived.runId, repository.sha);
    const { manifestHash: _loserHash, ...loserProposal } = loserTask;
    const loserPlanReady = transitionToPlanReadyForTest({
      supervisor, received: loserReceived, normalizedRequest: loserProposal.request.normalized,
      manifest: loserProposal, key: "worker-dispatch-loser",
      artifactRoot: join(root, "planning-dispatch-loser-artifacts"),
    });
    const loserFrozen = supervisor.freezePlan({
      runId: loserPlanReady.runId, expectedStateVersion: loserPlanReady.stateVersion,
      manifest: loserProposal, actorId: "test-planner", idempotencyKey: "freeze-worker-dispatch-loser",
    }).run;
    const losingManager = createExecutionManager();
    const loserQueued = losingManager.enqueue(loserFrozen.runId);
    supervisor.claimBuilderDispatch({
      agentExecutionId: "durable-builder-winner", runId: loserFrozen.runId, role: "BUILDER",
      modelTier: "GPT-5.6_TERRA", status: "RUNNING",
      inputHash: sha256({
        manifestHash: loserQueued.manifestHash,
        purpose: "initial-builder-dispatch",
        dispatchStateVersion: loserQueued.stateVersion,
      }),
      outputArtifactId: null, startedAt: "2026-07-17T18:00:00.000Z", completedAt: null,
    });
    const durableBeforeClaimLoss = supervisor.exportRunRecords(loserFrozen.runId);
    const callsBeforeClaimLoss = response;
    await expect(losingManager.runQueued(loserFrozen.runId)).rejects.toThrow("owns the durable initial Builder dispatch");
    expect(response).toBe(callsBeforeClaimLoss);
    expect(supervisor.exportRunRecords(loserFrozen.runId)).toEqual(durableBeforeClaimLoss);
    expect(supervisor.getRun(loserFrozen.runId).state).toBe("QUEUED");
    expect(supervisor.listFailures(loserFrozen.runId)).toEqual([]);
    let manager = createExecutionManager();
    const result = await manager.execute(run.runId);
    expect(result.changedFiles).toEqual(["src/value.ts"]);
    expect(supervisor.getRun(run.runId).state).toBe("FAST_CHECKS");
    expect(leaseManager.listActive()).toHaveLength(0);
    const artifacts = supervisor.listArtifacts(run.runId);
    expect(artifacts.map((artifact) => artifact.type)).toContain("COMMAND_STDOUT");
    expect(artifacts.map((artifact) => artifact.type)).toContain("COMMAND_STDERR");
    expect(artifacts.map((artifact) => artifact.type)).toContain("BUILDER_RESULT");
    expect(artifacts.map((artifact) => artifact.type)).toContain("TEST_BASELINE_MANIFEST");
    expect(artifacts.map((artifact) => artifact.type)).toContain("TEST_INTEGRITY_COMPARISON");
    const auditDb = new Database(join(root, "engineer.db"), { readonly: true });
    // One deterministic base-command baseline is captured before paid Builder
    // work, followed by the Builder-authorized command itself.
    expect((auditDb.query("SELECT COUNT(*) AS count FROM command_executions").get() as { count: number }).count).toBe(2);
    expect((auditDb.query("SELECT COUNT(*) AS count FROM agent_executions WHERE run_id = ?").get(run.runId) as { count: number }).count).toBe(1);
    expect(auditDb.query(`SELECT d.agent_execution_id, d.model_tier, d.worker_owner_id, d.worker_fencing_token,
      a.status, a.output_artifact_id FROM builder_dispatch_claims d
      JOIN agent_executions a ON a.id = d.agent_execution_id AND a.run_id = d.run_id
      WHERE d.run_id = ?`).all(run.runId)).toEqual([{
        agent_execution_id: expect.any(String), model_tier: "GPT-5.6_TERRA",
        worker_owner_id: "test-worker", worker_fencing_token: expect.any(Number),
        status: "SUCCEEDED", output_artifact_id: expect.any(String),
      }]);
    expect(auditDb.query("SELECT status, retry_count, budget_reservation_id FROM model_calls ORDER BY rowid").all()).toEqual([
      { status: "FAILED", retry_count: 0, budget_reservation_id: expect.any(String) },
      { status: "SUCCEEDED", retry_count: 1, budget_reservation_id: expect.any(String) },
      { status: "SUCCEEDED", retry_count: 0, budget_reservation_id: expect.any(String) },
    ]);
    expect((auditDb.query("SELECT COUNT(*) AS count FROM cost_records WHERE source_type = 'MODEL_RESERVATION'").get() as { count: number }).count).toBe(1);
    expect(auditDb.query("SELECT reservation_status FROM cost_records WHERE source_type = 'MODEL_RESERVATION'").get()).toEqual({
      reservation_status: "AMBIGUOUS_PROVIDER_OUTCOME",
    });
    expect(supervisor.getBudget(run.runId).ambiguous).toMatchObject({ tokens: expect.any(Number), costUsd: expect.any(Number) });
    expect(supervisor.getBudget(run.runId).ambiguous.tokens).toBeGreaterThan(0);
    auditDb.close();

    const budgetReceived = supervisor.receiveRequest({
      runId: "run-worker-budget-stop", userId: "user-1",
      repository: {
        repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture",
        baseBranch: "main", baseCommitSha: repository.sha,
      },
      request: "Change value",
    });
    const budgetTask = manifest(budgetReceived.runId, repository.sha, { tokenBudget: 7_000 });
    const { manifestHash: _budgetProposalHash, ...budgetProposalContent } = budgetTask;
    const budgetPlanReady = transitionToPlanReadyForTest({
      supervisor, received: budgetReceived,
      normalizedRequest: budgetProposalContent.request.normalized,
      manifest: budgetProposalContent,
      key: "worker-budget-stop",
      artifactRoot: join(root, "planning-budget-artifacts"),
    });
    const budgetFrozen = supervisor.freezePlan({
      runId: budgetPlanReady.runId,
      expectedStateVersion: budgetPlanReady.stateVersion,
      manifest: budgetProposalContent,
      actorId: "test-planner",
      idempotencyKey: "freeze-worker-budget-stop",
    }).run;
    expect(budgetFrozen.state).toBe("PLAN_FROZEN");
    transportMode = "partial-budget";
    await expect(manager.execute(budgetFrozen.runId)).rejects.toThrow("paused safely");
    expect(supervisor.getRun(budgetFrozen.runId).state).toBe("PAUSED_BUDGET");
    expect(supervisor.listEvents(budgetFrozen.runId)).toContainEqual(expect.objectContaining({
      nextState: "PAUSED_BUDGET", reasonCode: "TOKEN_LIMIT_REACHED",
    }));
    expect(supervisor.listFailures(budgetFrozen.runId)).toEqual([]);
    expect(supervisor.exportRunRecords(budgetFrozen.runId).agent_executions).toMatchObject([{ status: "PAUSED" }]);
    const pausedDiff = await workspaceManager.diffAsync(manager.getSandbox(budgetFrozen.runId)!.workspace);
    expect(pausedDiff).toContain("value = 4");
    manager.destroyAll({ preserveResumable: true });
    expect(manager.getSandbox(run.runId)).toBeNull();
    expect(manager.getSandbox(budgetFrozen.runId)).not.toBeNull();
    manager = createExecutionManager();
    const pausedRun = supervisor.getRun(budgetFrozen.runId);
    const pausedBudget = supervisor.getBudget(budgetFrozen.runId);
    const toppedBudget = supervisor.topUpBudget({
      runId: budgetFrozen.runId, expectedRevision: pausedBudget.revision,
      topUp: { addTokenBudget: 100_000, addCostBudgetUsd: 1, addTimeBudgetSeconds: 60 },
      actorId: "user-1", idempotencyKey: "worker-budget-top-up",
    });
    supervisor.resumeBudget({
      runId: budgetFrozen.runId, expectedStateVersion: pausedRun.stateVersion,
      expectedBudgetRevision: toppedBudget.revision, actorId: "user-1", idempotencyKey: "worker-budget-resume",
    });
    expect((await manager.resumeBudgetCheckpoint(budgetFrozen.runId)).state).toBe("QUEUED");
    expect(await workspaceManager.diffAsync(manager.getSandbox(budgetFrozen.runId)!.workspace)).toBe(pausedDiff);
    transportMode = "recovered";
    await manager.runQueued(budgetFrozen.runId);
    expect(supervisor.getRun(budgetFrozen.runId).state).toBe("FAST_CHECKS");
    expect((supervisor.exportRunRecords(budgetFrozen.runId).agent_executions ?? []).map((agent) => agent.status)).toEqual(["PAUSED", "SUCCEEDED"]);

    const timeoutReceived = supervisor.receiveRequest({
      runId: "run-worker-provider-timeout", userId: "user-1",
      repository: {
        repositoryId: "repo-1", provider: "local", owner: "local", name: "fixture",
        baseBranch: "main", baseCommitSha: repository.sha,
      },
      request: "Change value",
    });
    const timeoutTask = manifest(timeoutReceived.runId, repository.sha);
    const { manifestHash: _timeoutHash, ...timeoutContent } = timeoutTask;
    const timeoutPlanReady = transitionToPlanReadyForTest({
      supervisor, received: timeoutReceived, normalizedRequest: timeoutContent.request.normalized,
      manifest: timeoutContent, key: "worker-provider-timeout", artifactRoot: join(root, "planning-timeout-artifacts"),
    });
    const timeoutFrozen = supervisor.freezePlan({
      runId: timeoutPlanReady.runId, expectedStateVersion: timeoutPlanReady.stateVersion,
      manifest: timeoutContent, actorId: "test-planner", idempotencyKey: "freeze-worker-provider-timeout",
    }).run;
    transportMode = "partial-timeout";
    await expect(manager.execute(timeoutFrozen.runId)).rejects.toThrow("Request timed out");
    expect(supervisor.getRun(timeoutFrozen.runId).state).toBe("MODEL_PROVIDER_RETRY_PENDING");
    expect(await workspaceManager.diffAsync(manager.getSandbox(timeoutFrozen.runId)!.workspace)).toContain("value = 3");
    expect(supervisor.listFailures(timeoutFrozen.runId)).toContainEqual(expect.objectContaining({
      failureClass: "MODEL_FAILURE", reasonCode: "MODEL_PROVIDER_TIMEOUT", retryable: true,
    }));
    const timeoutBudget = supervisor.getBudget(timeoutFrozen.runId);
    expect(timeoutBudget.used.costUsd).toBeGreaterThan(0);
    expect(timeoutBudget.reserved.costUsd).toBeGreaterThan(0);
    const timeoutAudit = new Database(join(root, "engineer.db"), { readonly: true });
    expect((timeoutAudit.query("SELECT COUNT(*) AS count FROM model_calls WHERE run_id = ? AND status = 'FAILED'")
      .get(timeoutFrozen.runId) as { count: number }).count).toBe(1);
    timeoutAudit.close();

    const timeoutDiff = await workspaceManager.diffAsync(manager.getSandbox(timeoutFrozen.runId)!.workspace);
    expect(timeoutDiff).toContain("value = 3");
    manager.destroyAll({ preserveResumable: true });
    expect(manager.getSandbox(budgetFrozen.runId)).toBeNull();
    expect(manager.getSandbox(timeoutFrozen.runId)).not.toBeNull();
    manager = createExecutionManager();
    transportMode = "recovered";
    expect((await manager.retryProviderTimeout(timeoutFrozen.runId)).state).toBe("QUEUED");
    expect(await workspaceManager.diffAsync(manager.getSandbox(timeoutFrozen.runId)!.workspace)).toBe(timeoutDiff);
    await manager.runQueued(timeoutFrozen.runId);
    expect(supervisor.getRun(timeoutFrozen.runId).state).toBe("FAST_CHECKS");
    expect(supervisor.listEvents(timeoutFrozen.runId)).toContainEqual(expect.objectContaining({
      nextState: "SANDBOX_READY", reasonCode: "RETAINED_WORKSPACE_CHECKPOINT_REUSED",
    }));

    expect(manager.destroy(timeoutFrozen.runId)?.status).toBe("DESTROYED");
    leaseManager.close();
    supervisor.close();
  });
});
