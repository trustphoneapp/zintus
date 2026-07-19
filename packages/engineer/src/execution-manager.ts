import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BuilderResultSchema,
  ModelCallRecordSchema,
  SandboxWorkspaceCheckpointSchema,
  type ArtifactRecord,
  type BuilderResult,
  type ModelCallRecord,
  type SandboxRecord,
} from "./execution-contracts.js";
import type { LocalArtifactStore } from "./artifact-store.js";
import type { CodexBuilderOptions, ResponsesTransport } from "./codex-builder.js";
import { builderInputContextHash, BuilderContinuationSchema, BuilderNoProgressError, CODEX_BUILDER_PROMPT_VERSION, CodexBuilder, isProviderModelTimeout } from "./codex-builder.js";
import type { ISandbox, ProvisionedSandbox } from "./sandbox-manager.js";
import type { EngineerSupervisor } from "./supervisor.js";
import { TrustedCommandExecutor } from "./trusted-executor.js";
import { resolveEngineerModel } from "./model-routing.js";
import { canonicalJson,compareCodeUnits,sha256, sha256Bytes } from "./hash.js";
import { FailureRecordSchema } from "./control-contracts.js";
import { executionFailureDomain, operationalFailurePolicy } from "./failure-policy.js";
import { isWorkerAuthorityLoss, type EngineerWorkerLeaseManager, type WorkerLeaseGrant } from "./worker-lease.js";
import { RuntimeBudgetExhaustedError } from "./runtime-budget.js";
import { canTransition } from "./state-machine.js";
import { TestIntegrityGuard, TestIntegrityViolationError } from "./test-integrity.js";
import { TestIntegrityComparisonSchema } from "./test-integrity.js";
import { BudgetPausedError, BuilderModelCallLimitError, HardeningGenericOperationForbiddenError,
  HardeningPromptCacheAuthorityUnavailableError } from "./errors.js";
import { CorrectedRunDirectiveSchema, type SafeCorrectionAction } from "./corrected-run.js";
import { createSignedHardeningSeedAttestation, type SignedHardeningSeedAttestation } from "./hardening-start-contracts.js";
import type { OptionalHardeningStartPreparation } from "./ledger.js";
import type { CheckpointAttestor } from "./verified-candidate-checkpoint.js";
import { workspaceLockfileHash } from "./warm-sandbox-pool.js";
import { OptionalHardeningIndependentCheckpointSchema,OptionalHardeningReviewInputAuthoritySchema,
  resolveHardeningArtifactAuthority,validateOptionalHardeningCheckpointChain } from
  "./hardening-verification-recovery.js";

const PHASE2_RECOVERABLE_STATES = new Set([
  "SANDBOX_WARM_CLAIMING", "SANDBOX_WARM_VALIDATING", "SANDBOX_WARM_CLAIMED",
  "SANDBOX_COLD_PROVISIONING", "SANDBOX_PREWARM_INVALID", "SANDBOX_PROVISIONING",
  "SANDBOX_PREFLIGHT", "SANDBOX_READY", "CONTEXT_BUILDING", "IMPLEMENTING",
]);
const GRACEFUL_DRAIN_RESUMABLE_STATES = new Set(["PAUSED_BUDGET", "MODEL_PROVIDER_RETRY_PENDING"]);

const RecoveryHashSchema=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const RecoveryStageSchema=z.enum(["SEED","BUILDER","INDEPENDENT"]);
const RecoveryStateSchema=z.enum(["REQUEST_RECEIVED","REQUEST_NORMALIZED","PLANNING","PLAN_READY","PLAN_FROZEN","QUEUED",
  "FAST_CHECKS","UNIT_TESTING","INTEGRATION_TESTING","E2E_TESTING","FLAKE_QUARANTINE","SECURITY_REVIEW",
  "VERIFICATION_RECOVERY","CODE_REVIEW","EVIDENCE_SYNTHESIS","REVIEWING"]);
const OptionalHardeningWorkspaceRecoveryAttestationSchema=z.object({
  version:z.literal(1),policyVersion:z.literal("engineer-optional-hardening-workspace-recovery-v1"),runId:z.string().min(1),
  authorityHash:RecoveryHashSchema,state:RecoveryStateSchema,stateVersion:z.number().int().nonnegative(),stage:RecoveryStageSchema,
  seedCheckpointArtifactId:z.string().min(1),seedCheckpointArtifactHash:RecoveryHashSchema,checkpointHash:RecoveryHashSchema,
  sandboxId:z.string().min(1),workspaceIdentity:z.string().min(1),resetToHead:z.literal(false),
  headCommitSha:z.string().regex(/^[a-f0-9]{40,64}$/i),treeHash:RecoveryHashSchema,diffHash:RecoveryHashSchema,
  dependencyHash:RecoveryHashSchema,lease:z.object({leaseId:z.string().min(1),ownerId:z.string().min(1),
    fencingToken:z.number().int().safe().positive()}).strict(),
}).strict().superRefine((value,context)=>{
  const seedStates=new Set(["REQUEST_RECEIVED","REQUEST_NORMALIZED","PLANNING","PLAN_READY","PLAN_FROZEN","QUEUED"]),
    builderStates=new Set(["FAST_CHECKS","UNIT_TESTING","INTEGRATION_TESTING","E2E_TESTING","FLAKE_QUARANTINE",
      "SECURITY_REVIEW","VERIFICATION_RECOVERY"]),
    independentStates=new Set(["SECURITY_REVIEW","VERIFICATION_RECOVERY","CODE_REVIEW","EVIDENCE_SYNTHESIS","REVIEWING"]);
  const allowed=value.stage==="SEED"?seedStates:value.stage==="BUILDER"?builderStates:independentStates;
  if(!allowed.has(value.state))context.addIssue({code:"custom",path:["state"],message:"state is incompatible with recovery stage"});
});

class BuilderDispatchClaimLostError extends Error {
  constructor(runId: string) {
    super(`another worker owns the durable initial Builder dispatch for ${runId}`);
    this.name = "BuilderDispatchClaimLostError";
  }
}

export interface SandboxCleanupOptions {
  /** Retain exact local workspaces/checkpoints that require an explicit human resume or retry. */
  preserveResumable?: boolean;
}

export interface EngineerExecutionManagerOptions {
  supervisor: EngineerSupervisor;
  sandboxManager: ISandbox;
  artifactStore: LocalArtifactStore;
  repositoryRootFor: (repositoryId: string) => string;
  transportForRun: (runId: string) => ResponsesTransport | Promise<ResponsesTransport>;
  now?: () => Date;
  idFactory?: () => string;
  builderOptions?: Pick<CodexBuilderOptions, "modelConfiguration" | "maxRounds" | "retryDelayMs">;
  leaseManager?: EngineerWorkerLeaseManager;
  workerOwnerId?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  safetyIdentifierForUser?: (userId: string) => string;
  /** Dedicated server-only prompt-cache key; distinct from identity and lease secrets. */
  hardeningPromptCacheSecret?: string;
  /** Adversarial seam after one full Builder authority read and before its paid-boundary recheck. */
  afterHardeningBuilderAuthorityCheckedForTest?:(stage:"BEFORE_RESERVATION"|"BEFORE_DISPATCH")=>void;
}

export type OptionalHardeningWorkspaceRecoverySnapshot={
  runId:string;state:string;stateVersion:number;authorityHash:string;
  preparation:OptionalHardeningStartPreparation;
  stage:
    |{kind:"SEED"}
    |{kind:"BUILDER";result:BuilderResult;artifactId:string;artifactHash:string;agentExecutionId:string;
      reservationId:string;successorEventId:string;expectedHeadCommitSha:string;commandAuthorityHash:string;
      checkpointAuthorityHash:string;finalizationId:string}
    |{kind:"INDEPENDENT";diff:string;diffHash:string;resultCommitSha:string;checkpointArtifactId:string;
      checkpointArtifactHash:string;diffArtifactId:string;diffArtifactHash:string;selectedEventId:string;
      checkpointHash:string;successorEventId:string|null;checkpointAuthorityHash:string;
      classified:null|{reviewerSessionId:string;classificationHash:string;agentExecutionId:string;reservationId:string;
        finalizationId:string;footprintHash:string}};
};

/** Phase-2 worker: one Builder per run, deterministic state promotions, durable evidence records. */
export class EngineerExecutionManager {
  private readonly options: EngineerExecutionManagerOptions;
  private readonly active = new Map<string, Promise<BuilderResult>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly cancelling = new Set<string>();
  private readonly cancellationAuthorityRevocations = new Map<string, () => void>();
  private readonly sandboxes = new Map<string, ProvisionedSandbox>();
  private readonly pendingHardeningSeeds = new Map<string, ProvisionedSandbox>();
  private readonly pendingHardeningAuthorities = new Map<string, {
    preparation: OptionalHardeningStartPreparation;
    signedSeed: SignedHardeningSeedAttestation;
  }>();
  private readonly hardeningAuthorities = new Map<string, {
    preparation:OptionalHardeningStartPreparation;signedSeed:SignedHardeningSeedAttestation;
  }>();
  private readonly hardeningRecoveryAuthority = new Map<string,{authorityHash:string;stateVersion:number}>();
  private readonly hardeningRecoveryTokens = new Map<string, string>();

  private recoverHardeningPaidCallLifecycleIfUnowned(runId:string):void{
    if(!this.options.supervisor.isOptionalHardeningChild(runId))return;
    if(!this.options.hardeningPromptCacheSecret)return;
    if(!this.options.supervisor.hasOutstandingHardeningPaidCallRecoveryWork(runId))return;
    const leaseManager=this.options.leaseManager;if(!leaseManager)return;
    const ownerId=`${this.options.workerOwnerId??"engineer-execution-worker"}:paid-call-recovery`;
    let lease:WorkerLeaseGrant;
    try{lease=leaseManager.acquire({resourceKey:`run:${runId}`,ownerId,ttlMs:this.options.leaseTtlMs??30_000,
      idempotencyKey:`paid-recovery:${randomUUID()}`});}
    catch(error){if(error instanceof Error&&["WorkerLeaseConflictError","WorkerLeaseCapacityError"].includes(error.name))return;throw error;}
    const nowMs=(this.options.now??(()=>new Date()))().getTime();
    let primaryError:unknown;
    try{
      let rawToken=this.hardeningRecoveryTokens.get(runId);
      if(!rawToken){rawToken=randomUUID();this.hardeningRecoveryTokens.set(runId,rawToken);}
      this.options.supervisor.recoverHardeningPaidCallLifecycle({childRunId:runId,ownerId,rawToken,nowMs,
        recoveryWorkerLease:{leaseId:lease.lease.leaseId,ownerId,fencingToken:lease.lease.fencingToken,
          leaseToken:lease.leaseToken}});
    }catch(error){primaryError=error;throw error;
    }finally{
      try{leaseManager.release({leaseId:lease.lease.leaseId,ownerId,fencingToken:lease.lease.fencingToken,
        leaseToken:lease.leaseToken,idempotencyKey:"paid-recovery-release"});}
      catch(releaseError){
        if(primaryError===undefined)throw releaseError;
        if(primaryError instanceof Error)Object.defineProperty(primaryError,"recoveryLeaseReleaseFailed",{value:true,enumerable:false});
      }
    }
  }

  hasOptionalHardeningAuthority(runId:string):boolean{
    if(!this.options.supervisor.isOptionalHardeningChild(runId))return true;
    const authority=this.hardeningAuthorities.get(runId);
    return Boolean(this.options.hardeningPromptCacheSecret&&authority&&authority.signedSeed.attestation.childRunId===runId);
  }

  assertOptionalHardeningPromptAuthority(runId:string):void{
    if(!this.options.supervisor.isOptionalHardeningChild(runId))return;
    if(!this.options.hardeningPromptCacheSecret)throw new HardeningPromptCacheAuthorityUnavailableError();
    const authority=this.hardeningAuthorities.get(runId);
    if(!authority||authority.signedSeed.attestation.childRunId!==runId)throw new HardeningGenericOperationForbiddenError();
  }

  async materializeOptionalHardeningSeed(preparation:OptionalHardeningStartPreparation,signer:CheckpointAttestor):Promise<SignedHardeningSeedAttestation>{
    const runId=preparation.operation.childRunId;if(preparation.replay&&!preparation.signedSeed)throw new Error("replayed hardening start lacks seed authority");
    if(this.sandboxes.has(runId)||this.pendingHardeningSeeds.has(runId))throw new Error("hardening seed sandbox already exists");
    const repositoryRoot=this.options.repositoryRootFor(preparation.lineage.repositoryId);let provisioned:ProvisionedSandbox|null=null;
    try{provisioned=await this.options.sandboxManager.provisionColdAsync({runId,repositoryRoot,baseCommitSha:preparation.seed.baseCommitSha});
      if(provisioned.record.source!=="COLD"||provisioned.record.status!=="READY")throw new Error("hardening seed requires a fresh cold sandbox");
      if(provisioned.record.environmentDigest!==preparation.seed.environmentDigest)throw new Error("hardening seed environment differs from parent verified candidate");
      const materialized=this.options.sandboxManager.workspaceManager().materializeVerifiedSeed(provisioned.workspace,{baseCommitSha:preparation.seed.baseCommitSha,
        seedResultCommitSha:preparation.seed.seedResultCommitSha,finalDiff:preparation.seed.finalDiff,diffHash:preparation.seed.diffHash});
      const dependencyHash=workspaceLockfileHash(provisioned.workspace.workspaceRoot);const signed=await createSignedHardeningSeedAttestation({schemaVersion:1,
        policyVersion:"engineer-hardening-seed-attestation-v1",attestationType:"HARDENING_SEED_VERIFIED",operationId:preparation.operation.operationId,
        operationHash:preparation.operation.operationHash,rootRunId:preparation.lineage.rootRunId,parentRunId:preparation.lineage.parentRunId,childRunId:runId,
        requesterUserId:preparation.lineage.requesterUserId,repositoryId:preparation.lineage.repositoryId,lineageId:preparation.lineage.lineageId,
        lineageHash:preparation.lineage.lineageHash,parentCheckpointId:preparation.parentCheckpoint.checkpointId,
        parentCheckpointHash:preparation.parentCheckpoint.checkpointHash,baseCommitSha:preparation.seed.baseCommitSha,
        seedResultCommitSha:materialized.headCommitSha,seedTreeHash:materialized.treeHash,seedDiffHash:materialized.diffHash,
        imageDigest:provisioned.record.imageDigest,environmentDigest:provisioned.record.environmentDigest,dependencyHash,
        createdAt:preparation.operation.createdAt},signer);
      if(preparation.replay&&JSON.stringify(signed.attestation)!==JSON.stringify(preparation.signedSeed!.attestation))throw new Error("reconstructed hardening seed differs from durable authority");
      const signedAuthority=preparation.replay?preparation.signedSeed!:signed;
      this.pendingHardeningSeeds.set(runId,provisioned);
      this.pendingHardeningAuthorities.set(runId,{preparation,signedSeed:signedAuthority});
      return signedAuthority;
    }catch(error){if(provisioned)await this.options.sandboxManager.destroyAsync(provisioned).catch(()=>undefined);throw error;}
  }

  prepareOptionalHardeningSeedCommit(runId:string,manifestHash:string):{sandbox:SandboxRecord;checkpoint:ArtifactRecord}{const sandbox=this.pendingHardeningSeeds.get(runId);if(!sandbox)throw new Error("hardening seed sandbox is not pending");
    const authority=this.pendingHardeningAuthorities.get(runId);if(!authority)throw new Error("hardening seed authority is not pending");
    if(!manifestHash)throw new Error("hardening seed commit requires the deterministic manifest identity");
    return {sandbox:sandbox.record,checkpoint:this.sandboxCheckpointArtifact(manifestHash,sandbox,authority.signedSeed)};
  }

  completeOptionalHardeningSeedCommit(runId:string):SandboxRecord{const sandbox=this.pendingHardeningSeeds.get(runId);if(!sandbox)throw new Error("hardening seed sandbox is not pending");
    const authority=this.pendingHardeningAuthorities.get(runId);if(!authority)throw new Error("hardening seed authority is not pending");
    this.pendingHardeningSeeds.delete(runId);
    this.pendingHardeningAuthorities.delete(runId);this.hardeningAuthorities.set(runId,authority);
    this.sandboxes.set(runId,sandbox);return sandbox.record;}

  /** Reuse exactly one durable seeded sandbox after a crash; never provision beside it. */
  async recoverOptionalHardeningSeed(preparation:OptionalHardeningStartPreparation):Promise<boolean>{
    const runId=preparation.operation.childRunId;if(!preparation.replay||!preparation.signedSeed)throw new Error("hardening seed recovery requires durable authority");
    if(this.sandboxes.has(runId)||this.pendingHardeningSeeds.has(runId))throw new Error("hardening seed sandbox already exists");
    const rows=this.options.supervisor.exportRunRecords(runId).sandboxes??[];
    const artifacts=this.options.supervisor.listArtifacts(runId).filter((artifact)=>artifact.type==="SANDBOX_WORKSPACE_CHECKPOINT"&&artifact.trusted&&
      artifact.producerType==="SYSTEM"&&artifact.producerId==="engineer-execution-manager");
    if(rows.length===0&&artifacts.length===0)return false;
    if(rows.length!==1)throw new Error("hardening seed recovery requires exactly one durable sandbox checkpoint");
    const checkpoints=artifacts.map((artifact)=>SandboxWorkspaceCheckpointSchema.parse(
      JSON.parse(this.options.artifactStore.readVerifiedExact(artifact).toString("utf8"))))
      .filter((checkpoint)=>checkpoint.checkpointVersion===2);
    if(checkpoints.length!==1)throw new Error("hardening seed recovery requires exactly one durable v2 seed checkpoint");
    const run=this.options.supervisor.getRun(runId);if(!run.manifestHash)
      throw new Error("hardening seed checkpoint does not match the frozen child manifest");
    const checkpoint=checkpoints[0]!;
    if(checkpoint.runId!==runId||checkpoint.manifestHash!==run.manifestHash)
      throw new Error("hardening seed checkpoint does not match the frozen child manifest");
    if(checkpoint.hardeningLineageId!==preparation.lineage.lineageId||
      checkpoint.hardeningLineageHash!==preparation.lineage.lineageHash||
      checkpoint.seedAttestationId!==preparation.signedSeed.attestation.seedAttestationId||
      checkpoint.seedAttestationHash!==preparation.signedSeed.attestation.seedAttestationHash)
      throw new Error("hardening seed checkpoint is not bound to the durable lineage and seed authority");
    const row=rows[0]!;const record=checkpoint.sandbox;
    if(row.id!==record.sandboxId||row.run_id!==record.runId||row.workspace_identity!==record.workspaceIdentity||row.image_digest!==record.imageDigest||
      row.environment_digest!==record.environmentDigest||row.status!==record.status||row.created_at!==record.createdAt||row.destroyed_at!==record.destroyedAt||
      record.status!=="READY"||record.destroyedAt!==null||record.source!=="COLD")throw new Error("durable hardening seed sandbox projection is invalid");
    const seed=preparation.signedSeed.attestation;if(seed.childRunId!==runId||seed.lineageId!==preparation.lineage.lineageId||
      seed.lineageHash!==preparation.lineage.lineageHash||seed.imageDigest!==record.imageDigest||seed.environmentDigest!==record.environmentDigest)
      throw new Error("durable hardening seed sandbox does not match signed seed authority");
    const recovered=await this.options.sandboxManager.recoverAsync({workspace:checkpoint.workspace,sandbox:record,resetToHead:false});
    const materialized=this.options.sandboxManager.workspaceManager().verifyMaterializedSeed(recovered.workspace,{baseCommitSha:preparation.seed.baseCommitSha,
      seedResultCommitSha:preparation.seed.seedResultCommitSha,finalDiff:preparation.seed.finalDiff,diffHash:preparation.seed.diffHash});
    if(materialized.treeHash!==seed.seedTreeHash||materialized.diffHash!==seed.seedDiffHash||
      workspaceLockfileHash(recovered.workspace.workspaceRoot)!==seed.dependencyHash)throw new Error("recovered hardening seed workspace differs from signed authority");
    this.hardeningAuthorities.set(runId,{preparation,signedSeed:preparation.signedSeed});this.sandboxes.set(runId,recovered);return true;
  }

  private durableOptionalHardeningSeedAuthority(preparation:OptionalHardeningStartPreparation){
    const runId=preparation.operation.childRunId,signedSeed=preparation.signedSeed;
    if(!signedSeed)throw new HardeningGenericOperationForbiddenError();
    const run=this.options.supervisor.getRun(runId),manifest=this.options.supervisor.getManifest(runId);
    if(!run.manifestHash||!manifest||manifest.manifestHash!==run.manifestHash)throw new HardeningGenericOperationForbiddenError();
    const claim=this.options.supervisor.getFinalizedOptionalHardeningStartClaim(runId);
    if(!claim||!claim.sandboxId||claim.finalizedOperationId!==preparation.operation.operationId||
      claim.finalizedOperationHash!==preparation.operation.operationHash||
      claim.seedAttestationId!==signedSeed.attestation.seedAttestationId||
      claim.seedAttestationHash!==signedSeed.attestation.seedAttestationHash)throw new HardeningGenericOperationForbiddenError();
    const rows=this.options.supervisor.exportRunRecords(runId).sandboxes??[];
    if(rows.length!==1||rows[0]!.id!==claim.sandboxId)throw new HardeningGenericOperationForbiddenError();
    const artifacts=this.options.supervisor.listArtifacts(runId).filter((artifact)=>artifact.type==="SANDBOX_WORKSPACE_CHECKPOINT"&&
      artifact.trusted&&artifact.producerType==="SYSTEM"&&artifact.producerId==="engineer-execution-manager");
    const candidates=artifacts.flatMap((artifact)=>{
      const checkpoint=SandboxWorkspaceCheckpointSchema.parse(JSON.parse(this.options.artifactStore.readVerifiedExact(artifact).toString("utf8")));
      return checkpoint.checkpointVersion===2?[{artifact,checkpoint}]:[];
    });
    if(candidates.length!==1)throw new HardeningGenericOperationForbiddenError();
    const {artifact,checkpoint}=candidates[0]!;
    if(checkpoint.runId!==runId||checkpoint.manifestHash!==run.manifestHash||checkpoint.sandbox.sandboxId!==claim.sandboxId||
      checkpoint.workspace.runId!==runId||checkpoint.sandbox.runId!==runId||
      checkpoint.hardeningLineageId!==preparation.lineage.lineageId||
      checkpoint.hardeningLineageHash!==preparation.lineage.lineageHash||
      checkpoint.seedAttestationId!==signedSeed.attestation.seedAttestationId||
      checkpoint.seedAttestationHash!==signedSeed.attestation.seedAttestationHash)throw new HardeningGenericOperationForbiddenError();
    const row=rows[0]!,record=checkpoint.sandbox;
    if(row.id!==record.sandboxId||row.run_id!==record.runId||row.workspace_identity!==record.workspaceIdentity||
      row.image_digest!==record.imageDigest||row.environment_digest!==record.environmentDigest||row.status!==record.status||
      row.created_at!==record.createdAt||row.destroyed_at!==record.destroyedAt||record.status!=="READY"||record.destroyedAt!==null||
      record.source!=="COLD"||signedSeed.attestation.imageDigest!==record.imageDigest||
      signedSeed.attestation.environmentDigest!==record.environmentDigest)throw new HardeningGenericOperationForbiddenError();
    const authorityHash=sha256({namespace:"engineer-optional-hardening-workspace-recovery-v1",runId,
      state:run.state,stateVersion:run.stateVersion,manifestHash:run.manifestHash,operationId:preparation.operation.operationId,
      operationHash:preparation.operation.operationHash,lineageId:preparation.lineage.lineageId,
      lineageHash:preparation.lineage.lineageHash,seedAttestationId:signedSeed.attestation.seedAttestationId,
      seedAttestationHash:signedSeed.attestation.seedAttestationHash,claimId:claim.claimId,sandboxId:claim.sandboxId,
      checkpointHash:checkpoint.checkpointHash,checkpointArtifactId:artifact.artifactId,checkpointArtifactHash:artifact.sha256});
    return {run,manifest,claim,row,artifact,checkpoint,signedSeed,authorityHash};
  }

  private exactHardeningBuilderResult(runId:string,runStateVersion:number,seedResultCommitSha:string,sandboxId:string,environmentDigest:string){
    const records=this.options.supervisor.exportRunRecords(runId),run=this.options.supervisor.getRun(runId);
    if(!run.manifestHash)throw new HardeningGenericOperationForbiddenError();
    const allAgents=(records.agent_executions??[]).filter((row)=>row.run_id===runId&&row.role==="BUILDER"),
      agents=allAgents.filter((row)=>row.status==="SUCCEEDED");
    if(allAgents.length!==1||agents.length!==1)throw new HardeningGenericOperationForbiddenError();
    const agent=agents[0]!,artifactId=String(agent.output_artifact_id??"");
    const allReservations=(records.hardening_child_model_reservations??[]).filter((row)=>row.child_run_id===runId&&row.role==="BUILDER"),
      reservations=allReservations.filter((row)=>row.agent_execution_id===agent.id&&row.status==="SETTLED");
    if(allReservations.length!==1||reservations.length!==1)throw new HardeningGenericOperationForbiddenError();
    const reservation=reservations[0]!,expectedState=String(reservation.expected_run_state),
      expectedVersion=Number(reservation.expected_state_version);
    if(!this.options.supervisor.hasExactHardeningBuilderSuccessor({childRunId:runId,reservationId:String(reservation.id),
      agentExecutionId:String(agent.id),expectedRunState:expectedState,expectedStateVersion:expectedVersion})||
      expectedVersion+1>runStateVersion)throw new HardeningGenericOperationForbiddenError();
    const matches=this.options.supervisor.listArtifacts(runId).filter((item)=>item.artifactId===artifactId&&item.type==="BUILDER_RESULT"&&
      item.producerType==="SYSTEM"&&item.producerId==="codex-builder-adapter"&&!item.trusted);
    if(matches.length!==1)throw new HardeningGenericOperationForbiddenError();
    const result=BuilderResultSchema.parse(JSON.parse(this.options.artifactStore.readVerifiedExact(matches[0]!).toString("utf8")));
    if(new Set(result.commandExecutionIds).size!==result.commandExecutionIds.length)throw new HardeningGenericOperationForbiddenError();
    const allCommandRows=(records.command_executions??[]).filter((row)=>row.run_id===runId);
    if(allCommandRows.length!==result.commandExecutionIds.length)throw new HardeningGenericOperationForbiddenError();
    const commandRows=result.commandExecutionIds.map((id)=>{
      const matches=allCommandRows.filter((row)=>row.id===id);
      const startedAt=Date.parse(String(matches[0]?.started_at)),finishedAt=Date.parse(String(matches[0]?.finished_at));
      if(matches.length!==1||matches[0]!.sandbox_id!==sandboxId||matches[0]!.environment_digest!==environmentDigest||
        typeof matches[0]!.commit_sha!=="string"||!/^[a-f0-9]{40,64}$/i.test(String(matches[0]!.commit_sha))||
        typeof matches[0]!.executor_id!=="string"||!matches[0]!.executor_id||typeof matches[0]!.finished_at!=="string"||
        !Number.isFinite(startedAt)||!Number.isFinite(finishedAt)||finishedAt<startedAt)
        throw new HardeningGenericOperationForbiddenError();
      return matches[0]!;
    });
    for(let index=1;index<commandRows.length;index++){
      const previous=commandRows[index-1]!,current=commandRows[index]!,previousStarted=Date.parse(String(previous.started_at)),
        currentStarted=Date.parse(String(current.started_at)),previousFinished=Date.parse(String(previous.finished_at)),
        currentFinished=Date.parse(String(current.finished_at));
      if(!Number.isFinite(previousStarted)||!Number.isFinite(currentStarted)||!Number.isFinite(previousFinished)||
        !Number.isFinite(currentFinished)||currentStarted<previousFinished||currentFinished<previousFinished)
        throw new HardeningGenericOperationForbiddenError();
    }
    const commandAudits=(records.audit_events??[]).filter((row)=>row.run_id===runId&&row.action==="COMMAND_EXECUTED");
    if(commandAudits.length!==commandRows.length)throw new HardeningGenericOperationForbiddenError();
    const commandAuditProjections:Array<Record<string,unknown>>=[];
    for(const row of commandRows){
      const audits=commandAudits.filter((audit)=>{
        try{return (JSON.parse(String(audit.details_json)) as {commandExecutionId?:unknown}).commandExecutionId===row.id;}
        catch{return false;}
      });
      if(audits.length!==1)throw new HardeningGenericOperationForbiddenError();
      const audit=audits[0]!,details=JSON.parse(String(audit.details_json)) as Record<string,unknown>,expected={
        commandExecutionId:row.id,command:row.command,exitCode:row.exit_code,status:row.status,
        stdoutArtifactId:row.stdout_artifact_id,stderrArtifactId:row.stderr_artifact_id,
        environmentDigest:row.environment_digest,commitSha:row.commit_sha,manifestHash:run.manifestHash,
      };
      if(Object.keys(details).sort().join("\0")!==Object.keys(expected).sort().join("\0")||sha256(details)!==sha256(expected)||
        audit.actor_type!=="EXECUTOR"||audit.actor_id!==row.executor_id||audit.created_at!==row.finished_at)
        throw new HardeningGenericOperationForbiddenError();
      commandAuditProjections.push({id:audit.id,actorType:audit.actor_type,actorId:audit.actor_id,
        details,createdAt:audit.created_at});
    }
    const expectedHeadCommitSha=commandRows.length?String(commandRows.at(-1)!.commit_sha):seedResultCommitSha;
    const commandAuthorityHash=sha256({rows:commandRows.map((row)=>({id:row.id,sandboxId:row.sandbox_id,command:row.command,
      executorId:row.executor_id,exitCode:row.exit_code,startedAt:row.started_at,finishedAt:row.finished_at,
      stdoutArtifactId:row.stdout_artifact_id,stderrArtifactId:row.stderr_artifact_id,status:row.status,
      commitSha:row.commit_sha,environmentDigest:row.environment_digest,idempotencyKey:row.idempotency_key})),
      audits:commandAuditProjections});
    const events=this.options.supervisor.listEvents(runId).filter((event)=>event.reasonCode==="BUILDER_IMPLEMENTATION_FINISHED"&&
      event.nextState==="FAST_CHECKS"&&event.evidenceIds.includes(artifactId));
    const allFinalizations=(records.hardening_paid_call_finalizations??[]).filter((row)=>row.child_run_id===runId&&row.role==="BUILDER"),
      finalizations=allFinalizations.filter((row)=>row.agent_execution_id===agent.id&&row.status==="APPLIED"&&row.reservation_id===reservation.id);
    if(events.length!==1||allFinalizations.length!==1||finalizations.length!==1)throw new HardeningGenericOperationForbiddenError();
    return {result,artifactId,artifactHash:matches[0]!.sha256,agentExecutionId:String(agent.id),
      reservationId:String(reservation.id),successorEventId:events[0]!.eventId,expectedHeadCommitSha,commandAuthorityHash,
      finalizationId:String(finalizations[0]!.id)};
  }

  private exactHardeningIndependentCheckpoint(runId:string,manifestHash:string){
    const checkpoints=this.options.supervisor.listArtifacts(runId).filter((artifact)=>artifact.type==="INDEPENDENT_VERIFICATION_CHECKPOINT");
    if(checkpoints.length!==1)throw new HardeningGenericOperationForbiddenError();const artifact=checkpoints[0]!;
    if(!artifact.trusted||artifact.producerType!=="SYSTEM"||artifact.producerId!=="engineer-verification")
      throw new HardeningGenericOperationForbiddenError();
    const checkpointText=new TextDecoder("utf-8",{fatal:true}).decode(this.options.artifactStore.readVerifiedExact(artifact)),
      value=OptionalHardeningIndependentCheckpointSchema.parse(JSON.parse(checkpointText));
    if(checkpointText!==canonicalJson(value))throw new HardeningGenericOperationForbiddenError();
    const artifactRecords=this.options.supervisor.listArtifacts(runId),references=new Map<string,string|undefined>();
    let securityReportArtifact:ArtifactRecord;try{securityReportArtifact=resolveHardeningArtifactAuthority({
      authority:value.verified.securityReportArtifact,artifacts:artifactRecords,
      readArtifact:(candidate)=>this.options.artifactStore.readVerifiedExact(candidate)});}
    catch{throw new HardeningGenericOperationForbiddenError();}
    references.set(securityReportArtifact.artifactId,securityReportArtifact.sha256);
    const collect=(candidate:unknown):void=>{
      if(Array.isArray(candidate)){for(const item of candidate)collect(item);return;}
      if(!candidate||typeof candidate!=="object")return;const row=candidate as Record<string,unknown>;
      if(typeof row.artifactId==="string")references.set(row.artifactId,
        typeof row.sha256==="string"?row.sha256:references.get(row.artifactId));
      for(const nested of Object.values(row))collect(nested);
    };
    for(const evidence of value.verified.trustedEvidence){
      if(artifactRecords.some((candidate)=>candidate.artifactId===evidence.evidenceId))references.set(evidence.evidenceId,undefined);
      collect(evidence.payload);
    }
    for(const finding of value.verified.securityFindings)for(const evidenceId of finding.evidenceIds)
      if(artifactRecords.some((candidate)=>candidate.artifactId===evidenceId))references.set(evidenceId,undefined);
    for(const [artifactId,expectedHash] of references){
      const exact=artifactRecords.filter((candidate)=>candidate.artifactId===artifactId&&
        (expectedHash===undefined||candidate.sha256===expectedHash));
      if(exact.length!==1)throw new HardeningGenericOperationForbiddenError();
      this.options.artifactStore.readVerifiedExact(exact[0]!);
    }
    const diffs=this.options.supervisor.listArtifacts(runId).flatMap((artifact)=>{
      if(artifact.artifactId!==value.diffArtifactId||artifact.sha256!==value.diffArtifactHash||artifact.type!=="FINAL_DIFF"||
        !artifact.trusted||artifact.producerType!=="SYSTEM"||artifact.producerId!=="engineer-verification")return [];
      const diff=this.options.artifactStore.readVerifiedExact(artifact).toString("utf8");return sha256(diff)===value.diffHash?[{diff,artifact}]:[];
    });
    if(diffs.length!==1)throw new HardeningGenericOperationForbiddenError();
    const chain=validateOptionalHardeningCheckpointChain({checkpoint:value,artifact,
      events:this.options.supervisor.listEvents(runId),manifestHash});
    const inputArtifacts=artifactRecords.filter((candidate)=>candidate.type==="HARDENING_REVIEW_INPUT_AUTHORITY");
    if(inputArtifacts.length>1||(chain.completed&&inputArtifacts.length!==1)||
      (!chain.completed&&inputArtifacts.length!==0))throw new HardeningGenericOperationForbiddenError();
    if(inputArtifacts.length===1){
      const inputArtifact=inputArtifacts[0]!;
      if(!inputArtifact.trusted||inputArtifact.producerType!=="SYSTEM"||inputArtifact.producerId!=="engineer-verification")
        throw new HardeningGenericOperationForbiddenError();
      const inputAuthority=OptionalHardeningReviewInputAuthoritySchema.parse(
        JSON.parse(this.options.artifactStore.readVerifiedExact(inputArtifact).toString("utf8")));
      if(inputAuthority.runId!==runId||inputAuthority.manifestHash!==manifestHash||inputAuthority.diffHash!==value.diffHash||
        inputAuthority.resultCommitSha!==value.resultCommitSha||inputAuthority.checkpointArtifactId!==artifact.artifactId||
        inputAuthority.checkpointArtifactHash!==artifact.sha256||inputAuthority.checkpointHash!==value.checkpointHash||
        inputAuthority.reviewerInput.runId!==runId||inputAuthority.reviewerInput.manifestHash!==manifestHash||
        inputAuthority.reviewerInput.diffHash!==value.diffHash||inputAuthority.reviewerInput.resultCommitSha!==value.resultCommitSha)
        throw new HardeningGenericOperationForbiddenError();
      if(chain.completed){const expected=[inputArtifact.artifactId,inputArtifact.sha256,
          ...inputAuthority.reviewerInput.trustedEvidence.map((item)=>item.evidenceId)].sort();
        if(sha256(chain.completed.evidenceIds.slice(3))!==sha256(expected))throw new HardeningGenericOperationForbiddenError();}
      if(sha256(this.options.supervisor.latestRiskAssessment(runId))!==sha256(inputAuthority.reviewerInput.riskAssessment))
        throw new HardeningGenericOperationForbiddenError();
      for(const evidence of inputAuthority.reviewerInput.trustedEvidence){
        const evidenceArtifact=artifactRecords.find((candidate)=>candidate.artifactId===evidence.evidenceId);
        if(evidenceArtifact)this.options.artifactStore.readVerifiedExact(evidenceArtifact);collect(evidence.payload);
      }
      for(const [artifactId,expectedHash] of references){
        const exact=artifactRecords.filter((candidate)=>candidate.artifactId===artifactId&&
          (expectedHash===undefined||candidate.sha256===expectedHash));
        if(exact.length!==1)throw new HardeningGenericOperationForbiddenError();this.options.artifactStore.readVerifiedExact(exact[0]!);
      }
    }
    const successor=chain.completed??chain.resumed??chain.opened;
    return {diff:diffs[0]!.diff,diffHash:value.diffHash,resultCommitSha:value.resultCommitSha,
      checkpointArtifactId:checkpoints[0]!.artifactId,checkpointArtifactHash:checkpoints[0]!.sha256,
      checkpointHash:value.checkpointHash,diffArtifactId:diffs[0]!.artifact.artifactId,
      diffArtifactHash:diffs[0]!.artifact.sha256,selectedEventId:chain.head.eventId,
      successorEventId:successor?.eventId??null};
  }

  private hardeningCheckpointLatch(runId:string){
    const records=this.options.supervisor.exportRunRecords(runId),proofs:string[]=[],events=this.options.supervisor.listEvents(runId);
    const completionEvents=events.filter((event)=>["INDEPENDENT_VERIFICATION_COMPLETE",
      "INDEPENDENT_VERIFICATION_CHECKPOINT_RESUMED"].includes(event.reasonCode));
    for(const event of completionEvents)proofs.push(`event:${event.eventId}:${event.stateVersion}`);
    for(const [table,prefix] of [["reviewer_sessions","reviewer"],["review_classification_batches","classification"],
      ["evidence_bundles","bundle"],["verified_candidate_checkpoints","promotion"]] as const)
      for(const row of records[table]??[])proofs.push(`${prefix}:${String(row.id)}`);
    for(const row of records.agent_executions??[])if(row.role==="REVIEWER")proofs.push(`reviewer-agent:${String(row.id)}`);
    for(const row of records.hardening_child_model_reservations??[])if(row.role==="REVIEWER")proofs.push(`reviewer-reservation:${String(row.id)}`);
    for(const row of records.artifacts??[]){
      if(row.type==="FINAL_CHANGE_SCOPE_ATTESTATION"){
        proofs.push(`final-scope:${String(row.id)}:${String(row.sha256)}`);continue;
      }
      if(row.type!=="TEST_INTEGRITY_COMPARISON")continue;
      try{
        const artifact=this.options.supervisor.listArtifacts(runId).find((candidate)=>candidate.artifactId===row.id);
        if(!artifact||!artifact.trusted||artifact.producerType!=="SYSTEM"||
          artifact.producerId!=="engineer-supervisor-test-integrity")throw new Error("invalid integrity artifact projection");
        const comparison=TestIntegrityComparisonSchema.parse(JSON.parse(this.options.artifactStore.readVerifiedExact(artifact).toString("utf8")));
        if(comparison.runId!==runId)throw new Error("integrity comparison belongs to another run");
        // POST_BUILDER and PRE_VERIFICATION are normal pre-checkpoint evidence.
        // Only PRE_REVIEW proves the verification lane progressed past the
        // independent checkpoint and therefore forbids Builder fallback.
        if(comparison.stage==="PRE_REVIEW")proofs.push(`pre-review-integrity:${artifact.artifactId}:${artifact.sha256}`);
      }catch{throw new HardeningGenericOperationForbiddenError();}
    }
    // Planning risk is expected before verification and must not latch this
    // lane. A final risk row is recognized only when a current completion
    // transition exists and the row is a post-verification assessment made no
    // later than that exact state event.
    for(const event of completionEvents){
      const candidates=(records.risk_assessments??[]).filter((row)=>{
        if(typeof row.assessed_at!=="string"||Date.parse(row.assessed_at)>Date.parse(event.timestamp))return false;
        try{return (JSON.parse(String(row.features_json)) as {requiredChecksPassed?:unknown}).requiredChecksPassed===true;}
        catch{return false;}
      });
      const selected=candidates.sort((left,right)=>compareCodeUnits(String(right.assessed_at),String(left.assessed_at)))[0];
      if(selected)proofs.push(`final-risk:${String(selected.id)}:${event.eventId}:${event.stateVersion}`);
    }
    return [...new Set(proofs)].sort();
  }

  private prepareOptionalHardeningWorkspaceRecoveryUnchecked(preparation?:OptionalHardeningStartPreparation):OptionalHardeningWorkspaceRecoverySnapshot{
    if(!this.options.hardeningPromptCacheSecret)throw new HardeningPromptCacheAuthorityUnavailableError();
    if(!preparation)throw new HardeningGenericOperationForbiddenError();
    const durable=this.durableOptionalHardeningSeedAuthority(preparation),runId=preparation.operation.childRunId;
    if(["HUMAN_REVIEW_REQUIRED","REVIEW_CHANGES_REQUESTED","REVIEW_FIX_PREPARING","IMPLEMENTING"].includes(durable.run.state))
      throw new HardeningGenericOperationForbiddenError();
    let stage:OptionalHardeningWorkspaceRecoverySnapshot["stage"];
    if(["REQUEST_RECEIVED","REQUEST_NORMALIZED","PLANNING","PLAN_READY","PLAN_FROZEN","QUEUED"].includes(durable.run.state))stage={kind:"SEED"};
    else if(["FAST_CHECKS","UNIT_TESTING","INTEGRATION_TESTING","E2E_TESTING","FLAKE_QUARANTINE"].includes(durable.run.state)){
      const builder=this.exactHardeningBuilderResult(runId,durable.run.stateVersion,
        durable.signedSeed.attestation.seedResultCommitSha,durable.claim.sandboxId!,durable.signedSeed.attestation.environmentDigest);
      const rawCheckpointCount=this.options.supervisor.listArtifacts(runId).filter((item)=>item.type==="INDEPENDENT_VERIFICATION_CHECKPOINT").length;
      const latch=this.hardeningCheckpointLatch(runId);
      if(rawCheckpointCount!==0||latch.length!==0)throw new HardeningGenericOperationForbiddenError();
      stage={kind:"BUILDER",...builder,checkpointAuthorityHash:sha256({rawCheckpointCount,latch})};
    }else if(["SECURITY_REVIEW","VERIFICATION_RECOVERY","CODE_REVIEW","EVIDENCE_SYNTHESIS","REVIEWING"].includes(durable.run.state)){
      const rawCheckpointCount=this.options.supervisor.listArtifacts(runId).filter((item)=>item.type==="INDEPENDENT_VERIFICATION_CHECKPOINT").length;
      const latch=this.hardeningCheckpointLatch(runId);
      if(["SECURITY_REVIEW","VERIFICATION_RECOVERY"].includes(durable.run.state)&&rawCheckpointCount===0&&latch.length===0){
        const builder=this.exactHardeningBuilderResult(runId,durable.run.stateVersion,durable.signedSeed.attestation.seedResultCommitSha,
          durable.claim.sandboxId!,durable.signedSeed.attestation.environmentDigest);
        stage={kind:"BUILDER",...builder,checkpointAuthorityHash:sha256({rawCheckpointCount,latch})};
        const content={namespace:"engineer-optional-hardening-stage-recovery-v1",seedAuthorityHash:durable.authorityHash,
          runId,state:durable.run.state,stateVersion:durable.run.stateVersion,stage};
        return {runId,state:durable.run.state,stateVersion:durable.run.stateVersion,
          preparation:{...preparation,signedSeed:durable.signedSeed},stage,authorityHash:sha256(content)};
      }
      if(rawCheckpointCount!==1)throw new HardeningGenericOperationForbiddenError();
      const checkpoint=this.exactHardeningIndependentCheckpoint(runId,durable.run.manifestHash!);let classified:Extract<
        OptionalHardeningWorkspaceRecoverySnapshot["stage"],{kind:"INDEPENDENT"}>["classified"]=null;
      if(durable.run.state==="REVIEWING"){
        const records=this.options.supervisor.exportRunRecords(runId),allAgents=(records.agent_executions??[])
          .filter((row)=>row.run_id===runId&&row.role==="REVIEWER"),agents=allAgents.filter((row)=>row.status==="SUCCEEDED");
        const allReservations=(records.hardening_child_model_reservations??[]).filter((row)=>row.child_run_id===runId&&row.role==="REVIEWER"),
          reservations=allReservations.filter((row)=>row.status==="SETTLED");
        const allFinalizations=(records.hardening_paid_call_finalizations??[]).filter((row)=>row.child_run_id===runId&&row.role==="REVIEWER"),
          finalizations=allFinalizations.filter((row)=>row.status==="APPLIED");
        const reviewerAgentIds=new Set(allAgents.map((row)=>row.id)),reviewerSessionIds=new Set(
          (records.reviewer_sessions??[]).map((row)=>row.id));
        const reviewerReservations=allReservations;
        const providerArtifactIds=new Set(reviewerReservations.flatMap((row)=>
          typeof row.provider_response_artifact_id==="string"?[row.provider_response_artifact_id]:[]));
        const rawOutputArtifactIds=new Set((records.review_classification_batches??[]).flatMap((row)=>
          typeof row.raw_output_artifact_id==="string"?[row.raw_output_artifact_id]:[]));
        const reviewerSessions=records.reviewer_sessions??[],classificationBatches=records.review_classification_batches??[],
          reviewFindings=(records.review_findings??[]).filter((row)=>reviewerSessionIds.has(row.reviewer_session_id)),
          findingClassifications=(records.review_finding_classifications??[]).filter((row)=>reviewerSessionIds.has(row.reviewer_session_id)),
          reviewerRoutes=(records.model_routing_decisions??[]).filter((row)=>row.agent_role==="REVIEWER"||reviewerAgentIds.has(row.agent_execution_id)),
          reviewerSlots=(records.hardening_model_call_slots??[]).filter((row)=>row.role==="REVIEWER"),
          reviewerCalls=(records.model_calls??[]).filter((row)=>reviewerAgentIds.has(row.agent_execution_id)),
          claimEvidence=records.claim_evidence??[],evidenceBundles=records.evidence_bundles??[],
          reviewRunEvents=(records.run_state_events??[]).filter((row)=>[
            "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS","HARDENING_REVIEW_NOT_READY","CLASSIFIED_REVIEW_REQUIRES_HUMAN",
            "CLASSIFIED_REVIEW_REPAIR_REQUIRED","REVIEW_REPAIR_CONTEXT_PREPARING","REVIEW_REPAIR_STARTED",
          ].includes(String(row.reason_code))),
          reviewAudits=(records.audit_events??[]).filter((row)=>
            ["REVIEWER_SESSION_COMPLETED","REVIEW_CLASSIFICATION_RECORDED"].includes(String(row.action))),
          reviewArtifacts=(records.artifacts??[]).filter((row)=>["REVIEWER_OUTPUT","REVIEWER_RAW_OUTPUT"].includes(String(row.type))),
          providerReceiptArtifacts=(records.artifacts??[]).filter((row)=>providerArtifactIds.has(String(row.id))),
          classificationRawArtifacts=(records.artifacts??[]).filter((row)=>rawOutputArtifactIds.has(String(row.id)));
        const footprintGroups:[string,Array<Record<string,unknown>>][]=[
          ["agent_execution",allAgents],["hardening_reservation",allReservations],["hardening_finalization",allFinalizations],
          ["routing_decision",reviewerRoutes],["model_call_slot",reviewerSlots],["model_call",reviewerCalls],
          ["reviewer_session",reviewerSessions],["classification_batch",classificationBatches],
          ["review_finding",reviewFindings],["finding_classification",findingClassifications],
          ["evidence_bundle",evidenceBundles],["claim_evidence",claimEvidence],
          ["review_run_event",reviewRunEvents],["review_audit",reviewAudits],["review_artifact",reviewArtifacts],
          ["provider_receipt_artifact",providerReceiptArtifacts],["classification_raw_artifact",classificationRawArtifacts],
        ];
        const footprintEntries=footprintGroups.flatMap(([tableKind,rows])=>rows.map((row)=>({tableKind,
          key:String(row.id??row.event_id??row.classification_hash??row.batch_hash??row.claim_id??sha256(row)),rowHash:sha256(row)})));
        const footprintCounts=Object.fromEntries(footprintGroups.map(([tableKind,rows])=>[tableKind,rows.length]));
        const review=this.options.supervisor.latestClassifiedReview(runId),hasAny=footprintEntries.length>0||Boolean(review);
        if(hasAny){
          if(!review||allAgents.length!==1||agents.length!==1||allReservations.length!==1||reservations.length!==1||
            allFinalizations.length!==1||finalizations.length!==1||
            reviewerSessions.length!==1||reviewerSessions[0]!.id!==review.session.reviewerSessionId||
            classificationBatches.length!==1||classificationBatches[0]!.classification_hash!==review.classification.classificationHash||
            reviewFindings.length!==review.findings.length||findingClassifications.length!==review.classification.classifications.length||
            reviewerRoutes.length!==1||reviewerSlots.length!==1||reviewerCalls.length!==1||
            reviewArtifacts.length!==2||providerReceiptArtifacts.length!==1||classificationRawArtifacts.length!==1||
            reviewRunEvents.length!==0||reviewAudits.length!==1||
            reservations[0]!.agent_execution_id!==agents[0]!.id||finalizations[0]!.agent_execution_id!==agents[0]!.id||
            finalizations[0]!.reservation_id!==reservations[0]!.id||
            !this.options.supervisor.hasExactHardeningReviewerSuccessor({childRunId:runId,reservationId:String(reservations[0]!.id),
              agentExecutionId:String(agents[0]!.id)}))throw new HardeningGenericOperationForbiddenError();
          const expectedFindingIds=review.findings.map((finding)=>finding.findingId).sort(),
            durableFindingIds=reviewFindings.map((row)=>String(row.id)).sort(),
            durableClassificationFindingIds=findingClassifications.map((row)=>String(row.finding_id)).sort();
          if(sha256(expectedFindingIds)!==sha256(durableFindingIds)||sha256(expectedFindingIds)!==sha256(durableClassificationFindingIds)||
            reviewArtifacts.filter((row)=>row.type==="REVIEWER_OUTPUT"&&row.id===agents[0]!.output_artifact_id).length!==1||
            reviewArtifacts.filter((row)=>row.type==="REVIEWER_RAW_OUTPUT"&&row.id===review.classification.rawOutput.artifactId).length!==1)
            throw new HardeningGenericOperationForbiddenError();
          const referencedArtifactRows=[...new Map([...reviewArtifacts,...providerReceiptArtifacts,...classificationRawArtifacts]
            .map((row)=>[String(row.id),row])).values()];
          for(const row of referencedArtifactRows){
            const exact=this.options.supervisor.listArtifacts(runId).filter((artifact)=>artifact.artifactId===row.id&&
              artifact.sha256===row.sha256&&artifact.type===row.type&&artifact.producerType===row.producer_type&&
              artifact.producerId===row.producer_id&&artifact.trusted===(Number(row.trusted)===1));
            if(exact.length!==1)throw new HardeningGenericOperationForbiddenError();
            this.options.artifactStore.readVerifiedExact(exact[0]!);
          }
          const classificationAudit=reviewAudits.filter((row)=>row.action==="REVIEW_CLASSIFICATION_RECORDED");
          if(classificationAudit.length!==1)throw new HardeningGenericOperationForbiddenError();
          const classificationDetails=JSON.parse(String(classificationAudit[0]!.details_json)) as Record<string,unknown>,classificationExpected={
            reviewerSessionId:review.session.reviewerSessionId,contractHash:review.classification.contractHash,
            classificationHash:review.classification.classificationHash,rawOutputArtifactId:review.classification.rawOutput.artifactId,
            rawOutputHash:review.classification.rawOutput.sha256,normalizedOutputHash:review.classification.normalizedOutputHash,
            result:review.classification.result,
          };
          if(Object.keys(classificationDetails).sort().join("\0")!==Object.keys(classificationExpected).sort().join("\0")||
            sha256(classificationDetails)!==sha256(classificationExpected)||classificationAudit[0]!.actor_type!=="SYSTEM"||
            classificationAudit[0]!.actor_id!==review.classification.policyVersion||
            classificationAudit[0]!.created_at!==review.classification.createdAt)
            throw new HardeningGenericOperationForbiddenError();
          classified={reviewerSessionId:review.session.reviewerSessionId,classificationHash:review.classification.classificationHash,
            agentExecutionId:String(agents[0]!.id),reservationId:String(reservations[0]!.id),finalizationId:String(finalizations[0]!.id),
            footprintHash:sha256({entries:footprintEntries.sort((left,right)=>compareCodeUnits(left.tableKind,right.tableKind)||
              compareCodeUnits(left.key,right.key)||compareCodeUnits(left.rowHash,right.rowHash)),counts:footprintCounts})};
        }
      }
      stage={kind:"INDEPENDENT",...checkpoint,classified,checkpointAuthorityHash:sha256({rawCheckpointCount,latch})};
    }else throw new HardeningGenericOperationForbiddenError();
    const content={namespace:"engineer-optional-hardening-stage-recovery-v1",seedAuthorityHash:durable.authorityHash,
      runId,state:durable.run.state,stateVersion:durable.run.stateVersion,stage};
    return {runId,state:durable.run.state,stateVersion:durable.run.stateVersion,preparation:{...preparation,signedSeed:durable.signedSeed},
      stage,authorityHash:sha256(content)};
  }

  prepareOptionalHardeningWorkspaceRecovery(preparation?:OptionalHardeningStartPreparation):OptionalHardeningWorkspaceRecoverySnapshot{
    try{return this.prepareOptionalHardeningWorkspaceRecoveryUnchecked(preparation);}
    catch(error){
      if(error instanceof HardeningGenericOperationForbiddenError||error instanceof HardeningPromptCacheAuthorityUnavailableError)throw error;
      const code=typeof error==="object"&&error!==null&&typeof (error as {code?:unknown}).code==="string"
        ?String((error as {code:string}).code):"";
      if(code.startsWith("DATABASE_INTEGRITY_")||code.startsWith("WORKER_LEASE_")||
        code.startsWith("HARDENING_PROMPT_CACHE_"))throw error;
      throw new HardeningGenericOperationForbiddenError();
    }
  }

  prepareOptionalHardeningWorkspaceRecoveryForRun(runId:string):OptionalHardeningWorkspaceRecoverySnapshot{
    const runtime=this.hardeningAuthorities.get(runId);if(!runtime)throw new HardeningGenericOperationForbiddenError();
    return this.prepareOptionalHardeningWorkspaceRecovery({...runtime.preparation,signedSeed:runtime.signedSeed});
  }

  async activateOptionalHardeningWorkspaceRecovery(snapshot:OptionalHardeningWorkspaceRecoverySnapshot,
    assertAuthority:()=>void=()=>undefined,leaseEvidence:()=>unknown=()=>null):Promise<void>{
    assertAuthority();
    const current=this.prepareOptionalHardeningWorkspaceRecovery(snapshot.preparation);
    if(current.authorityHash!==snapshot.authorityHash||current.stateVersion!==snapshot.stateVersion||current.state!==snapshot.state)
      throw new HardeningGenericOperationForbiddenError();
    const durable=this.durableOptionalHardeningSeedAuthority(snapshot.preparation),runId=snapshot.runId;
    let sandbox=this.sandboxes.get(runId);
    try{
      assertAuthority();
      if(!sandbox){sandbox=await this.options.sandboxManager.recoverAsync({workspace:durable.checkpoint.workspace,
        sandbox:durable.checkpoint.sandbox,resetToHead:false});}
      assertAuthority();
      const workspaceManager=this.options.sandboxManager.workspaceManager(),seed=durable.signedSeed.attestation;
      let actual:{headCommitSha:string;treeHash:string;diffHash:string;diff:string};
      if(snapshot.stage.kind==="SEED"){
        actual=workspaceManager.verifyMaterializedSeed(sandbox.workspace,{baseCommitSha:snapshot.preparation.seed.baseCommitSha,
          seedResultCommitSha:snapshot.preparation.seed.seedResultCommitSha,finalDiff:snapshot.preparation.seed.finalDiff,
          diffHash:snapshot.preparation.seed.diffHash});
        if(actual.treeHash!==seed.seedTreeHash||actual.diffHash!==seed.seedDiffHash||
          workspaceLockfileHash(sandbox.workspace.workspaceRoot)!==seed.dependencyHash)throw new HardeningGenericOperationForbiddenError();
      }else if(snapshot.stage.kind==="BUILDER"){
        actual=workspaceManager.verifyMaterializedSeed(sandbox.workspace,{baseCommitSha:snapshot.preparation.seed.baseCommitSha,
          seedResultCommitSha:snapshot.stage.expectedHeadCommitSha,finalDiff:snapshot.stage.result.diff,
          diffHash:snapshot.stage.result.diffHash});
      }else{
        actual=workspaceManager.verifyMaterializedSeed(sandbox.workspace,{baseCommitSha:snapshot.preparation.seed.baseCommitSha,
          seedResultCommitSha:snapshot.stage.resultCommitSha,finalDiff:snapshot.stage.diff,diffHash:snapshot.stage.diffHash});
      }
      assertAuthority();
      const afterBytes=this.prepareOptionalHardeningWorkspaceRecovery(snapshot.preparation);
      if(afterBytes.authorityHash!==snapshot.authorityHash||afterBytes.stateVersion!==snapshot.stateVersion)
        throw new HardeningGenericOperationForbiddenError();
      assertAuthority();
      const lease=leaseEvidence();
      if(!lease||typeof lease!=="object"||Array.isArray(lease)||
        Object.keys(lease).sort().join("\0")!=="fencingToken\0leaseId\0ownerId"||
        typeof (lease as Record<string,unknown>).leaseId!=="string"||typeof (lease as Record<string,unknown>).ownerId!=="string"||
        !Number.isSafeInteger((lease as Record<string,unknown>).fencingToken)||
        Number((lease as Record<string,unknown>).fencingToken)<1)throw new HardeningGenericOperationForbiddenError();
      const attestation={version:1,policyVersion:"engineer-optional-hardening-workspace-recovery-v1",runId,
        authorityHash:snapshot.authorityHash,state:snapshot.state,stateVersion:snapshot.stateVersion,stage:snapshot.stage.kind,
        seedCheckpointArtifactId:durable.artifact.artifactId,seedCheckpointArtifactHash:durable.artifact.sha256,
        checkpointHash:durable.checkpoint.checkpointHash,sandboxId:sandbox.record.sandboxId,
        workspaceIdentity:sandbox.workspace.workspaceIdentity,resetToHead:false,headCommitSha:actual.headCommitSha,
        treeHash:actual.treeHash,diffHash:actual.diffHash,dependencyHash:workspaceLockfileHash(sandbox.workspace.workspaceRoot),lease};
      const bytes=JSON.stringify(attestation),hash=sha256Bytes(Buffer.from(bytes));
      const existing=this.options.supervisor.listArtifacts(runId).filter((artifact)=>artifact.type==="SANDBOX_RECOVERY_ATTESTATION");
      // Attestations are immutable recovery-generation evidence. Replaying the
      // same lease is record-or-verify; a later authenticated lease may append
      // its own attestation without invalidating the prior history.
      const history:Array<{artifact:ArtifactRecord;value:z.infer<typeof OptionalHardeningWorkspaceRecoveryAttestationSchema>}>=[],
        leaseBindings=new Map<string,string>(),fenceBindings=new Map<number,string>(),triples=new Set<string>();
      let previousHistoricalFence=0;
      for(const artifact of existing){
        try{
          if(!artifact.trusted||artifact.producerType!=="SYSTEM"||artifact.producerId!=="engineer-hardening-recovery")
            throw new Error("untrusted recovery attestation");
          const value=OptionalHardeningWorkspaceRecoveryAttestationSchema.parse(
            JSON.parse(this.options.artifactStore.readVerifiedExact(artifact).toString("utf8")));
          const historicalLease=value.lease;
          if(value.runId!==runId||value.seedCheckpointArtifactId!==durable.artifact.artifactId||
            value.seedCheckpointArtifactHash!==durable.artifact.sha256||value.checkpointHash!==durable.checkpoint.checkpointHash||
            value.sandboxId!==durable.checkpoint.sandbox.sandboxId||
            value.workspaceIdentity!==durable.checkpoint.workspace.workspaceIdentity||value.dependencyHash!==seed.dependencyHash)
            throw new Error("invalid recovery attestation");
          if(historicalLease.fencingToken<=previousHistoricalFence)throw new Error("retrograde recovery lease history");
          previousHistoricalFence=historicalLease.fencingToken;
          const triple=`${historicalLease.leaseId}\0${historicalLease.ownerId}\0${historicalLease.fencingToken}`,
            leaseBinding=`${historicalLease.ownerId}\0${historicalLease.fencingToken}`,
            fenceBinding=`${historicalLease.leaseId}\0${historicalLease.ownerId}`;
          if(triples.has(triple)||(leaseBindings.has(historicalLease.leaseId)&&leaseBindings.get(historicalLease.leaseId)!==leaseBinding)||
            (fenceBindings.has(historicalLease.fencingToken)&&fenceBindings.get(historicalLease.fencingToken)!==fenceBinding))
            throw new Error("ambiguous recovery lease history");
          triples.add(triple);leaseBindings.set(historicalLease.leaseId,leaseBinding);
          fenceBindings.set(historicalLease.fencingToken,fenceBinding);history.push({artifact,value});
        }catch{throw new HardeningGenericOperationForbiddenError();}
      }
      const activeLease=lease as {leaseId:string;ownerId:string;fencingToken:number},sameLease=history.filter(({value})=>
        value.lease.leaseId===activeLease.leaseId),sameFence=history.filter(({value})=>
        value.lease.fencingToken===activeLease.fencingToken),currentGeneration=history.filter(({value})=>
        value.lease.leaseId===activeLease.leaseId&&value.lease.ownerId===activeLease.ownerId&&
        value.lease.fencingToken===activeLease.fencingToken);
      if(sameLease.some(({value})=>value.lease.ownerId!==activeLease.ownerId||value.lease.fencingToken!==activeLease.fencingToken)||
        sameFence.some(({value})=>value.lease.leaseId!==activeLease.leaseId||value.lease.ownerId!==activeLease.ownerId)||
        currentGeneration.length>1||(currentGeneration.length===1&&
          (currentGeneration[0]!.value.authorityHash!==snapshot.authorityHash||currentGeneration[0]!.artifact.sha256!==hash)))
        throw new HardeningGenericOperationForbiddenError();
      const historicalMax=Math.max(0,...history.map(({value})=>value.lease.fencingToken));
      if(currentGeneration.length===0&&activeLease.fencingToken<=historicalMax)throw new HardeningGenericOperationForbiddenError();
      if(currentGeneration.length===0){
        const artifact=this.options.artifactStore.put({runId,type:"SANDBOX_RECOVERY_ATTESTATION",bytes,producerType:"SYSTEM",
          producerId:"engineer-hardening-recovery",trusted:true});
        assertAuthority();this.options.supervisor.recordArtifact(artifact);
      }
      assertAuthority();
      this.hardeningAuthorities.set(runId,{preparation:snapshot.preparation,signedSeed:durable.signedSeed});
      this.hardeningRecoveryAuthority.set(runId,{authorityHash:snapshot.authorityHash,stateVersion:snapshot.stateVersion});
      this.sandboxes.set(runId,sandbox);
    }catch(error){let mayDestroy=false;try{assertAuthority();mayDestroy=true;}catch{}
      if(sandbox&&mayDestroy)await this.options.sandboxManager.destroyAsync(sandbox).catch(()=>undefined);
      this.sandboxes.delete(runId);this.hardeningAuthorities.delete(runId);this.hardeningRecoveryAuthority.delete(runId);
      if(!mayDestroy||error instanceof HardeningGenericOperationForbiddenError||error instanceof HardeningPromptCacheAuthorityUnavailableError)
        throw error;
      const code=typeof error==="object"&&error!==null&&typeof (error as {code?:unknown}).code==="string"
        ?String((error as {code:string}).code):"";
      if(code.startsWith("DATABASE_INTEGRITY_")||code.startsWith("WORKER_LEASE_")||code.startsWith("HARDENING_PROMPT_CACHE_"))throw error;
      throw new HardeningGenericOperationForbiddenError();}
  }

  assertOptionalHardeningRecoveryAuthority(snapshot:OptionalHardeningWorkspaceRecoverySnapshot):void{
    const current=this.prepareOptionalHardeningWorkspaceRecovery(snapshot.preparation);
    if(current.authorityHash!==snapshot.authorityHash||current.stateVersion!==snapshot.stateVersion||current.state!==snapshot.state)
      throw new HardeningGenericOperationForbiddenError();
  }
  async discardOptionalHardeningSeed(runId:string):Promise<void>{const sandbox=this.pendingHardeningSeeds.get(runId);if(!sandbox)return;
    this.pendingHardeningSeeds.delete(runId);this.pendingHardeningAuthorities.delete(runId);
    await this.options.sandboxManager.destroyAsync(sandbox).catch(()=>undefined);}

  private correctionActionsForRun(runId: string): readonly SafeCorrectionAction[] {
    const directives = this.options.supervisor.listArtifacts(runId)
      .filter((artifact) => artifact.type === "CORRECTED_RUN_DIRECTIVE" && artifact.trusted &&
        artifact.producerType === "SYSTEM" && artifact.producerId === "engineer-correction-policy");
    if (directives.length === 0) {
      // Resolution Desk replacements do not mint a parallel pseudo-manifest
      // or legacy artifact. Reconstruct their correction authority from the
      // signed lineage and hash-bound planning context on every trust boundary.
      return this.options.supervisor.resolutionCorrectedRunDirective(runId)?.actions ?? [];
    }
    if (directives.length !== 1) throw new Error("corrected run must have exactly one trusted correction directive");
    const directive = CorrectedRunDirectiveSchema.parse(JSON.parse(this.options.artifactStore.read(directives[0]!).toString("utf8")));
    if (directive.replacementRunId !== runId) throw new Error("corrected-run directive is bound to another run");
    return directive.actions;
  }

  constructor(options: EngineerExecutionManagerOptions) {
    this.options = options;
  }

  usesWorkerLeaseAuthority(authority:EngineerWorkerLeaseManager):boolean{
    return this.options.leaseManager===authority;
  }

  execute(runId: string): Promise<BuilderResult> {
    this.enqueue(runId);
    return this.runQueued(runId);
  }

  enqueue(runId: string) {
    this.assertOptionalHardeningPromptAuthority(runId);
    // Verify corrected-run lineage before mutating state or admitting any paid
    // work. A tampered replacement therefore remains PLAN_FROZEN with zero
    // provider, sandbox, or tool activity.
    this.correctionActionsForRun(runId);
    const run = this.options.supervisor.getRun(runId);
    if (run.state === "QUEUED") return run;
    if (run.state !== "PLAN_FROZEN" || !run.manifestHash) {
      throw new Error(`Phase 2 enqueue requires PLAN_FROZEN, not ${run.state}`);
    }
    return this.options.supervisor.transition({
      runId,
      expectedStateVersion: run.stateVersion,
      nextState: "QUEUED",
      reasonCode: "EXECUTION_QUEUED",
      manifestHash: run.manifestHash,
      idempotencyKey: `phase2:queued:${run.stateVersion + 1}`,
    }).run;
  }

  runQueued(runId: string): Promise<BuilderResult> {
    this.assertOptionalHardeningPromptAuthority(runId);
    // A process restart or queued-run delay is another authority boundary.
    this.correctionActionsForRun(runId);
    const existing = this.active.get(runId);
    if (existing) return existing;
    const controller = new AbortController();
    this.abortControllers.set(runId, controller);
    const promise = this.executeOnce(runId, controller.signal).finally(() => {
      this.active.delete(runId);
      this.abortControllers.delete(runId);
    });
    this.active.set(runId, promise);
    return promise;
  }

  isActive(runId: string): boolean { return this.active.has(runId); }

  cancel(runId: string): void {
    this.cancelling.add(runId);
    this.abortControllers.get(runId)?.abort(new Error("Engineer run was cancelled"));
    this.cancellationAuthorityRevocations.get(runId)?.();
  }

  async waitForIdle(runId:string):Promise<void>{
    const active=this.active.get(runId);if(active)await active.catch(()=>undefined);
  }

  finishCancellation(runId:string):void{this.cancelling.delete(runId);}

  /** Requeue a human-resumed implementation while preserving its workspace checkpoint. */
  async resumeBudgetCheckpoint(runId: string) {
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "IMPLEMENTING" || !run.manifestHash) {
      throw new Error(`implementation budget resume requires IMPLEMENTING, not ${run.state}`);
    }
    if (this.active.has(runId)) return run;
    if (!this.sandboxes.has(runId)) await this.recoverSandbox(runId, false);
    return this.options.supervisor.transition({
      runId,
      expectedStateVersion: run.stateVersion,
      nextState: "QUEUED",
      reasonCode: "BUDGET_CHECKPOINT_REQUEUED",
      manifestHash: run.manifestHash,
      idempotencyKey: `phase2:budget-resume:${run.stateVersion}`,
    }).run;
  }

  /** Human-authorized retry after an ambiguous provider timeout. */
  async retryProviderTimeout(runId: string): Promise<ReturnType<EngineerSupervisor["getRun"]>> {
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "MODEL_PROVIDER_RETRY_PENDING" || !run.manifestHash) {
      throw new Error(`provider retry requires MODEL_PROVIDER_RETRY_PENDING, not ${run.state}`);
    }
    const timeouts = this.options.supervisor.listFailures(runId)
      .filter((failure) => failure.reasonCode === "MODEL_PROVIDER_TIMEOUT").length;
    if (timeouts > 2) throw new Error("provider timeout retry limit reached; create a new bounded run instead");
    await this.recoverSandbox(runId, false);
    return this.options.supervisor.transition({
      runId,
      expectedStateVersion: run.stateVersion,
      nextState: "QUEUED",
      reasonCode: "HUMAN_RETRY_FROM_WORKSPACE_CHECKPOINT",
      manifestHash: run.manifestHash,
      idempotencyKey: `provider-retry:${run.stateVersion}:${timeouts}`,
    }).run;
  }

  /** Abort detached model work and await cleanup before gateway-owned stores close. */
  async drain(cleanupSandboxes = true): Promise<void> {
    for (const controller of this.abortControllers.values()) controller.abort(new Error("Engineer gateway is draining"));
    await Promise.allSettled([...this.active.values()]);
    if (cleanupSandboxes) await this.destroyAllAsync();
  }

  destroyAll(options: SandboxCleanupOptions = {}): void {
    for (const runId of [...this.sandboxes.keys()]) {
      if (options.preserveResumable && GRACEFUL_DRAIN_RESUMABLE_STATES.has(this.options.supervisor.getRun(runId).state)) continue;
      this.destroy(runId);
    }
  }

  async destroyAllAsync(options: SandboxCleanupOptions = {}): Promise<void> {
    const destroyable = [...this.sandboxes.keys()].filter((runId) =>
      !options.preserveResumable || !GRACEFUL_DRAIN_RESUMABLE_STATES.has(this.options.supervisor.getRun(runId).state));
    await Promise.allSettled(destroyable.map((runId) => this.destroyAsync(runId)));
  }

  recoverQueued(): Array<{ runId: string; promise: Promise<BuilderResult> }> {
    return this.options.supervisor.listRuns(["QUEUED"]).filter((run)=>!this.options.supervisor.isOptionalHardeningChild(run.runId)).map((run) => ({
      runId: run.runId,
      promise: this.runQueued(run.runId),
    }));
  }

  async recoverInterrupted(runId: string, leaseEvidenceId: string): Promise<"REQUEUED" | "EXHAUSTED" | "IGNORED"> {
    const supervisor = this.options.supervisor;
    this.assertOptionalHardeningPromptAuthority(runId);
    this.recoverHardeningPaidCallLifecycleIfUnowned(runId);
    const interrupted = supervisor.getRun(runId);
    if (!PHASE2_RECOVERABLE_STATES.has(interrupted.state)) return "IGNORED";
    supervisor.finalizeRunningAgentExecutions(runId, "FAILED", "WORKER_PROCESS_INTERRUPTED",
      (this.options.now ?? (() => new Date()))().toISOString());
    this.abortControllers.get(runId)?.abort(new Error("Engineer worker lease expired"));
    const repositoryRoot = this.options.repositoryRootFor(interrupted.repository.repositoryId);
    await this.options.sandboxManager.workspaceManager().cleanupRunAsync(runId, repositoryRoot);
    this.sandboxes.delete(runId);
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    supervisor.markRunSandboxesDestroyed(runId, now, "WORKER_PROCESS_INTERRUPTED");
    const fingerprint = sha256({ phase: "PHASE_2", reason: "WORKER_PROCESS_INTERRUPTED", state: interrupted.state });
    supervisor.recordFailure(FailureRecordSchema.parse({
      failureId: sha256({ leaseEvidenceId, interruptedStateVersion: interrupted.stateVersion, record: "worker-interrupted" }),
      runId,
      failureClass: "WORKFLOW_FAILURE",
      reasonCode: "WORKER_PROCESS_INTERRUPTED",
      fingerprint,
      evidenceIds: [leaseEvidenceId],
      retryable: true,
      createdAt: now,
    }));
    const retry = supervisor.authorizeRetry({
      runId,
      expectedStateVersion: interrupted.stateVersion,
      kind: "SANDBOX_PROVISIONING",
      failureFingerprint: fingerprint,
      patchHash: null,
      progressMetric: null,
    });
    const current = supervisor.getRun(runId);
    const nextState = retry.allowed ? "QUEUED" : "RETRY_BUDGET_EXHAUSTED";
    supervisor.transition({
      runId,
      expectedStateVersion: current.stateVersion,
      nextState,
      reasonCode: retry.allowed ? "WORKER_PROCESS_RECOVERED" : retry.reasonCode,
      manifestHash: current.manifestHash,
      evidenceIds: [leaseEvidenceId],
      idempotencyKey: sha256({ leaseEvidenceId, interruptedStateVersion: interrupted.stateVersion, command: "phase2-recover" }),
    });
    return retry.allowed ? "REQUEUED" : "EXHAUSTED";
  }

  resumeRecovered(runId: string): void {
    if(this.options.supervisor.isOptionalHardeningChild(runId)&&
      (!this.options.hardeningPromptCacheSecret||!this.hardeningAuthorities.has(runId)))return;
    const existing = this.active.get(runId);
    if (existing) {
      this.abortControllers.get(runId)?.abort(new Error("Engineer worker is being replaced after lease recovery"));
      void existing.finally(() => {
        if (this.options.supervisor.getRun(runId).state === "QUEUED") void this.runQueued(runId).catch(() => undefined);
      });
      return;
    }
    if (this.options.supervisor.getRun(runId).state === "QUEUED") void this.runQueued(runId).catch(() => undefined);
  }

  getSandbox(runId: string): ProvisionedSandbox | null {
    return this.sandboxes.get(runId) ?? null;
  }

  /** Reconstruct a retained sandbox from an immutable local checkpoint after process restart. */
  async recoverSandbox(
    runId: string,
    resetToHead: boolean,
    assertAuthority: () => void = () => undefined,
  ): Promise<ProvisionedSandbox> {
    if(this.options.supervisor.isOptionalHardeningChild(runId)&&!this.hardeningRecoveryAuthority.has(runId))
      throw new HardeningGenericOperationForbiddenError();
    const existing = this.sandboxes.get(runId);
    if (existing) {
      assertAuthority();
      return existing;
    }
    assertAuthority();
    const run = this.options.supervisor.getRun(runId);
    if (!run.manifestHash) throw new Error("sandbox recovery requires a frozen manifest");
    const checkpointArtifact = this.options.supervisor.listArtifacts(runId)
      .filter((artifact) => artifact.type === "SANDBOX_WORKSPACE_CHECKPOINT" && artifact.trusted)
      .at(-1);
    if (!checkpointArtifact) throw new Error("retained sandbox checkpoint is unavailable");
    const checkpointBytes=this.options.supervisor.isOptionalHardeningChild(runId)
      ?this.options.artifactStore.readVerifiedExact(checkpointArtifact):this.options.artifactStore.read(checkpointArtifact);
    const checkpoint = SandboxWorkspaceCheckpointSchema.parse(
      JSON.parse(checkpointBytes.toString("utf8")),
    );
    if (checkpoint.runId !== runId || checkpoint.manifestHash !== run.manifestHash) {
      throw new Error("retained sandbox checkpoint does not match the active run manifest");
    }
    const recovered = await this.options.sandboxManager.recoverAsync({
      workspace: checkpoint.workspace,
      sandbox: checkpoint.sandbox,
      resetToHead,
    });
    assertAuthority();
    this.sandboxes.set(runId, recovered);
    const recoveredCommitSha = await this.options.sandboxManager.currentCommitAsync(recovered.workspace);
    assertAuthority();
    const recoveryArtifact = this.options.artifactStore.put({
      runId,
      type: "SANDBOX_RECOVERY_ATTESTATION",
      bytes: JSON.stringify({
        checkpointHash: checkpoint.checkpointHash,
        checkpointArtifactId: checkpointArtifact.artifactId,
        sandboxId: recovered.record.sandboxId,
        workspaceIdentity: recovered.workspace.workspaceIdentity,
        recoveredCommitSha,
        resetToHead,
      }),
      producerType: "SYSTEM",
      producerId: "engineer-execution-manager",
      trusted: true,
    });
    // No await or user callback may separate this final fence from the local
    // artifact bytes and their ledger row.
    assertAuthority();
    const recovery = this.options.supervisor.recordArtifact(recoveryArtifact);
    if (!recovery.trusted) throw new Error("sandbox recovery attestation must be trusted");
    return recovered;
  }

  destroy(runId: string): SandboxRecord | null {
    const sandbox = this.sandboxes.get(runId);
    if (!sandbox) return null;
    const destroyed = this.options.sandboxManager.destroy(sandbox);
    this.options.supervisor.recordSandbox(destroyed);
    this.sandboxes.delete(runId);
    this.hardeningAuthorities.delete(runId);
    return destroyed;
  }

  async destroyAsync(runId: string): Promise<SandboxRecord | null> {
    const sandbox = this.sandboxes.get(runId);
    if (!sandbox) return null;
    const destroyed = await this.options.sandboxManager.destroyAsync(sandbox);
    this.options.supervisor.recordSandbox(destroyed);
    this.sandboxes.delete(runId);
    this.hardeningAuthorities.delete(runId);
    return destroyed;
  }

  private async executeOnce(runId: string, signal: AbortSignal): Promise<BuilderResult> {
    const supervisor = this.options.supervisor;
    const initial = supervisor.getRun(runId);
    if (initial.state !== "QUEUED" || !initial.manifestHash) {
      throw new Error(`Phase 2 execution requires QUEUED, not ${initial.state}`);
    }
    const manifest = supervisor.getManifest(runId);
    if (!manifest) throw new Error("frozen manifest is unavailable");
    const hardeningChild = supervisor.isOptionalHardeningChild(runId);
    const route = resolveEngineerModel("BUILDER", this.options.builderOptions?.modelConfiguration);
    const transition = (
      nextState: Parameters<EngineerSupervisor["transition"]>[0]["nextState"],
      reasonCode: string,
      evidenceIds: string[] = [],
    ) => {
      assertLease();
      const run = supervisor.getRun(runId);
      return supervisor.transition({
        runId,
        expectedStateVersion: run.stateVersion,
        nextState,
        reasonCode,
        evidenceIds,
        manifestHash: run.manifestHash,
        idempotencyKey: `phase2:${nextState.toLowerCase()}:${run.stateVersion + 1}`,
      }).run;
    };

    let provisioned: ProvisionedSandbox | null = this.sandboxes.get(runId) ?? null;
    const retainedWorkspace = provisioned !== null;
    let agentExecutionId: string | null = null;
    let agentStartedAt: string | null = null;
    let agentInputHash: string | null = null;
    let lease: WorkerLeaseGrant | null = null;
    let testIntegrity: TestIntegrityGuard | null = null;
    let hardeningFence: ReturnType<EngineerSupervisor["acquireHardeningExecutionFence"]> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatSequence = 0;
    let authorityRevoked = false;
    const leaseOwnerId = this.options.workerOwnerId ?? "engineer-execution-worker";
    const assertLease = () => {
      if(authorityRevoked)throw new Error("Engineer execution authority was revoked for cancellation");
      if (!lease || !this.options.leaseManager) return;
      this.options.leaseManager.assertActive({
        leaseId: lease.lease.leaseId,
        ownerId: leaseOwnerId,
        fencingToken: lease.lease.fencingToken,
        leaseToken: lease.leaseToken,
      });
    };
    const assertPaidAuthority = () => {
      assertLease();
      if (hardeningChild && hardeningFence) {
        supervisor.assertHardeningExecutionFence({
          childRunId: runId,
          ownerId: hardeningFence.ownerId,
          fenceGeneration: hardeningFence.fenceGeneration,
          rawFenceToken: hardeningFence.rawFenceToken,
          nowMs: (this.options.now ?? (() => new Date()))().getTime(),
        });
      }
    };
    const revokeCancellationAuthority=()=>{
      authorityRevoked=true;
      if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null;}
      if(hardeningFence){
        try{supervisor.releaseHardeningExecutionFence({childRunId:runId,ownerId:hardeningFence.ownerId,
          fenceGeneration:hardeningFence.fenceGeneration,rawFenceToken:hardeningFence.rawFenceToken,
          nowMs:(this.options.now??(()=>new Date()))().getTime()});}catch{/* expiry/recovery already revoked it */}
        hardeningFence=null;
      }
      if(lease&&this.options.leaseManager){
        try{this.options.leaseManager.release({leaseId:lease.lease.leaseId,ownerId:leaseOwnerId,
          fencingToken:lease.lease.fencingToken,leaseToken:lease.leaseToken,
          idempotencyKey:`cancel-release:${lease.lease.renewalCount}`});}catch{/* expiry/recovery already revoked it */}
        lease=null;
      }
    };
    this.cancellationAuthorityRevocations.set(runId,revokeCancellationAuthority);
    try {
      if (this.options.leaseManager) {
        lease = this.options.leaseManager.acquire({
          resourceKey: `run:${runId}`,
          ownerId: leaseOwnerId,
          ttlMs: this.options.leaseTtlMs ?? 30_000,
          idempotencyKey: `execute:${runId}:${initial.stateVersion}`,
        });
        heartbeatTimer = setInterval(() => {
          if (!lease) return;
          heartbeatSequence += 1;
          try {
            const record = this.options.leaseManager!.heartbeat({
              leaseId: lease.lease.leaseId,
              ownerId: leaseOwnerId,
              fencingToken: lease.lease.fencingToken,
              leaseToken: lease.leaseToken,
              idempotencyKey: `heartbeat:${heartbeatSequence}`,
            });
            lease = { ...lease, lease: record };
            if (hardeningFence) {
              hardeningFence = supervisor.renewHardeningExecutionFence({
                childRunId: runId,
                ownerId: hardeningFence.ownerId,
                fenceGeneration: hardeningFence.fenceGeneration,
                rawFenceToken: hardeningFence.rawFenceToken,
                ttlMs: 120_000,
                nowMs: (this.options.now ?? (() => new Date()))().getTime(),
                idempotencyKey: `builder-hardening-heartbeat:${heartbeatSequence}`,
              });
            }
          } catch {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = null;
            this.abortControllers.get(runId)?.abort(new Error("Engineer hardening spend fence expired"));
          }
        }, this.options.heartbeatIntervalMs ?? 10_000);
        heartbeatTimer.unref?.();
      }
      assertLease();
      agentExecutionId = (this.options.idFactory ?? randomUUID)();
      agentStartedAt = (this.options.now ?? (() => new Date()))().toISOString();
      agentInputHash = sha256({
        manifestHash: manifest.manifestHash,
        purpose: "initial-builder-dispatch",
        dispatchStateVersion: initial.stateVersion,
      });
      const initialDispatch = supervisor.claimBuilderDispatch({
        agentExecutionId,
        runId,
        role: "BUILDER",
        modelTier: route.logicalTier,
        status: "RUNNING",
        inputHash: agentInputHash,
        outputArtifactId: null,
        startedAt: agentStartedAt,
        completedAt: null,
      }, lease ? { ownerId: leaseOwnerId, fencingToken: lease.lease.fencingToken } : null);
      if (!initialDispatch.won) {
        agentExecutionId = null;
        agentStartedAt = null;
        agentInputHash = null;
        throw new BuilderDispatchClaimLostError(runId);
      }
      if (provisioned) {
        transition("SANDBOX_READY", "RETAINED_WORKSPACE_CHECKPOINT_REUSED", [provisioned.record.sandboxId]);
      } else if (this.options.sandboxManager.warmEnabled()) {
        transition("SANDBOX_WARM_CLAIMING", "WARM_SANDBOX_CLAIM_STARTED");
      } else {
        transition("SANDBOX_COLD_PROVISIONING", "COLD_SANDBOX_SELECTED");
      }
      const repositoryRoot = this.options.repositoryRootFor(initial.repository.repositoryId);
      if (!provisioned && this.options.sandboxManager.warmEnabled()) {
        const warmClaim = await this.options.sandboxManager.claimWarmAsync({
          runId,
          repositoryId: initial.repository.repositoryId,
          repositoryRoot,
          baseCommitSha: initial.repository.baseCommitSha,
        });
        if (warmClaim.status === "CLAIMED") {
          provisioned = warmClaim.sandbox;
          transition("SANDBOX_WARM_VALIDATING", "WARM_SANDBOX_RESERVED");
          supervisor.recordSandbox(provisioned.record);
          transition("SANDBOX_WARM_CLAIMED", "WARM_SANDBOX_VALIDATED", [provisioned.record.sandboxId]);
          transition("SANDBOX_READY", "WARM_SANDBOX_READY", [provisioned.record.sandboxId]);
        } else {
          if (warmClaim.status === "INVALID") {
            transition("SANDBOX_PREWARM_INVALID", "WARM_SANDBOX_VALIDATION_FAILED");
          }
          transition("SANDBOX_COLD_PROVISIONING", "WARM_SANDBOX_UNAVAILABLE_OR_INVALID");
        }
      }
      if (!provisioned) {
        while (!provisioned) {
          try {
            provisioned = await this.options.sandboxManager.provisionColdAsync({
              runId,
              repositoryRoot,
              baseCommitSha: initial.repository.baseCommitSha,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const current = supervisor.getRun(runId);
            const retry = supervisor.authorizeRetry({
              runId, expectedStateVersion: current.stateVersion, kind: "SANDBOX_PROVISIONING",
              failureFingerprint: sha256({ phase: "COLD_PROVISIONING", message }), patchHash: null, progressMetric: null,
            });
            if (!retry.allowed) throw error;
          }
        }
        transition("SANDBOX_PREFLIGHT", "SANDBOX_PROVISIONED");
        supervisor.recordSandbox(provisioned.record);
        transition("SANDBOX_READY", "SANDBOX_PREFLIGHT_PASSED", [provisioned.record.sandboxId]);
      }
      this.sandboxes.set(runId, provisioned);
      // Optional hardening already owns exactly one immutable v2 seed-locator
      // checkpoint committed atomically with its finalized start claim.
      // Appending a generic progress checkpoint would create ambiguous seed
      // authority, so only the ordinary lane persists here.
      if(!hardeningChild)this.persistSandboxCheckpoint(initial.manifestHash, provisioned);
      transition("CONTEXT_BUILDING", "BUILDER_CONTEXT_BUILDING");
      const integrityOptions = {
        supervisor,
        artifactStore: this.options.artifactStore,
        manifest,
        workspace: provisioned.workspace,
        now: this.options.now,
        ...(hardeningChild ? { verifiedSeedHeadCommitSha: this.hardeningAuthorities.get(runId)?.signedSeed.attestation.seedResultCommitSha } : {}),
      };
      // A hardening child deliberately starts from a retained, signed parent
      // candidate, but it is a new run with a new frozen manifest. Its test
      // baseline must therefore be captured once from that verified seed.
      // Loading the parent's copied baseline binds the guard to the wrong
      // run/manifest and falsely blocks every real hardening execution before
      // the Builder is allowed to run.
      testIntegrity = retainedWorkspace && !hardeningChild
        ? TestIntegrityGuard.load(integrityOptions)
        : TestIntegrityGuard.createAndRecord(integrityOptions);
      const builderRoutingDecisionId = (this.options.idFactory ?? randomUUID)();
      supervisor.recordModelRouting({
        routingDecisionId: builderRoutingDecisionId,
        runId,
        agentExecutionId,
        agentRole: "BUILDER",
        logicalTier: route.logicalTier,
        resolvedModel: route.model,
        routingPolicyVersion: route.policyVersion,
        fallbackUsed: false,
        fallbackReason: null,
        cacheKey: null,
        timestamp: (this.options.now ?? (() => new Date()))().toISOString(),
      });
      transition("IMPLEMENTING", "CODEX_BUILDER_STARTED");
      const executor = new TrustedCommandExecutor({
        artifactStore: this.options.artifactStore,
        workspace: provisioned.workspace,
        sandbox: provisioned.record,
        manifest,
        runner: provisioned.commandRunner,
        ...(provisioned.commandRunnerAsync ? { runnerAsync: provisioned.commandRunnerAsync } : {}),
        currentCommit: () => this.options.sandboxManager.currentCommit(provisioned!.workspace),
        currentCommitAsync: () => this.options.sandboxManager.currentCommitAsync(provisioned!.workspace),
        onRecord: (record) => { supervisor.recordCommandExecution(record); },
        signal,
      });
      const recoveredDiffHash = sha256(await this.options.sandboxManager.workspaceManager().diffAsync(provisioned.workspace));
      const correctionActions = this.correctionActionsForRun(runId);
      const inputContextHash = builderInputContextHash(manifest, undefined, correctionActions);
      const continuation = supervisor.listArtifacts(runId)
        .filter((artifact) => artifact.type === "BUILDER_CONTINUATION" && artifact.trusted &&
          artifact.producerType === "SYSTEM" && artifact.producerId === "engineer-builder-checkpoint")
        .reverse()
        .flatMap((artifact) => {
          try {
            const bytes=hardeningChild?this.options.artifactStore.readVerifiedExact(artifact):this.options.artifactStore.read(artifact);
            const parsed = BuilderContinuationSchema.parse(
              JSON.parse(bytes.toString("utf8")),
            );
            return parsed.manifestHash === manifest.manifestHash &&
              parsed.inputContextHash === inputContextHash &&
              parsed.workspaceIdentity === provisioned!.record.workspaceIdentity &&
              parsed.candidateDiffHash === recoveredDiffHash ? [parsed] : [];
          } catch { return []; }
        })[0];
      let builderTransport: ResponsesTransport | undefined;
      if (hardeningChild) {
        hardeningFence = supervisor.acquireHardeningExecutionFence({
          childRunId: runId,
          ownerId: `${leaseOwnerId}:builder`,
          ttlMs: 120_000,
          nowMs: (this.options.now ?? (() => new Date()))().getTime(),
          idempotencyKey: sha256({ namespace: "engineer-hardening-builder-fence-v1", runId, agentExecutionId, agentInputHash }),
        });
      } else {
        builderTransport = await this.options.transportForRun(runId);
      }
      const revalidateHardeningBuilderAuthority=()=>{
        if(!hardeningChild)return;
        assertPaidAuthority();this.assertOptionalHardeningPromptAuthority(runId);
        const runtime=this.hardeningAuthorities.get(runId);
        if(!runtime)throw new HardeningGenericOperationForbiddenError();
        const durable=this.durableOptionalHardeningSeedAuthority({...runtime.preparation,signedSeed:runtime.signedSeed});
        if(canonicalJson(durable.manifest)!==canonicalJson(manifest)||durable.run.manifestHash!==manifest.manifestHash)
          throw new HardeningGenericOperationForbiddenError();
        const seed=durable.signedSeed.attestation,materialized=this.options.sandboxManager.workspaceManager()
          .verifyMaterializedSeed(provisioned!.workspace,{baseCommitSha:runtime.preparation.seed.baseCommitSha,
            seedResultCommitSha:runtime.preparation.seed.seedResultCommitSha,
            finalDiff:runtime.preparation.seed.finalDiff,diffHash:runtime.preparation.seed.diffHash});
        if(materialized.headCommitSha.toLowerCase()!==seed.seedResultCommitSha.toLowerCase()||
          materialized.treeHash!==seed.seedTreeHash||materialized.diffHash!==seed.seedDiffHash||
          workspaceLockfileHash(provisioned!.workspace.workspaceRoot)!==seed.dependencyHash)
          throw new HardeningGenericOperationForbiddenError();
      };
      revalidateHardeningBuilderAuthority();
      let hardeningDispatchAuthorityPrepared=false;
      const hardeningResponseReceipts=new Map<string,{modelCall:ModelCallRecord;artifactId:string}>();
      const builder = new CodexBuilder({
        ...(hardeningChild
          ? { transportAfterReservation: async () => {
            // Revalidate the complete signed child/seed/workspace authority
            // before even constructing the provider transport. The durable
            // reservation remains RESERVED_UNSENT if this boundary fails and
            // CodexBuilder reconciles it without a provider lookup or retry.
            revalidateHardeningBuilderAuthority();
            this.options.afterHardeningBuilderAuthorityCheckedForTest?.("BEFORE_DISPATCH");
            revalidateHardeningBuilderAuthority();
            const paidTransport=await this.options.transportForRun(runId);
            hardeningDispatchAuthorityPrepared=true;
            return paidTransport;
          } }
          : { transport: builderTransport! }),
        manifest,
        workspace: provisioned.workspace,
        workspaceManager: this.options.sandboxManager.workspaceManager(),
        executor,
        correctionActions,
        ...this.options.builderOptions,
        ...(hardeningChild ? { maxRounds: 1, conservativeLocalInputAccounting: true } : {}),
        ...(hardeningChild ? { hardeningPromptCacheIdentity: {
          secret: this.options.hardeningPromptCacheSecret ?? (() => { throw new Error("hardening prompt-cache secret is unavailable"); })(),
          requesterUserId: supervisor.getRun(runId).userId,
          childRunId: runId,
        } } : {}),
        now: this.options.now,
        signal,
        ...(continuation ? { continuation } : {}),
        onContinuation: (checkpoint) => {
          supervisor.recordArtifact(this.options.artifactStore.put({
            runId,
            type: "BUILDER_CONTINUATION",
            bytes: JSON.stringify(BuilderContinuationSchema.parse({
              ...checkpoint,
              workspaceIdentity: provisioned!.record.workspaceIdentity,
            })),
            producerType: "SYSTEM",
            producerId: "engineer-builder-checkpoint",
            trusted: true,
          }));
        },
        safetyIdentifier: this.options.safetyIdentifierForUser?.(supervisor.getRun(runId).userId),
        assertAuthority: assertPaidAuthority,
        reserveModelCall: ({ model, inputTokenUpperBound, maxOutputTokens, round, attempt, requestHash, cacheDescriptor }) => {
          assertPaidAuthority();
          if (hardeningChild) {
            revalidateHardeningBuilderAuthority();
            this.options.afterHardeningBuilderAuthorityCheckedForTest?.("BEFORE_RESERVATION");
            revalidateHardeningBuilderAuthority();
            if (!hardeningFence) throw new Error("hardening Builder spend fence is unavailable");
            if (!cacheDescriptor) throw new Error("hardening Builder prompt-cache reservation authority is unavailable");
            const admission=supervisor.reserveHardeningPaidCall({
              childRunId: runId,
              role: "BUILDER",
              modelTier: "GPT-5.6_TERRA",
              resolvedModel: model,
              routingDecisionId: builderRoutingDecisionId,
              agentExecutionId: agentExecutionId!,
              inputTokenUpperBound,
              outputTokenCeiling: maxOutputTokens,
              requestHash,
              cacheDescriptor,
              reservationIdempotencyKey: sha256({ runId, agentExecutionId, round, attempt, purpose: "hardening-builder-model-call" }),
              fenceOwnerId: hardeningFence.ownerId,
              fenceGeneration: hardeningFence.fenceGeneration,
              rawFenceToken: hardeningFence.rawFenceToken,
              nowMs: (this.options.now ?? (() => new Date()))().getTime(),
            });
            try{revalidateHardeningBuilderAuthority();}
            catch(error){supervisor.voidHardeningPaidCallUnsent({childRunId:runId,
              reservationId:admission.reservation.reservationId,requestHash,
              clientRequestId:admission.reservation.clientRequestId,
              settlementIdempotencyKey:sha256({reservationId:admission.reservation.reservationId,outcome:"VOID_UNSENT"}),
              fenceOwnerId:hardeningFence.ownerId,fenceGeneration:hardeningFence.fenceGeneration,
              rawFenceToken:hardeningFence.rawFenceToken,nowMs:(this.options.now??(()=>new Date()))().getTime()});throw error;}
            return {reservationId:admission.reservation.reservationId,dispatchAllowed:admission.applied,
              clientRequestId:admission.reservation.clientRequestId};
          }
          return supervisor.reserveModelBudget({
              runId, reservationId: sha256({ runId, agentExecutionId, round, attempt, purpose: "builder-model-call" }),
              agentExecutionId: agentExecutionId!, model, inputTokenUpperBound, maxOutputTokens,
            });
        },
        beforeModelDispatch: hardeningChild ? ({reservationId,requestHash,clientRequestId})=>{
          if(!hardeningFence||!reservationId||!clientRequestId)throw new Error("hardening Builder dispatch authority is unavailable");
          if(!hardeningDispatchAuthorityPrepared)throw new Error("hardening Builder dispatch authority was not prepared");
          revalidateHardeningBuilderAuthority();
          supervisor.markHardeningPaidCallDispatching({childRunId:runId,reservationId,requestHash,clientRequestId,
            fenceOwnerId:hardeningFence.ownerId,fenceGeneration:hardeningFence.fenceGeneration,
            rawFenceToken:hardeningFence.rawFenceToken,nowMs:(this.options.now??(()=>new Date()))().getTime()});
        } : undefined,
        onModelResponseReceived: hardeningChild ? (observation)=>{
          if(!hardeningFence||!observation.reservationId||!observation.clientRequestId)
            throw new Error("hardening Builder response authority is unavailable");
          const hardeningUsageSafe=observation.inputTokens!==null&&observation.outputTokens!==null&&
            [observation.inputTokens,observation.outputTokens,observation.cachedInputTokens,observation.cacheWriteInputTokens]
              .every((value)=>value!==null&&Number.isSafeInteger(value)&&value>=0)&&
            observation.cachedInputTokens!+observation.cacheWriteInputTokens!<=observation.inputTokens;
          const modelCall=ModelCallRecordSchema.parse({modelCallId:(this.options.idFactory??randomUUID)(),runId,
            agentExecutionId:agentExecutionId!,logicalTier:route.logicalTier,resolvedModel:route.model,
            promptTemplateVersion:CODEX_BUILDER_PROMPT_VERSION,
            inputContextRefs:[manifest.manifestHash,observation.inputHash,observation.requestHash,observation.clientRequestId,observation.responseId],
            outputSchemaVersion:null,cacheKey:observation.cacheKey,cacheHit:hardeningUsageSafe?observation.cachedInputTokens!>0:null,
            latencyMs:observation.latencyMs,
            inputTokens:Number.isSafeInteger(observation.inputTokens)&&observation.inputTokens!>=0?observation.inputTokens:null,
            outputTokens:Number.isSafeInteger(observation.outputTokens)&&observation.outputTokens!>=0?observation.outputTokens:null,
            cachedInputTokens:Number.isSafeInteger(observation.cachedInputTokens)&&observation.cachedInputTokens!>=0?observation.cachedInputTokens:null,
            cacheWriteInputTokens:Number.isSafeInteger(observation.cacheWriteInputTokens)&&observation.cacheWriteInputTokens!>=0?observation.cacheWriteInputTokens:null,
            retryCount:observation.retryCount,status:"SUCCEEDED",createdAt:(this.options.now??(()=>new Date()))().toISOString()});
          const artifact=supervisor.recordArtifact(this.options.artifactStore.put({runId,type:"MODEL_PROVIDER_RESPONSE",
            bytes:observation.providerResponseJson,producerType:"SYSTEM",producerId:"engineer-provider-response-recorder",trusted:true}));
          supervisor.recordHardeningPaidCallResponse({childRunId:runId,reservationId:observation.reservationId,
            requestHash:observation.requestHash,clientRequestId:observation.clientRequestId,modelCall,
            providerResponseId:observation.responseId,providerResponseArtifactId:artifact.artifactId,
            fenceOwnerId:hardeningFence.ownerId,fenceGeneration:hardeningFence.fenceGeneration,
            rawFenceToken:hardeningFence.rawFenceToken,nowMs:(this.options.now??(()=>new Date()))().getTime()});
          hardeningResponseReceipts.set(observation.reservationId,{modelCall,artifactId:artifact.artifactId});
        } : undefined,
        onReservedUnsentFailure: hardeningChild ? ({reservationId,requestHash,clientRequestId})=>{
          if(!hardeningFence)throw new Error("hardening Builder unsent authority is unavailable");
          supervisor.voidHardeningPaidCallUnsent({childRunId:runId,reservationId,requestHash,clientRequestId,
            settlementIdempotencyKey:sha256({reservationId,outcome:"VOID_UNSENT"}),fenceOwnerId:hardeningFence.ownerId,
            fenceGeneration:hardeningFence.fenceGeneration,rawFenceToken:hardeningFence.rawFenceToken,
            nowMs:(this.options.now??(()=>new Date()))().getTime()});
        } : undefined,
        authorizeModelRetry: ({ error, attempt, failedAttempt, inputHash, cacheKey, reservationId, latencyMs }) => {
          if (signal.aborted) return false;
          const message = error instanceof Error ? error.message : String(error);
          const current = supervisor.getRun(runId);
          const failedModelCall = ModelCallRecordSchema.parse({
            modelCallId: (this.options.idFactory ?? randomUUID)(), runId, agentExecutionId: agentExecutionId!,
            logicalTier: route.logicalTier, resolvedModel: route.model,
            promptTemplateVersion: CODEX_BUILDER_PROMPT_VERSION, inputContextRefs: [manifest.manifestHash, inputHash],
            outputSchemaVersion: null, cacheKey, cacheHit: null, latencyMs,
            inputTokens: null, outputTokens: null, retryCount: failedAttempt, status: "FAILED",
            createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
          });
          // A client timeout is ambiguous: the provider may still finish and
          // bill it. Never replay the identical request automatically.
          if (hardeningChild) {
            if (!hardeningFence || !reservationId) throw new Error("hardening Builder reservation evidence is unavailable");
            supervisor.settleHardeningPaidCall({
              childRunId: runId,
              reservationId,
              modelCall: failedModelCall,
              providerResponseId: null,
              providerResponseArtifactId: null,
              settlementIdempotencyKey: sha256({ reservationId, modelCallId: failedModelCall.modelCallId, outcome: "AMBIGUOUS" }),
              fenceOwnerId: hardeningFence.ownerId,
              fenceGeneration: hardeningFence.fenceGeneration,
              rawFenceToken: hardeningFence.rawFenceToken,
              nowMs: (this.options.now ?? (() => new Date()))().getTime(),
            });
            return false;
          }
          supervisor.recordModelCall(failedModelCall, reservationId);
          if (isProviderModelTimeout(error)) return false;
          const retry = supervisor.authorizeRetry({
            runId, expectedStateVersion: current.stateVersion, kind: "TRANSIENT_MODEL",
            failureFingerprint: sha256({ role: "BUILDER", message }), patchHash: null, progressMetric: attempt,
          });
          if (!retry.allowed && current.state === "IMPLEMENTING") {
            transition("RETRY_BUDGET_EXHAUSTED", retry.reasonCode);
          }
          return retry.allowed;
        },
        onModelCall: (observation) => {
          const receipt=observation.reservationId?hardeningResponseReceipts.get(observation.reservationId):undefined;
          const modelCallId = receipt?.modelCall.modelCallId ?? (this.options.idFactory ?? randomUUID)();
          const hardeningUsageSafe=!hardeningChild||(observation.inputTokens!==null&&observation.outputTokens!==null&&
            [observation.inputTokens,observation.outputTokens,observation.cachedInputTokens,observation.cacheWriteInputTokens]
              .every((value)=>value!==null&&Number.isSafeInteger(value)&&value>=0)&&
            observation.cachedInputTokens!+observation.cacheWriteInputTokens!<=observation.inputTokens);
          const modelCall = receipt?.modelCall ?? ModelCallRecordSchema.parse({
            modelCallId,
            runId,
            agentExecutionId: agentExecutionId!,
            logicalTier: route.logicalTier,
            resolvedModel: route.model,
            promptTemplateVersion: CODEX_BUILDER_PROMPT_VERSION,
            inputContextRefs: [manifest.manifestHash, observation.inputHash, observation.responseId],
            outputSchemaVersion: null,
            cacheKey: observation.cacheKey,
            cacheHit: hardeningUsageSafe && observation.cachedInputTokens !== null ? observation.cachedInputTokens > 0 : null,
            latencyMs: observation.latencyMs,
            inputTokens: hardeningUsageSafe ? observation.inputTokens : null,
            outputTokens: hardeningUsageSafe ? observation.outputTokens : null,
            ...(hardeningUsageSafe?{cachedInputTokens:observation.cachedInputTokens,
              cacheWriteInputTokens:observation.cacheWriteInputTokens}:{}),
            retryCount: observation.retryCount,
            status: "SUCCEEDED",
            createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
          });
          if (hardeningChild) {
            if (!hardeningFence || !observation.reservationId || !receipt) throw new Error("hardening Builder settlement authority is unavailable");
            supervisor.settleHardeningPaidCall({
              childRunId: runId,
              reservationId: observation.reservationId,
              modelCall,
              providerResponseId: observation.responseId,
              providerResponseArtifactId: receipt.artifactId,
              settlementIdempotencyKey: sha256({ reservationId: observation.reservationId, modelCallId, responseId: observation.responseId }),
              fenceOwnerId: hardeningFence.ownerId,
              fenceGeneration: hardeningFence.fenceGeneration,
              rawFenceToken: hardeningFence.rawFenceToken,
              nowMs: (this.options.now ?? (() => new Date()))().getTime(),
            });
          } else {
            supervisor.recordModelCall(modelCall, observation.reservationId);
          }
        },
      });
      supervisor.assertRuntimeBudget(runId);
      const result = await builder.run();
      assertLease();
      const integrity = testIntegrity.attest("POST_BUILDER");
      const artifact = supervisor.recordArtifact(this.options.artifactStore.put({
        runId,
        type: "BUILDER_RESULT",
        bytes: JSON.stringify(result),
        producerType: "SYSTEM",
        producerId: "codex-builder-adapter",
        trusted: false,
        createdAt: result.completedAt,
      }));
      supervisor.recordAgentExecution({
        agentExecutionId,
        runId,
        role: "BUILDER",
        modelTier: route.logicalTier,
        status: "SUCCEEDED",
        inputHash: agentInputHash!,
        outputArtifactId: artifact.artifactId,
        startedAt: agentStartedAt,
        completedAt: result.completedAt,
      });
      transition("FAST_CHECKS", "BUILDER_IMPLEMENTATION_FINISHED", [artifact.artifactId, integrity.artifact.artifactId]);
      if(hardeningChild&&hardeningFence){
        const pending=supervisor.listPendingHardeningPaidCallFinalizations(runId).find((item)=>item.agentExecutionId===agentExecutionId&&item.role==="BUILDER");
        if(!pending)throw new Error("hardening Builder finalization intent is unavailable");
        const idempotencyKey=sha256({finalizationId:pending.id,successor:"FAST_CHECKS"});
        supervisor.consumeHardeningPaidCallFinalization({finalizationId:pending.id,ownerId:hardeningFence.ownerId,
          rawToken:hardeningFence.rawFenceToken,idempotencyKey,nowMs:(this.options.now??(()=>new Date()))().getTime(),
          expectedSuccessor:"SUCCESS"});
      }
      return result;
    } catch (error) {
      if (error instanceof BuilderDispatchClaimLostError) throw error;
      if (isWorkerAuthorityLoss(error, signal)) throw error;
      const run = supervisor.getRun(runId);
      if (error instanceof BudgetPausedError) {
        if (agentExecutionId && agentStartedAt) {
          supervisor.recordAgentExecution({
            agentExecutionId,
            runId,
            role: "BUILDER",
            modelTier: route.logicalTier,
            status: "PAUSED",
            inputHash: agentInputHash!,
            outputArtifactId: null,
            startedAt: agentStartedAt,
            completedAt: (this.options.now ?? (() => new Date()))().toISOString(),
          });
        }
        throw error;
      }
      const budgetExhausted = error instanceof RuntimeBudgetExhaustedError;
      const builderCallLimitReached = error instanceof BuilderModelCallLimitError;
      const builderNoProgress = error instanceof BuilderNoProgressError;
      const providerTimedOut = isProviderModelTimeout(error);
      const testIntegrityFailure = error instanceof TestIntegrityViolationError;
      const domain = executionFailureDomain(run.state, error);
      const policy = testIntegrityFailure
        ? { failureClass: "SECURITY_FAILURE" as const, reasonCode: error.reasonCode, retryable: false }
        : budgetExhausted
        ? { failureClass: "WORKFLOW_FAILURE" as const, reasonCode: "RUNTIME_BUDGET_EXHAUSTED", retryable: false }
        : builderCallLimitReached
        ? { failureClass: "WORKFLOW_FAILURE" as const, reasonCode: "BUILDER_MODEL_CALL_LIMIT_REACHED", retryable: false }
        : builderNoProgress
        ? { failureClass: "DEPENDENCY_FAILURE" as const, reasonCode: "BUILDER_NO_PROGRESS", retryable: false }
        : providerTimedOut && hardeningChild
        ? { failureClass: "MODEL_FAILURE" as const, reasonCode: "HARDENING_PROVIDER_OUTCOME_AMBIGUOUS", retryable: false }
        : providerTimedOut
        ? { failureClass: "MODEL_FAILURE" as const, reasonCode: "MODEL_PROVIDER_TIMEOUT", retryable: true }
        : operationalFailurePolicy(domain);
      const message = error instanceof Error ? error.message : String(error);
      supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: (this.options.idFactory ?? randomUUID)(),
        runId,
        ...policy,
        fingerprint: sha256({ policyVersion: "operational-failure-v1", domain, reasonCode: policy.reasonCode, message }),
        evidenceIds: [
          ...(provisioned ? [provisioned.record.sandboxId] : []),
          ...(testIntegrityFailure && error.evidenceId ? [error.evidenceId] : []),
          ...(builderNoProgress ? [...error.commandExecutionIds] : []),
        ],
        createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
      }));
      // A hardening child with a durable pending paid-call finalization for this
      // agent must be orphan-finalized by the provider-free recovery sweep, not
      // pre-marked FAILED here. The recovery-terminal successor authority is
      // proven by the ORPHAN_AGENT_EXECUTIONS_FINALIZED audit, which only fires
      // for a RUNNING agent; recording FAILED directly would strand the pending
      // VOID_UNSENT/AMBIGUOUS finalization at PENDING. Only defer when recovery
      // is actually configured to run in this worker's finally block.
      const deferHardeningAgentFinalizationToRecovery =
        hardeningChild && !!agentExecutionId && !!this.options.leaseManager &&
        !!this.options.hardeningPromptCacheSecret &&
        (() => {
          try {
            return supervisor.listPendingHardeningPaidCallFinalizations(runId)
              .some((finalization) => finalization.agentExecutionId === agentExecutionId);
          } catch { return false; }
        })();
      if (agentExecutionId && agentStartedAt && !deferHardeningAgentFinalizationToRecovery) {
        supervisor.recordAgentExecution({
          agentExecutionId,
          runId,
          role: "BUILDER",
          modelTier: route.logicalTier,
          status: "FAILED",
          inputHash: agentInputHash!,
          outputArtifactId: null,
          startedAt: agentStartedAt,
          completedAt: (this.options.now ?? (() => new Date()))().toISOString(),
        });
      }
      const sandboxStates = new Set([
        "SANDBOX_WARM_CLAIMING", "SANDBOX_WARM_VALIDATING", "SANDBOX_WARM_CLAIMED",
        "SANDBOX_COLD_PROVISIONING", "SANDBOX_PROVISIONING", "SANDBOX_PREFLIGHT", "SANDBOX_PREWARM_INVALID",
      ]);
      const hardeningReservationAwaitingRecovery=hardeningChild&&
        supervisor.listOpenHardeningPaidCallReservations(runId).length>0;
      const next = testIntegrityFailure && canTransition(run.state, "SECURITY_ESCALATION")
        ? "SECURITY_ESCALATION"
        : (budgetExhausted || builderCallLimitReached) && canTransition(run.state, "RETRY_BUDGET_EXHAUSTED")
        ? "RETRY_BUDGET_EXHAUSTED"
        : providerTimedOut && !hardeningChild && canTransition(run.state, "MODEL_PROVIDER_RETRY_PENDING")
        ? "MODEL_PROVIDER_RETRY_PENDING"
        : sandboxStates.has(run.state) || run.state === "CONTEXT_BUILDING"
        ? "BLOCKED_BY_ENVIRONMENT"
        : run.state === "IMPLEMENTING"&&!hardeningReservationAwaitingRecovery
          ? "FAILED"
          : null;
      if (next) {
        supervisor.transition({
          runId,
          expectedStateVersion: run.stateVersion,
          nextState: next,
          reasonCode: testIntegrityFailure
            ? error.reasonCode
            : next === "RETRY_BUDGET_EXHAUSTED"
            ? builderCallLimitReached ? "BUILDER_MODEL_CALL_LIMIT_REACHED" : "RUNTIME_BUDGET_EXHAUSTED"
            : next === "MODEL_PROVIDER_RETRY_PENDING"
            ? "MODEL_PROVIDER_TIMEOUT"
            : next === "FAILED" ? providerTimedOut&&hardeningChild ? "HARDENING_PROVIDER_OUTCOME_AMBIGUOUS"
              : builderNoProgress ? "BUILDER_NO_PROGRESS" : "CODEX_BUILDER_FAILED" : "SANDBOX_OR_CONTEXT_FAILED",
          manifestHash: run.manifestHash,
          idempotencyKey: `phase2:failure:${run.stateVersion + 1}`,
        });
      }
      if (provisioned && next === "BLOCKED_BY_ENVIRONMENT") {
        try {
          supervisor.recordSandbox(await this.options.sandboxManager.destroyAsync(provisioned));
        } catch { /* preserve original failure */ }
      }
      throw error;
    } finally {
      if(this.cancellationAuthorityRevocations.get(runId)===revokeCancellationAuthority)
        this.cancellationAuthorityRevocations.delete(runId);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (hardeningFence) {
        try {
          supervisor.releaseHardeningExecutionFence({
            childRunId: runId,
            ownerId: hardeningFence.ownerId,
            fenceGeneration: hardeningFence.fenceGeneration,
            rawFenceToken: hardeningFence.rawFenceToken,
            nowMs: (this.options.now ?? (() => new Date()))().getTime(),
          });
        } catch { /* A stale/terminal main-ledger fence is already fail closed. */ }
      }
      if (lease && this.options.leaseManager) {
        try {
          this.options.leaseManager.release({
            leaseId: lease.lease.leaseId,
            ownerId: leaseOwnerId,
            fencingToken: lease.lease.fencingToken,
            leaseToken: lease.leaseToken,
            idempotencyKey: "release",
          });
        } catch { /* Expired/fenced leases are recovered by the durable watchdog. */ }
      }
      if(hardeningChild&&!this.cancelling.has(runId)){
        try{this.recoverHardeningPaidCallLifecycleIfUnowned(runId);}catch{/* periodic provider-free recovery retries durably */}
      }
    }
  }

  private sandboxCheckpointArtifact(manifestHash:string,provisioned:ProvisionedSandbox,hardening?:SignedHardeningSeedAttestation){
    const common = {
      runId: provisioned.record.runId,
      manifestHash,
      workspace: provisioned.workspace,
      sandbox: provisioned.record,
      createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
    const content = hardening ? {
      checkpointVersion: 2 as const,
      ...common,
      hardeningLineageId: hardening.attestation.lineageId,
      hardeningLineageHash: hardening.attestation.lineageHash,
      seedAttestationId: hardening.attestation.seedAttestationId,
      seedAttestationHash: hardening.attestation.seedAttestationHash,
    } : { checkpointVersion: 1 as const, ...common };
    const checkpoint = SandboxWorkspaceCheckpointSchema.parse({ ...content, checkpointHash: sha256(content) });
    return this.options.artifactStore.put({
      runId: checkpoint.runId,
      type: "SANDBOX_WORKSPACE_CHECKPOINT",
      bytes: JSON.stringify(checkpoint),
      producerType: "SYSTEM",
      producerId: "engineer-execution-manager",
      trusted: true,
    });
  }

  private persistSandboxCheckpoint(manifestHash: string, provisioned: ProvisionedSandbox): void {
    this.options.supervisor.recordArtifact(this.sandboxCheckpointArtifact(manifestHash,provisioned));
  }
}
