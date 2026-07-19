import {
  RepositoryReferenceSchema,
  TaskManifestContentSchema,
  type EngineerExecutionManager,
  type EngineerContextManager,
  type EngineerPublicationManager,
  type EngineerPlanningManager,
  type EngineerVerificationManager,
  type EngineerRun,
  type EngineerSupervisor,
  type RepositoryReference,
  type TaskManifestContent,
  type LocalArtifactStore,
  type ArtifactRecord,
  type BudgetTopUp,
  type EngineerBudgetSelection,
  type EngineerBudgetSnapshot,
  engineerObservabilitySnapshot,
  createCorrectedRunDirective,
  manifestPatternMatchesPath,
  type SafeCorrectionCode,
  isCancellationAllowed,
  hasUnreconciledRemotePublication,
  sha256,
  canTransition,
  EngineerPlanningCancelledError,
  EngineerPlanningTimeoutError,
  isProviderModelTimeout,
  BudgetPausedError,
  FailureRecordSchema,
  type EngineerWorkerLeaseManager,
  type WorkerLeaseGrant,
  type ApprovalAuthorityExpectation,
  type CheckpointAttestor,
  verifiedCandidateSummary,
  VerifiedCandidateRequiredError,
  OptionalHardeningChildCreationSchema,
  OptionalHardeningChildRequestSchema,
  type OptionalHardeningChildCreation,
  type OptionalHardeningChildRequest,
  HardeningStartClaimBusyError,
  HardeningGenericOperationForbiddenError,
  HardeningReviewerRecoveryAuthorityInvalidError,
  HardeningWorkspaceRecoveryAuthorityInvalidError,
  HardeningBudgetExtensionRequiresNewRunError,
  WorkerLeaseCapacityError,
  WorkerLeaseConflictError,
  TenantScopedLedgerDal,
  defineHumanActor,
  ENGINEER_DEFAULT_ORG_ID,
  EngineerNotFoundError,
  type AuditExport,
} from "@zintus/engineer";
import type { EngineerPrincipal } from "./engineer-identity.js";
import { previewEngineerArtifact } from "./engineer-artifact-preview.js";
import type { EngineerCapabilityPreflight, EngineerReadiness } from "./engineer-preflight.js";
import { redactSecrets } from "@zintus/router";
import { createHash, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";

class CancellationStillPendingError extends Error {
  constructor(message:string){super(message);this.name="CancellationStillPendingError";}
}

interface DurableCancellationSupervisor {
  requestRunCancellation(input:{runId:string;actorId:string;artifact:ArtifactRecord}):{run:EngineerRun;applied:boolean};
  finalizeRunCancellation(input:{runId:string;outcome:"CANCELLED"|"FAILED";
    expectedLastError:string|null;lastError:string|null}):EngineerRun;
  getLastError(runId:string):string|null;
}

export interface EngineerRunManagerOptions {
  supervisor: EngineerSupervisor;
  execution?: EngineerExecutionManager;
  verification?: EngineerVerificationManager;
  publication?: EngineerPublicationManager;
  diffForRun?: (runId: string) => string;
  planning?: EngineerPlanningManager;
  artifactStore?: LocalArtifactStore;
  cleanupRun?: (runId: string) => void | Promise<void>;
  preflight: EngineerCapabilityPreflight;
  principal: EngineerPrincipal;
  context?: EngineerContextManager;
  leaseManager?: EngineerWorkerLeaseManager;
  workerOwnerId?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  /** Maximum synchronous UI wait for cancellation drain; never above the run lease TTL. */
  cancellationDrainTimeoutMs?: number;
  checkpointAttestor?: CheckpointAttestor;
  now?: () => Date;
  hardeningPromptCacheReadiness?: EngineerHardeningReadiness;
}

export type EngineerHardeningReadiness=
  |{state:"READY";code:null;message:null}
  |{state:"DEGRADED";code:"HARDENING_PROMPT_CACHE_AUTHORITY_UNAVAILABLE"|"HARDENING_PROMPT_CACHE_AUTHORITY_MISMATCH";message:string};

const unavailableCheckpointAttestor: CheckpointAttestor = {
  algorithm: "unavailable",
  keyId: "unavailable",
  sign: () => { throw new Error("Engineer verified-candidate attestor is not configured"); },
  verify: () => { throw new Error("Engineer verified-candidate attestor is not configured"); },
};

export function correctedRunRepository(source: RepositoryReference, current: RepositoryReference): RepositoryReference {
  const { baseCommitSha: _sourceBase, ...sourceIdentity } = source;
  const { baseCommitSha: _currentBase, ...currentIdentity } = current;
  if (sha256(sourceIdentity) !== sha256(currentIdentity)) {
    throw new Error("corrected-run recovery cannot change repository identity, origin, or base branch");
  }
  return RepositoryReferenceSchema.parse(current);
}

function redactAdvisoryText<T extends { description: string; recommendedChange: string }>(item: T): T {
  return { ...item, description: redactSecrets(item.description), recommendedChange: redactSecrets(item.recommendedChange) };
}

type HardeningBudget = { costMicrousd: number; tokens: number; timeSeconds: number };
type HardeningAcknowledgements = {
  separateRun: true;
  parentCandidateUnchanged: true;
  noAutomaticRepair: true;
  noOverages: true;
};

function publicHardeningQuote(quote: {
  schemaVersion: 1 | 2; policyVersion: string;
  quoteId: string; quoteHash: string; parentRunId: string; parentCheckpointId: string;
  requesterUserId: string; repositoryId: string;
  parentCheckpointHash: string; parentStateVersion: number; selectionHash: string;
  advisoryIds: string[]; routingPolicyVersion: string; pricingVersion: string;
  estimatorVersion: string; estimate: unknown; assumptions: string[]; createdAt: string; expiresAt: string;
  status: "ACTIVE" | "EXPIRED";
}) {
  return {
    schemaVersion: quote.schemaVersion,
    policyVersion: quote.policyVersion,
    quoteId: quote.quoteId,
    quoteHash: quote.quoteHash,
    parentRunId: quote.parentRunId,
    requesterUserId: quote.requesterUserId,
    repositoryId: quote.repositoryId,
    parentCheckpointId: quote.parentCheckpointId,
    parentCheckpointHash: quote.parentCheckpointHash,
    parentStateVersion: quote.parentStateVersion,
    selectionHash: quote.selectionHash,
    advisoryIds: [...quote.advisoryIds],
    routingPolicyVersion: quote.routingPolicyVersion,
    pricingVersion: quote.pricingVersion,
    estimatorVersion: quote.estimatorVersion,
    estimate: quote.estimate,
    assumptions: [...quote.assumptions],
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
    status: quote.status,
  };
}

function withoutArtifactStorageReferences<T>(value:T):T{
  return JSON.parse(JSON.stringify(value,(key,item)=>
    key==="storage_reference"||key==="storageReference"?undefined:item)) as T;
}

/** Gateway facade. It exposes no generic state-transition endpoint. */
export class EngineerRunManager {
  private readonly options: EngineerRunManagerOptions;
  private readonly background = new Set<Promise<void>>();
  private readonly activePlanning = new Map<string, AbortController>();
  private readonly activePlanningSettled = new Map<string, Promise<void>>();
  private readonly activePlanningRevocations = new Map<string, () => void>();
  private readonly hardeningRecovery = new Map<string, Promise<unknown>>();
  private readonly recoveredHardeningAuthorities = new Set<string>();
  private readonly cancellationRecovery = new Map<string, Promise<void>>();
  private readonly managerInstanceId = randomUUID();
  private draining = false;

  constructor(options: EngineerRunManagerOptions) {
    if (!options.preflight || !options.principal) throw new Error("Engineer principal and capability preflight are mandatory");
    this.options = options;
  }

  principal(): EngineerPrincipal { return { ...this.options.principal }; }
  readiness(): EngineerReadiness { return this.options.preflight.readiness(); }
  hardeningReadiness():EngineerHardeningReadiness{return this.options.hardeningPromptCacheReadiness?
    {...this.options.hardeningPromptCacheReadiness}:{state:"READY",code:null,message:null};}
  ensureReady(): Promise<void> { return this.options.preflight.assertStartup(); }

  private assertHardeningPromptCacheReady():void{
    const readiness=this.hardeningReadiness();
    if(readiness.state!=="READY")throw Object.assign(new Error(readiness.message),{code:readiness.code,retryable:true});
  }

  private assertRequiredLaneAction(runId:string):void{
    if(this.options.supervisor.isOptionalHardeningChild?.(runId))
      throw new HardeningGenericOperationForbiddenError();
  }

  private assertHardeningBudgetIsNotExtended(runId:string):void{
    if(this.options.supervisor.isOptionalHardeningChild?.(runId))
      throw new HardeningBudgetExtensionRequiresNewRunError();
  }

  repository(principal: EngineerPrincipal): RepositoryReference {
    this.assertPrincipal(principal);
    return this.options.preflight.repository();
  }

  async listAdvisories(principal: EngineerPrincipal, runId: string, query: {
    limit: number;
    cursor?: string;
    status?: "OPEN" | "DEFERRED" | "DISMISSED";
    actionability?: "ACTIONABLE" | "AUDIT_ONLY";
  }) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    const page = await this.options.supervisor.listAdvisoryBacklogForOwner(principal.ownerId, runId, query);
    return {
      schemaVersion: page.schemaVersion,
      materializationStatus: page.materializationStatus,
      items: page.items.map(redactAdvisoryText),
      nextCursor: page.nextCursor,
    };
  }

  async deferAdvisory(principal: EngineerPrincipal, runId: string, advisoryId: string, command: {
    expectedRevision: number;
    idempotencyKey: string;
    rationale: string | null;
  }) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    return redactAdvisoryText(await this.options.supervisor.deferAdvisoryForOwner(principal.ownerId, runId, advisoryId, command));
  }

  async dismissAdvisory(principal: EngineerPrincipal, runId: string, advisoryId: string, command: {
    expectedRevision: number;
    idempotencyKey: string;
    rationale: string | null;
  }) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    return redactAdvisoryText(await this.options.supervisor.dismissAdvisoryForOwner(principal.ownerId, runId, advisoryId, command));
  }

  async reopenAdvisory(principal: EngineerPrincipal, runId: string, advisoryId: string, command: {
    expectedRevision: number;
    idempotencyKey: string;
    rationale: string | null;
  }) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    return redactAdvisoryText(await this.options.supervisor.reopenAdvisoryForOwner(principal.ownerId, runId, advisoryId, command));
  }

  async createHardeningQuote(principal: EngineerPrincipal, runId: string, input: {
    runId: string;
    advisoryIds: string[];
    expectedParentStateVersion: number;
    idempotencyKey: string;
  }) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertHardeningPromptCacheReady();
    if (input.runId !== runId) throw Object.assign(new Error("hardening run authority mismatch"), { code: "ENGINEER_HARDENING_AUTHORITY_INVALID" });
    const quote = await this.options.supervisor.createHardeningQuoteForOwner(principal.ownerId, input);
    return publicHardeningQuote(quote);
  }

  async getHardeningQuote(principal: EngineerPrincipal, runId: string, quoteId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    const quote = await this.options.supervisor.getHardeningQuoteForOwner(principal.ownerId, runId, quoteId);
    return publicHardeningQuote(quote);
  }

  async acceptHardeningConsent(principal: EngineerPrincipal, runId: string, input: {
    quoteId: string;
    quoteHash: string;
    authorizedBudget: HardeningBudget;
    acknowledgements: HardeningAcknowledgements;
    expectedParentStateVersion: number;
    idempotencyKey: string;
  }) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertHardeningPromptCacheReady();
    return this.options.supervisor.acceptHardeningConsentForOwner(principal.ownerId, runId, input);
  }

  async createOptionalHardeningChild(
    principal: EngineerPrincipal,
    parentRunId: string,
    input: OptionalHardeningChildRequest,
  ): Promise<OptionalHardeningChildCreation> {
    this.assertPrincipal(principal);
    this.assertOwner(parentRunId, principal);
    this.assertHardeningPromptCacheReady();
    const request = OptionalHardeningChildRequestSchema.parse(input);
    const creation = await this.options.supervisor.createOptionalHardeningChildForOwner(
      principal.ownerId,
      parentRunId,
      request,
    );
    return OptionalHardeningChildCreationSchema.parse(creation);
  }

  async startOptionalHardeningChild(principal:EngineerPrincipal,parentRunId:string,childRunId:string,input:import("@zintus/engineer").HardeningStartRequest){
    this.assertPrincipal(principal);this.assertOwner(parentRunId,principal);this.assertOwner(childRunId,principal);
    this.assertHardeningPromptCacheReady();
    if(!this.options.execution)throw new Error("Engineer hardening execution is not configured on this gateway");
    if(!this.options.verification)throw new Error("Engineer hardening verification is not configured on this gateway");
    const leaseAuthority=this.options.leaseManager;
    if(!leaseAuthority||!this.options.execution.usesWorkerLeaseAuthority(leaseAuthority)||
      !this.options.verification.usesWorkerLeaseAuthority(leaseAuthority)){
      throw Object.assign(new Error("Engineer hardening requires one shared durable worker-lease authority"),{
        code:"ENGINEER_HARDENING_WORKER_LEASE_AUTHORITY_UNAVAILABLE"});
    }
    const signer=this.options.checkpointAttestor??unavailableCheckpointAttestor;
    const prepared=await this.options.supervisor.prepareOptionalHardeningStartForOwner(principal.ownerId,parentRunId,childRunId,input);
    const startLaneStates=["REQUEST_RECEIVED","REQUEST_NORMALIZED","PLANNING","PLAN_READY","PLAN_FROZEN","QUEUED"];
    const beforeClaim=this.options.supervisor.getRun(childRunId);
    if(prepared.replay&&!startLaneStates.includes(beforeClaim.state)){
      const replay=this.options.supervisor.finalizeOptionalHardeningStart(prepared);
      return {run:replay.run,start:{operationId:prepared.operation.operationId,childRunId,createdAt:prepared.operation.createdAt},
        seed:{status:"VERIFIED" as const,seedAttestationId:prepared.signedSeed!.attestation.seedAttestationId,
          seedDiffHash:prepared.signedSeed!.attestation.seedDiffHash},status:replay.status};
    }
    const startClaim=this.options.supervisor.claimOptionalHardeningStart({
      requesterUserId:prepared.lineage.requesterUserId,rootRunId:prepared.lineage.rootRunId,parentRunId:prepared.lineage.parentRunId,
      childRunId:prepared.operation.childRunId,repositoryId:prepared.lineage.repositoryId,
      parentCheckpointId:prepared.parentCheckpoint.checkpointId,parentCheckpointHash:prepared.parentCheckpoint.checkpointHash,
      lineageId:prepared.lineage.lineageId,lineageHash:prepared.lineage.lineageHash,
      quoteId:prepared.authority.quoteId,quoteHash:prepared.authority.quoteHash,
      consentId:prepared.authority.consentId,consentHash:prepared.authority.consentHash,
      operationId:prepared.operation.operationId,operationHash:prepared.operation.operationHash,
      idempotencyKey:prepared.operation.idempotencyKey,
      ownerId:this.options.workerOwnerId??"engineer-hardening-start-worker",leaseMs:this.options.leaseTtlMs??120_000,
    });
    if(!startClaim.applied&&startClaim.fence.status==="PREPARING")throw new HardeningStartClaimBusyError();
    let committed=prepared;let pendingSeed=false;
    try{
      if(!prepared.replay){const signedSeed=await this.options.execution.materializeOptionalHardeningSeed(prepared,signer);pendingSeed=true;
        const preview=this.options.supervisor.previewOptionalHardeningStart({...prepared,signedSeed});
        if(preview.status!=="READY")throw new Error("hardening seed cannot commit without a deterministic frozen manifest");
        const durable=this.options.execution.prepareOptionalHardeningSeedCommit(childRunId,preview.manifest.manifestHash);
        committed=await this.options.supervisor.commitOptionalHardeningStartForOwner(principal.ownerId,parentRunId,childRunId,input,
          prepared.operation,signedSeed,{claimId:startClaim.fence.claimId,fenceToken:startClaim.fence.fenceToken,generation:startClaim.fence.generation},durable);
        this.options.execution.completeOptionalHardeningSeedCommit(childRunId);pendingSeed=false;
        this.recoveredHardeningAuthorities.add(childRunId);}
      else if(!(this.options.execution as EngineerExecutionManager&{hasOptionalHardeningAuthority?:(runId:string)=>boolean})
        .hasOptionalHardeningAuthority?.(childRunId)){
        const current=this.options.supervisor.getRun(childRunId);
        const recovered=await this.options.execution.recoverOptionalHardeningSeed(prepared);
        if(!recovered){
          if(!startLaneStates.includes(current.state))
            throw new Error("durable optional-hardening seed checkpoint is unavailable");
          await this.options.execution.materializeOptionalHardeningSeed(prepared,signer);pendingSeed=true;
        }else this.recoveredHardeningAuthorities.add(childRunId);
      }
      const finalized=this.options.supervisor.finalizeOptionalHardeningStart(committed);
      if(finalized.status==="ENVIRONMENT_BLOCKED")this.options.supervisor.recordOptionalHardeningStopped(childRunId,"ENVIRONMENT_BLOCKED");
    if(finalized.status==="READY"&&finalized.run.state==="PLAN_FROZEN"){const run=this.options.execution.enqueue(childRunId);this.clearError(childRunId);this.launchExecution(childRunId);
      return {run,start:{operationId:committed.operation.operationId,childRunId,createdAt:committed.operation.createdAt},
        seed:{status:"VERIFIED" as const,seedAttestationId:committed.signedSeed!.attestation.seedAttestationId,
          seedDiffHash:committed.signedSeed!.attestation.seedDiffHash},status:"STARTED" as const};}
    if(finalized.status==="READY"&&finalized.run.state==="QUEUED"){this.clearError(childRunId);this.launchExecution(childRunId);}
    return {run:finalized.run,start:{operationId:committed.operation.operationId,childRunId,createdAt:committed.operation.createdAt},
      seed:{status:"VERIFIED" as const,seedAttestationId:committed.signedSeed!.attestation.seedAttestationId,
        seedDiffHash:committed.signedSeed!.attestation.seedDiffHash},status:finalized.status};
    }catch(error){if(pendingSeed)await this.options.execution.discardOptionalHardeningSeed(childRunId);throw error;}
  }

  recoverOptionalHardeningStarts(runIds?:readonly string[]):Array<{runId:string;promise:Promise<unknown>}>
  {
    if(this.hardeningReadiness().state!=="READY")return [];
    const recoverable=new Set(["REQUEST_RECEIVED","REQUEST_NORMALIZED","PLANNING","PLAN_READY","PLAN_FROZEN","QUEUED"]);
    const committed=this.options.supervisor.listOptionalHardeningStartOperationsForOwner(this.options.principal.ownerId)
      .filter(({operation})=>!runIds||runIds.includes(operation.childRunId)).map(({parentRunId,operation})=>({
      parentRunId,childRunId:operation.childRunId,input:{expectedChildStateVersion:operation.expectedChildStateVersion,
        lineageId:operation.lineageId,lineageHash:operation.lineageHash,idempotencyKey:operation.idempotencyKey},
    }));
    const committedChildren=new Set(committed.map((item)=>item.childRunId));
    const pending=this.options.supervisor.listOptionalHardeningStartClaimsForRecovery(this.options.principal.ownerId)
      .filter((item)=>(!runIds||runIds.includes(item.childRunId))&&!committedChildren.has(item.childRunId));
    const immediate=committed.flatMap(({parentRunId,childRunId,input})=>{
      const run=this.options.supervisor.getRun(childRunId);if(!recoverable.has(run.state))return [];
      if(this.options.supervisor.hasOutstandingHardeningPaidCallRecoveryWork?.(childRunId))return [];
      const execution=this.options.execution as (EngineerExecutionManager&{hasOptionalHardeningAuthority?:(runId:string)=>boolean})|undefined;
      if(this.recoveredHardeningAuthorities.has(childRunId)||execution?.hasOptionalHardeningAuthority?.(childRunId))return [];
      return [{runId:childRunId,promise:this.startOptionalHardeningChild(this.options.principal,parentRunId,childRunId,input)}];
    });
    const scheduled=pending.flatMap(({parentRunId,childRunId,input,leaseExpiresAt})=>{
      const run=this.options.supervisor.getRun(childRunId);if(!recoverable.has(run.state))return [];
      if(this.options.supervisor.hasOutstandingHardeningPaidCallRecoveryWork?.(childRunId))return [];
      let promise=this.hardeningRecovery.get(childRunId);if(!promise){const now=(this.options.now??(()=>new Date()))().getTime();
        const delay=Math.max(0,Date.parse(leaseExpiresAt)-now);
        promise=new Promise<void>((resolve)=>setTimeout(resolve,delay)).then(()=>
          this.startOptionalHardeningChild(this.options.principal,parentRunId,childRunId,input));
        this.hardeningRecovery.set(childRunId,promise);void promise.then(()=>{if(this.hardeningRecovery.get(childRunId)===promise)this.hardeningRecovery.delete(childRunId);},
          ()=>{if(this.hardeningRecovery.get(childRunId)===promise)this.hardeningRecovery.delete(childRunId);});}
      return [{runId:childRunId,promise}];});
    return [...immediate,...scheduled];
  }

  recoverOptionalHardeningVerification(runIds?:readonly string[]):Array<{runId:string;promise:Promise<unknown>}>{
    if(this.hardeningReadiness().state!=="READY"||!this.options.execution||!this.options.verification)return [];
    const recoverable=new Set(["FAST_CHECKS","UNIT_TESTING","INTEGRATION_TESTING","E2E_TESTING","FLAKE_QUARANTINE",
      "SECURITY_REVIEW","CODE_REVIEW","EVIDENCE_SYNTHESIS","REVIEWING","VERIFICATION_RECOVERY"]);
    return this.options.supervisor.listOptionalHardeningStartOperationsForOwner(this.options.principal.ownerId).flatMap(({parentRunId,operation})=>{
      if(runIds&&!runIds.includes(operation.childRunId))return [];
      const run=this.options.supervisor.getRun(operation.childRunId);
      if(!recoverable.has(run.state)||run.terminalAt||this.options.supervisor.hasOutstandingHardeningPaidCallRecoveryWork(run.runId))return [];
      const input={expectedChildStateVersion:operation.expectedChildStateVersion,lineageId:operation.lineageId,
        lineageHash:operation.lineageHash,idempotencyKey:operation.idempotencyKey};
      const promise:Promise<unknown>=(async()=>{
          try{
            const preparation=await this.options.supervisor.prepareOptionalHardeningStartForOwner(
              this.options.principal.ownerId,parentRunId,run.runId,input);
            const snapshot=this.options.execution!.prepareOptionalHardeningWorkspaceRecovery(preparation);
            return this.options.verification!.resumeOptionalHardeningRecovered(snapshot);
          }catch(error){
            if(!(error instanceof HardeningGenericOperationForbiddenError))throw error;
            const current=this.options.supervisor.getRun(run.runId);
            // Cancellation and any concurrent state owner take precedence over
            // a stale read-only recovery preflight. Never turn a user's stop
            // intent into a security failure.
            if(current.terminalAt||["CANCELLATION_PENDING","CANCELLED"].includes(current.state)||
              current.state!==run.state||current.stateVersion!==run.stateVersion)return current;
            const reasonCode=current.state==="REVIEWING"
              ?"HARDENING_REVIEWER_RECOVERY_AUTHORITY_INVALID" as const
              :"HARDENING_WORKSPACE_RECOVERY_AUTHORITY_INVALID" as const;
            this.options.supervisor.quarantineOptionalHardeningRecovery({runId:run.runId,
              expectedStateVersion:current.stateVersion,reasonCode});
            throw reasonCode==="HARDENING_REVIEWER_RECOVERY_AUTHORITY_INVALID"
              ?new HardeningReviewerRecoveryAuthorityInvalidError(run.runId)
              :new HardeningWorkspaceRecoveryAuthorityInvalidError(run.runId);
          }
        })();
      return [{runId:run.runId,promise}];
    });
  }

  repositories(principal: EngineerPrincipal): RepositoryReference[] {
    this.assertPrincipal(principal);
    return this.options.preflight.repositories();
  }

  async create(principal: EngineerPrincipal, input: {
    runId?: string;
    repository: RepositoryReference;
    request: string;
    budget?: Partial<EngineerBudgetSelection>;
  }): Promise<EngineerRun> {
    this.assertPrincipal(principal);
    const repository = RepositoryReferenceSchema.parse(input.repository);
    await this.options.preflight.assertRunAdmission(repository);
    return this.options.supervisor.receiveRequest({
      ...input,
      userId: principal.ownerId,
      repository,
    });
  }

  get(runId: string): { run: EngineerRun; budget: EngineerBudgetSnapshot; lastError: string | null; activity: { active: boolean; role: "PLANNER" | "BUILDER" | "VERIFIER" | null; detail: string } } {
    this.assertOwner(runId, this.options.principal);
    const budget = this.options.supervisor.reconcileBudget(runId);
    const run = this.options.supervisor.getRun(runId);
    const workflowCanBeActive=!run.terminalAt&&run.state!=="CANCELLATION_PENDING";
    const activity = workflowCanBeActive&&this.activePlanning.has(runId)
      ? { active: true, role: "PLANNER" as const, detail: "Planner model request or reconciliation is active." }
      : workflowCanBeActive&&this.options.execution?.isActive(runId)
        ? { active: true, role: "BUILDER" as const, detail: "Builder model or sandbox tool work is active." }
        : workflowCanBeActive&&this.options.verification?.isActive(runId)
          ? { active: true, role: "VERIFIER" as const, detail: "Independent verification or review is active." }
          : { active: false, role: null, detail: run.state === "PAUSED_BUDGET" ? "Checkpoint retained; no worker is consuming model budget." : "No worker is currently active for this run." };
    const durableLastError = this.options.supervisor.getLastError(runId);
    const legacySafePauseError = run.state === "PAUSED_BUDGET" && durableLastError !== null &&
      / paused safely: (?:TOKEN_LIMIT_REACHED|COST_LIMIT_REACHED|TIME_LIMIT_REACHED)$/.test(durableLastError);
    return { run, budget, lastError: legacySafePauseError ? null : durableLastError, activity };
  }

  /** One ownership-checked projection for the active UI; individual routes remain for compatibility. */
  async snapshot(principal: EngineerPrincipal, runId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const beforeRun = this.options.supervisor.getRun(runId);
      const beforeSequence = this.options.supervisor.latestEventSequence(runId);
      const errors: Array<{ section: string; message: string }> = [];
      const section = <T>(name: string, read: () => T, fallback: T): T => {
        try { return read(); }
        catch (error) {
          errors.push({ section: name, message: redactSecrets(error instanceof Error ? error.message : String(error)) });
          return fallback;
        }
      };
      const events = this.options.supervisor.listEvents(runId, Math.max(0, beforeSequence - 500), 500);
      const reachedImplementation = events.some((event) => [
        "IMPLEMENTING", "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING",
        "VERIFICATION_RECOVERY", "REVERIFYING",
      ].includes(event.nextState));
      const reachedVerification = events.some((event) => [
        "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "FLAKE_QUARANTINE",
        "SECURITY_REVIEW", "CODE_REVIEW", "EVIDENCE_SYNTHESIS", "REVIEWING", "REVIEW_APPROVED",
        "REVIEW_CHANGES_REQUESTED", "REVIEW_REJECTED", "HUMAN_REVIEW_REQUIRED", "HUMAN_APPROVAL_PENDING",
        "HUMAN_APPROVED", "PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "COMPLETED",
      ].includes(event.nextState));
      const reachedReviewDecision = events.some((event) => [
        "REVIEW_APPROVED", "REVIEW_CHANGES_REQUESTED", "REVIEW_REJECTED", "HUMAN_REVIEW_REQUIRED",
        "HUMAN_APPROVAL_PENDING", "HUMAN_APPROVED", "PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "COMPLETED",
      ].includes(event.nextState));
      const status = this.get(runId);
      const reviewBinding = reachedReviewDecision ? section<{
        reviewerSessionId: string;
        reviewerDecision: string;
        reviewerDiffHash: string;
        reviewerEvidenceBundleHash: string;
        reviewerIsolationVerified: boolean;
        evidenceBundleId: string;
        evidenceBundleHash: string;
      } | null>("reviewBinding", () => {
        const evidence = this.options.supervisor.getPublicationEvidence(runId);
        return {
          reviewerSessionId: evidence.reviewerSessionId,
          reviewerDecision: evidence.reviewerDecision,
          reviewerDiffHash: evidence.reviewerDiffHash,
          reviewerEvidenceBundleHash: evidence.reviewerEvidenceBundleHash,
          reviewerIsolationVerified: evidence.reviewerIsolationVerified,
          evidenceBundleId: evidence.evidenceBundleId,
          evidenceBundleHash: evidence.evidenceBundleHash,
        };
      }, null) : null;
      const approval = reachedVerification ? section("approval", () => this.approval(runId), null) : null;
      const approvalAuthority = approval?.status === "PENDING" &&
          approval.verifiedCheckpointId && approval.verifiedCheckpointHash
        ? {
            expectedVerifiedCheckpointId: approval.verifiedCheckpointId,
            expectedVerifiedCheckpointHash: approval.verifiedCheckpointHash,
            expectedApprovalRevision: approval.approvalRevision,
          }
        : null;
      // This strict verification is deliberately outside the best-effort
      // section projector. A promoted but corrupt checkpoint must fail the
      // entire snapshot rather than silently disappearing from the UI.
      const verifiedCandidate = await this.checkpoint(principal, runId);
      const data = {
        artifacts: section("artifacts", () => this.artifacts(runId), []),
        claims: reachedVerification ? section("claims", () => this.claims(runId), []) : [],
        evidenceBundles: reachedVerification ? section("evidence", () => this.evidenceBundles(runId), []) : [],
        tests: reachedVerification ? section("tests", () => this.tests(runId), []) : [],
        securityFindings: reachedVerification ? section("security", () => this.security(runId), []) : [],
        failures: section("failures", () => this.failures(runId), []),
        gitOperations: reachedVerification ? section("publication", () => this.gitOperations(runId), []) : [],
        diff: reachedImplementation ? section("diff", () => this.diff(runId), "") : "",
        approval,
        approvalAuthority,
        verifiedCandidate,
        decisions: section("decisions", () => this.decisions(principal, runId), []),
        reviewBinding,
        errors,
      };
      const afterSequence = this.options.supervisor.latestEventSequence(runId);
      const afterRun = this.options.supervisor.getRun(runId);
      const lastEvent = events.at(-1);
      const coherent = beforeSequence === afterSequence &&
        beforeRun.stateVersion === afterRun.stateVersion &&
        status.run.stateVersion === afterRun.stateVersion && status.run.state === afterRun.state &&
        (afterSequence === 0
          ? events.length === 0 && afterRun.stateVersion === 0
          : lastEvent?.sequence === afterSequence && lastEvent.stateVersion === afterRun.stateVersion && lastEvent.nextState === afterRun.state);
      if (coherent) {
        return {
          status,
          events,
          latestEventSequence: afterSequence,
          snapshotFence: { stateVersion: afterRun.stateVersion, eventSequence: afterSequence },
          data,
        };
      }
    }
    throw new Error("Engineer run changed repeatedly while building a consistent snapshot; retry the read");
  }

  async checkpoint(principal: EngineerPrincipal, runId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    const attestor = this.options.checkpointAttestor ?? unavailableCheckpointAttestor;
    const authority = this.options.supervisor.isOptionalHardeningChild?.(runId) === true
      ? await this.options.supervisor.getVerifiedHardeningCandidateCheckpoint({ runId }, attestor)
      : await this.options.supervisor.getVerifiedCandidateCheckpoint({ runId }, attestor);
    return authority ? verifiedCandidateSummary(authority.checkpoint) : null;
  }

  approvalAuthority(runId: string) {
    const approval = this.approval(runId);
    return this.authorityForApproval(approval);
  }

  approvalView(runId: string) {
    const approval = this.approval(runId);
    return { approval, approvalAuthority: this.authorityForApproval(approval) };
  }

  private authorityForApproval(approval: ReturnType<EngineerRunManager["approval"]>) {
    if (approval?.status !== "PENDING" || !approval.verifiedCheckpointId || !approval.verifiedCheckpointHash) return null;
    return {
      expectedVerifiedCheckpointId: approval.verifiedCheckpointId,
      expectedVerifiedCheckpointHash: approval.verifiedCheckpointHash,
      expectedApprovalRevision: approval.approvalRevision,
    };
  }

  budget(principal: EngineerPrincipal, runId: string): EngineerBudgetSnapshot {
    this.assertOwner(runId, principal);
    return this.options.supervisor.reconcileBudget(runId);
  }

  topUpBudget(principal: EngineerPrincipal, runId: string, input: {
    expectedRevision: number; topUp: BudgetTopUp; idempotencyKey: string;
  }): EngineerBudgetSnapshot {
    this.assertOwner(runId, principal);
    this.assertHardeningBudgetIsNotExtended(runId);
    return this.options.supervisor.topUpBudget({ runId, ...input, actorId: principal.ownerId });
  }

  async resumeBudget(principal: EngineerPrincipal, runId: string, input: {
    expectedStateVersion: number; expectedBudgetRevision: number; idempotencyKey: string;
  }): Promise<EngineerRun> {
    this.assertOwner(runId, principal);
    this.assertHardeningBudgetIsNotExtended(runId);
    const verificationOwnedCheckpoint = this.options.verification?.ownsBudgetCheckpoint(runId) ?? false;
    const result = this.options.supervisor.resumeBudget({ runId, ...input, actorId: principal.ownerId });
    this.clearError(runId);
    if (result.run.state === "PLANNING" && this.options.planning) {
      const job = (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await this.plan(principal, runId);
      })().catch(() => { /* plan() persists actionable failures; safe budget pauses are already durable */ });
      this.background.add(job);
      void job.finally(() => this.background.delete(job));
    } else if (result.run.state === "IMPLEMENTING" && verificationOwnedCheckpoint && this.options.verification) {
      this.launchVerificationRecovery(runId);
    } else if (result.run.state === "IMPLEMENTING" && this.options.execution) {
      const queued = await this.options.execution.resumeBudgetCheckpoint(runId);
      this.launchExecution(runId);
      return queued;
    } else if (this.options.verification && [
      "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "FLAKE_QUARANTINE",
      "SECURITY_REVIEW", "CODE_REVIEW", "EVIDENCE_SYNTHESIS", "REVIEWING",
      "REVIEW_CHANGES_REQUESTED", "REVIEW_FIX_PREPARING", "VERIFICATION_RECOVERY", "REVERIFYING",
    ].includes(result.run.state)) {
      this.launchVerificationRecovery(runId);
    }
    return result.run;
  }

  private launchVerificationRecovery(runId: string): void {
    if (!this.options.verification) return;
    const job = this.options.verification.resumeBudgetCheckpoint(runId)
      .then(() => undefined)
      .catch((error) => {
        if (!(error instanceof BudgetPausedError)) {
          this.options.supervisor.setLastError(runId, redactSecrets(error instanceof Error ? error.message : String(error)));
        }
      });
    this.background.add(job);
    void job.finally(() => this.background.delete(job));
  }

  list(principal: EngineerPrincipal): EngineerRun[] {
    this.assertPrincipal(principal);
    // Compatibility path: callers of the original list API receive the full
    // owner-scoped history. New UIs should use listPage for bounded reads.
    return this.options.supervisor.listRuns().filter((run) => run.userId === principal.ownerId).reverse();
  }

  listPage(principal: EngineerPrincipal, input: { limit: number; before?: { createdAt: string; runId: string } }) {
    this.assertPrincipal(principal);
    const rows = this.options.supervisor.listRunsForUser(principal.ownerId, Math.min(100, input.limit + 1), input.before);
    const hasMore = rows.length > input.limit;
    const runs = rows.slice(0, input.limit);
    const last = runs.at(-1);
    return { runs, nextCursor: hasMore && last ? Buffer.from(JSON.stringify([last.createdAt, last.runId])).toString("base64url") : null };
  }

  observability() { return engineerObservabilitySnapshot(this.options.supervisor, new Date(), this.options.principal.ownerId); }

  reviewApprovedEndsStream(): boolean { return !this.options.publication; }

  async freeze(principal: EngineerPrincipal, runId: string, input: {
    expectedStateVersion: number;
    manifest: TaskManifestContent;
    idempotencyKey: string;
  }): Promise<EngineerRun> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    return this.options.supervisor.freezePlan({
      runId,
      expectedStateVersion: input.expectedStateVersion,
      manifest: TaskManifestContentSchema.parse(input.manifest),
      actorId: principal.reviewerId,
      idempotencyKey: input.idempotencyKey,
    }).run;
  }

  async plan(principal: EngineerPrincipal, runId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    if (!this.options.context) throw new Error("Engineer context is not configured on this gateway");
    if (!this.options.planning) throw new Error("Engineer planning is not configured on this gateway");
    if (this.activePlanning.has(runId)) throw new Error("Evidence planning is already active for this run");
    const cancellation = new AbortController();
    const leaseOwnerId = this.options.workerOwnerId ?? "engineer-planning-worker";
    let lease: WorkerLeaseGrant | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (this.options.leaseManager) {
      lease = this.options.leaseManager.acquire({
        resourceKey: `run:${runId}`,
        ownerId: leaseOwnerId,
        ttlMs: this.options.leaseTtlMs ?? 30_000,
        idempotencyKey: `plan:${runId}:${this.options.supervisor.getRun(runId).stateVersion}`,
      });
      let heartbeatSequence = 0;
      heartbeatTimer = setInterval(() => {
        if (!lease) return;
        heartbeatSequence += 1;
        try {
          const record = this.options.leaseManager!.heartbeat({
            leaseId: lease.lease.leaseId,
            ownerId: leaseOwnerId,
            fencingToken: lease.lease.fencingToken,
            leaseToken: lease.leaseToken,
            idempotencyKey: `plan-heartbeat:${heartbeatSequence}`,
          });
          lease = { ...lease, lease: record };
        } catch (error) {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          cancellation.abort(error);
        }
      }, this.options.heartbeatIntervalMs ?? 10_000);
      heartbeatTimer.unref?.();
    }
    let planningAuthorityRevoked=false;
    const revokePlanningAuthority=()=>{
      if(planningAuthorityRevoked)return;planningAuthorityRevoked=true;
      cancellation.abort(new EngineerPlanningCancelledError());
      if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null;}
      if(lease&&this.options.leaseManager){
        try{this.options.leaseManager.release({leaseId:lease.lease.leaseId,ownerId:leaseOwnerId,
          fencingToken:lease.lease.fencingToken,leaseToken:lease.leaseToken,
          idempotencyKey:`plan-cancel-release:${lease.lease.renewalCount}`});}catch{/* expiry/recovery already revoked it */}
        lease=null;
      }
    };
    this.activePlanningRevocations.set(runId,revokePlanningAuthority);
    this.activePlanning.set(runId, cancellation);
    let markPlanningSettled!: () => void;
    const planningSettled = new Promise<void>((resolve) => { markPlanningSettled = resolve; });
    this.activePlanningSettled.set(runId, planningSettled);
    const assertPlanningAuthority = () => {
      if (planningAuthorityRevoked||cancellation.signal.aborted) throw new EngineerPlanningCancelledError();
      if (lease && this.options.leaseManager) {
        try {
          this.options.leaseManager.assertActive({
            leaseId: lease.lease.leaseId,
            ownerId: leaseOwnerId,
            fencingToken: lease.lease.fencingToken,
            leaseToken: lease.leaseToken,
          });
        } catch {
          cancellation.abort(new EngineerPlanningCancelledError());
          throw new EngineerPlanningCancelledError();
        }
      }
    };
    this.beginPlanning(runId);
    this.clearError(runId);
    const failureCountBefore = this.options.supervisor.listFailures(runId).length;
    try {
      await this.options.context.build(runId);
      assertPlanningAuthority();
      const plan = await this.options.planning.plan(runId, cancellation.signal, assertPlanningAuthority);
      assertPlanningAuthority();
      this.clearError(runId);
      return plan;
    } catch (error) {
      if (cancellation.signal.aborted || error instanceof EngineerPlanningCancelledError) {
        this.clearError(runId);
        throw error instanceof EngineerPlanningCancelledError ? error : new EngineerPlanningCancelledError();
      }
      if (error instanceof BudgetPausedError) {
        this.clearError(runId);
        throw error;
      }
      if (isProviderModelTimeout(error) || error instanceof EngineerPlanningTimeoutError) {
        const message = this.persistError(runId, error);
        const current = this.options.supervisor.getRun(runId);
        this.options.supervisor.recordFailure(FailureRecordSchema.parse({
          failureId: randomUUID(), runId, failureClass: "MODEL_FAILURE",
          reasonCode: "PLANNING_PROVIDER_OUTCOME_AMBIGUOUS",
          fingerprint: sha256({ reasonCode: "PLANNING_PROVIDER_OUTCOME_AMBIGUOUS", message }),
          evidenceIds: [], retryable: true, createdAt: new Date().toISOString(),
        }));
        if (canTransition(current.state, "MODEL_PROVIDER_RETRY_PENDING")) {
          this.options.supervisor.transition({
            runId, expectedStateVersion: current.stateVersion, nextState: "MODEL_PROVIDER_RETRY_PENDING",
            reasonCode: "PLANNING_PROVIDER_OUTCOME_AMBIGUOUS",
            idempotencyKey: `planning-provider-timeout:${current.stateVersion}`,
          });
        }
        throw error;
      }
      const message = this.persistError(runId, error);
      const failures = this.options.supervisor.listFailures(runId);
      if (failures.length === failureCountBefore) {
        this.options.supervisor.recordFailure(FailureRecordSchema.parse({
          failureId: randomUUID(),
          runId,
          failureClass: "WORKFLOW_FAILURE",
          reasonCode: "PLANNING_PIPELINE_FAILED",
          fingerprint: sha256({ reasonCode: "PLANNING_PIPELINE_FAILED", message }),
          evidenceIds: [],
          retryable: !(error instanceof EngineerPlanningTimeoutError),
          createdAt: new Date().toISOString(),
        }));
      }
      const latestFailure = this.options.supervisor.listFailures(runId).at(-1);
      const current = this.options.supervisor.getRun(runId);
      const timedOut = error instanceof EngineerPlanningTimeoutError;
      const terminalFailure = timedOut || latestFailure?.retryable === false || current.state === "REPLANNING";
      const nextState = terminalFailure ? "FAILED" : "REPLANNING";
      if (canTransition(current.state, nextState)) {
        this.options.supervisor.transition({
          runId,
          expectedStateVersion: current.stateVersion,
          nextState,
          reasonCode: timedOut ? "PLANNING_STEP_TIMED_OUT" : terminalFailure ? "PLANNING_FAILED" : "PLANNING_RETRY_REQUIRED",
          idempotencyKey: `gateway:planning-error:${current.stateVersion}:${latestFailure?.fingerprint ?? sha256(message)}`,
        });
      }
      throw error;
    } finally {
      if(this.activePlanningRevocations.get(runId)===revokePlanningAuthority)this.activePlanningRevocations.delete(runId);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (lease && this.options.leaseManager) {
        try {
          this.options.leaseManager.release({
            leaseId: lease.lease.leaseId,
            ownerId: leaseOwnerId,
            fencingToken: lease.lease.fencingToken,
            leaseToken: lease.leaseToken,
            idempotencyKey: `plan-release:${lease.lease.renewalCount}`,
          });
        } catch { /* expired/fenced planning authority is already revoked */ }
      }
      if (this.activePlanning.get(runId) === cancellation) this.activePlanning.delete(runId);
      if (this.activePlanningSettled.get(runId) === planningSettled) this.activePlanningSettled.delete(runId);
      markPlanningSettled();
    }
  }

  recoverPlanning(): Array<{ runId: string; promise: Promise<unknown> }> {
    const recoveries: Array<{ runId: string; promise: Promise<unknown> }> = [];
    for (const run of this.options.supervisor.listRuns(["PLANNING", "REPLANNING"])) {
      if(this.options.supervisor.isOptionalHardeningChild(run.runId))continue;
      const runningPlanner = (this.options.supervisor.exportRunRecords(run.runId)?.agent_executions ?? [])
        .some((agent) => agent.role === "PLANNER" && agent.status === "RUNNING");
      if (runningPlanner) {
        const now = new Date().toISOString();
        this.options.supervisor.finalizeRunningAgentExecutions(run.runId, "FAILED", "PLANNING_PROCESS_INTERRUPTED", now);
        this.options.supervisor.recordFailure(FailureRecordSchema.parse({
          failureId: randomUUID(), runId: run.runId, failureClass: "MODEL_FAILURE",
          reasonCode: "PLANNING_PROVIDER_OUTCOME_AMBIGUOUS",
          fingerprint: sha256({ runId: run.runId, stateVersion: run.stateVersion, reason: "PLANNING_PROVIDER_OUTCOME_AMBIGUOUS" }),
          evidenceIds: [], retryable: true, createdAt: now,
        }));
        this.options.supervisor.transition({
          runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "MODEL_PROVIDER_RETRY_PENDING",
          reasonCode: "PLANNING_PROVIDER_OUTCOME_AMBIGUOUS",
          idempotencyKey: `planning-provider-ambiguous:${run.stateVersion}`,
        });
        continue;
      }
      recoveries.push({ runId: run.runId, promise: this.plan(this.options.principal, run.runId) });
    }
    return recoveries;
  }

  /**
   * Reclaims a cancellation that was durably committed before the gateway
   * crashed. A live run lease is never displaced: the worker watchdog calls
   * resumeCancellation after that authority expires. No user retry and no
   * provider transport are involved.
   */
  recoverPendingCancellations(): Array<{ runId: string; promise: Promise<void> }> {
    const recoveries: Array<{ runId: string; promise: Promise<void> }> = [];
    for (const run of this.options.supervisor.listRuns(["CANCELLATION_PENDING"])) {
      const promise = this.startCancellationRecovery(run.runId);
      if (promise) recoveries.push({ runId: run.runId, promise });
    }
    return recoveries;
  }

  /** Watchdog continuation for a run whose previous worker lease expired. */
  resumeCancellation(runId: string): void {
    void this.startCancellationRecovery(runId)?.catch(() => undefined);
  }

  private startCancellationRecovery(runId: string): Promise<void> | null {
    const existing = this.cancellationRecovery.get(runId);
    if (existing) return existing;
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "CANCELLATION_PENDING") return null;
    const promise = this.recoverPendingCancellation(runId).finally(() => {
      if (this.cancellationRecovery.get(runId) === promise) this.cancellationRecovery.delete(runId);
    });
    this.cancellationRecovery.set(runId, promise);
    this.background.add(promise);
    void promise.finally(() => this.background.delete(promise));
    return promise;
  }

  private async recoverPendingCancellation(runId: string): Promise<void> {
    this.activePlanningRevocations.get(runId)?.();
    this.activePlanning.get(runId)?.abort(new EngineerPlanningCancelledError());
    this.options.execution?.cancel?.(runId);
    this.options.verification?.cancel?.(runId);
    try {
      await this.completeCancellation(runId);
    } finally {
      this.options.execution?.finishCancellation?.(runId);
      this.options.verification?.finishCancellation?.(runId);
    }
  }

  resumePlanning(runId: string): void {
    const active = this.activePlanning.get(runId);
    if (active) {
      active.abort(new EngineerPlanningCancelledError());
      const settled = this.activePlanningSettled.get(runId);
      if (settled) void settled.finally(() => this.resumePlanning(runId));
      return;
    }
    const run = this.options.supervisor.getRun(runId);
    if (["PLANNING", "REPLANNING"].includes(run.state)) {
      void this.plan(this.options.principal, runId).catch(() => undefined);
    }
  }

  planProposal(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.latestPlanProposal(runId);
  }

  async start(principal: EngineerPrincipal, runId: string): Promise<EngineerRun> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    if (!this.options.execution) throw new Error("Engineer execution is not configured on this gateway");
    const run = this.options.execution.enqueue(runId);
    this.clearError(runId);
    this.launchExecution(runId);
    return run;
  }

  async retryProviderTimeout(principal: EngineerPrincipal, runId: string): Promise<EngineerRun> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    const pending = this.options.supervisor.getRun(runId);
    const reason = this.options.supervisor.listEvents(runId).at(-1)?.reasonCode;
    if (reason === "PLANNING_PROVIDER_OUTCOME_AMBIGUOUS") {
      const run = this.options.supervisor.transition({
        runId, expectedStateVersion: pending.stateVersion, nextState: "PLANNING",
        reasonCode: "HUMAN_RETRY_PLANNING_PROVIDER", idempotencyKey: `human-retry-planning:${pending.stateVersion}`,
      }).run;
      this.clearError(runId);
      this.resumePlanning(runId);
      return run;
    }
    if (reason === "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS") {
      if (!this.options.verification) throw new Error("Engineer verification is not configured on this gateway");
      const run = this.options.supervisor.transition({
        runId, expectedStateVersion: pending.stateVersion, nextState: "SECURITY_REVIEW",
        reasonCode: "HUMAN_RETRY_VERIFICATION_PROVIDER", idempotencyKey: `human-retry-verification:${pending.stateVersion}`,
      }).run;
      this.clearError(runId);
      this.options.verification.resumeRecovered(runId);
      return run;
    }
    if (!this.options.execution) throw new Error("Engineer execution is not configured on this gateway");
    const run = await this.options.execution.retryProviderTimeout(runId);
    this.clearError(runId);
    this.launchExecution(runId);
    return run;
  }

  private launchExecution(runId: string): void {
    const job = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.draining) throw new Error("Engineer gateway is draining");
      await this.options.execution!.runQueued(runId).then(async () => {
        if (this.options.verification) await this.options.verification.verify(runId);
        if (this.options.publication && !this.options.supervisor.isOptionalHardeningChild(runId) &&
            this.options.supervisor.getRun(runId).state === "REVIEW_APPROVED") {
          await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
          await this.options.publication.start(runId, this.options.principal.reviewerId);
        }
      });
    })().catch((error) => {
      if(this.options.supervisor.isOptionalHardeningChild(runId)){
        const message=error instanceof Error?`${error.name} ${error.message}`:String(error);
        const reason=error instanceof BudgetPausedError?"BUDGET_EXHAUSTED":/timeout/i.test(message)?"TIMED_OUT":
          /security|scope|policy/i.test(message)?"SECURITY_BLOCKED":/environment|sandbox|docker|dependency/i.test(message)?"ENVIRONMENT_BLOCKED":"FAILED";
        try{this.options.supervisor.recordOptionalHardeningStopped(runId,reason);}catch{/* preserve the primary execution failure */}
      }
      if (error instanceof BudgetPausedError) this.clearError(runId);
      else this.persistError(runId, error);
    });
    this.background.add(job);
    void job.finally(() => this.background.delete(job));
  }

  /** Recreates stale work as a new immutable run on the credentialed current base. */
  async recoverStaleBase(principal: EngineerPrincipal, runId: string): Promise<{ supersededRun: EngineerRun; replacementRun: EngineerRun }> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    if (!this.options.publication || !this.options.planning || !this.options.context || !this.options.execution || !this.options.artifactStore) {
      throw new Error("stale-base recovery is not configured on this gateway");
    }
    const staleRun = this.options.supervisor.getRun(runId);
    const repository = await this.options.publication.replacementRepositoryForStale(runId);
    this.options.preflight.acceptAdvancedBase(staleRun.repository.baseCommitSha, repository);
    const replacementRunId = `recovery-${sha256({ runId, baseCommitSha: repository.baseCommitSha }).slice(0, 32)}`;
    let replacement = this.options.supervisor.listRuns().find((item) => item.runId === replacementRunId);
    if (!replacement) {
      replacement = this.options.supervisor.receiveRequest({
        runId: replacementRunId,
        userId: principal.ownerId,
        repository,
        request: staleRun.requestOriginal,
      });
    }
    if (replacement.state === "REQUEST_RECEIVED" || replacement.state === "PLANNING" || replacement.state === "REPLANNING") {
      const proposal = await this.plan(principal, replacement.runId);
      replacement = this.options.supervisor.getRun(replacement.runId);
      if (replacement.state === "PLAN_READY") {
        replacement = this.options.supervisor.freezePlan({
          runId: replacement.runId,
          expectedStateVersion: replacement.stateVersion,
          manifest: proposal.manifest,
          actorId: "engineer-supervisor",
          idempotencyKey: `stale-recovery:freeze:${replacement.runId}:${proposal.manifest.manifestVersion}`,
        }).run;
      }
    }
    if (replacement.state === "PLAN_FROZEN") replacement = await this.start(principal, replacement.runId);

    const relation = this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId,
      type: "STALE_BASE_REPLACEMENT",
      bytes: JSON.stringify({ replacementRunId: replacement.runId, previousBaseCommitSha: staleRun.repository.baseCommitSha, currentBaseCommitSha: repository.baseCommitSha }),
      producerType: "SYSTEM",
      producerId: "engineer-supervisor",
      trusted: true,
    }));
    const currentStale = this.options.supervisor.getRun(runId);
    const supersededRun = currentStale.state === "BASE_BRANCH_STALE"
      ? this.options.supervisor.transition({
          runId,
          expectedStateVersion: currentStale.stateVersion,
          nextState: "HUMAN_REVIEW_REQUIRED",
          reasonCode: "STALE_BASE_SUPERSEDED_BY_REPLACEMENT_RUN",
          evidenceIds: [relation.artifactId],
          manifestHash: currentStale.manifestHash,
          idempotencyKey: `stale-recovery:supersede:${replacement.runId}`,
        }).run
      : currentStale;
    return { supersededRun, replacementRun: replacement };
  }

  /**
   * Creates a distinct run with the exact original request and acceptance
   * criteria. Only bounded, policy-defined corrections derived from durable
   * findings/failures cross into the replacement run.
   */
  async createCorrectedRun(principal: EngineerPrincipal, runId: string): Promise<{
    sourceRun: EngineerRun;
    replacementRun: EngineerRun;
    plan: Awaited<ReturnType<EngineerPlanningManager["plan"]>>;
  }> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    if (!this.options.planning || !this.options.context || !this.options.artifactStore) {
      throw new Error("corrected-run recovery is not configured on this gateway");
    }
    const sourceRun = this.options.supervisor.getRun(runId);
    if (!["SECURITY_ESCALATION", "VERIFICATION_INCOMPLETE", "REJECTED", "REVIEW_REJECTED", "FAILED"].includes(sourceRun.state)) {
      throw new Error(`corrected-run recovery is not available from ${sourceRun.state}`);
    }
    const sourceManifest = this.options.supervisor.getManifest(runId);
    if (!sourceManifest) throw new Error("corrected-run recovery requires the original frozen manifest");
    const replacementRepository = correctedRunRepository(sourceRun.repository, this.options.preflight.repository());
    await this.options.preflight.assertRunAdmission(replacementRepository);

    const actions = this.deriveSafeCorrections(runId, sourceManifest.allowedPaths);
    if (actions.length === 0) {
      throw new Error("no structured safe correction is available for this run; inspect the evidence and create a bounded new request");
    }
    const replacementRunId = `corrected-${sha256({
      sourceRunId: runId,
      sourceManifestHash: sourceManifest.manifestHash,
      baseCommitSha: replacementRepository.baseCommitSha,
      actions,
    }).slice("sha256:".length, "sha256:".length + 32)}`;
    let replacement = this.options.supervisor.listRuns().find((candidate) => candidate.runId === replacementRunId);
    if (!replacement) {
      const sourceBudget = this.options.supervisor.getBudget(runId);
      if (sourceBudget.remaining.costUsd <= 0 || sourceBudget.remaining.tokens <= 0 || sourceBudget.remaining.timeSeconds <= 0) {
        throw new Error("corrected-run recovery requires remaining budget; explicitly authorize a new bounded run instead");
      }
      replacement = this.options.supervisor.receiveRequest({
        runId: replacementRunId,
        userId: principal.ownerId,
        repository: replacementRepository,
        request: sourceRun.requestOriginal,
        // A correction is a continuation of the original attempt, never an
        // opportunity to reset or silently enlarge the user's hard cap.
        budget: {
          costBudgetUsd: sourceBudget.remaining.costUsd,
          tokenBudget: sourceBudget.remaining.tokens,
          timeBudgetSeconds: sourceBudget.remaining.timeSeconds,
          lifetimeCostBudgetUsd: sourceBudget.remaining.costUsd,
          lifetimeTokenBudget: sourceBudget.remaining.tokens,
          lifetimeTimeBudgetSeconds: sourceBudget.remaining.timeSeconds,
        },
      });
    }
    if (replacement.requestOriginal !== sourceRun.requestOriginal || sha256(replacement.repository) !== sha256(replacementRepository)) {
      throw new Error("existing corrected run does not match its immutable source identity");
    }

    const existingDirective = this.options.supervisor.listArtifacts(replacementRunId)
      .find((artifact) => artifact.type === "CORRECTED_RUN_DIRECTIVE");
    if (!existingDirective) {
      const createdAt = new Date().toISOString();
      const directive = createCorrectedRunDirective({
        policyVersion: "engineer-corrected-run-v1",
        sourceRunId: runId,
        replacementRunId,
        sourceManifestHash: sourceManifest.manifestHash,
        requestOriginalHash: sha256(sourceRun.requestOriginal),
        requestNormalized: sourceManifest.request.normalized,
        acceptanceCriteria: sourceManifest.acceptanceCriteria,
        acceptanceCriteriaHash: sha256(sourceManifest.acceptanceCriteria),
        testPlan: sourceManifest.testPlan,
        allowedPaths: sourceManifest.allowedPaths,
        deniedPaths: sourceManifest.deniedPaths,
        allowedCommands: sourceManifest.allowedCommands,
        actions,
        createdAt,
      });
      this.options.supervisor.recordArtifact(this.options.artifactStore.put({
        runId: replacementRunId,
        type: "CORRECTED_RUN_DIRECTIVE",
        bytes: JSON.stringify(directive),
        producerType: "SYSTEM",
        producerId: "engineer-correction-policy",
        trusted: true,
      }));
    }

    if (replacement.state === "REQUEST_RECEIVED") await this.options.context.build(replacementRunId);
    let plan = this.options.supervisor.latestPlanProposal(replacementRunId);
    if (["REQUEST_RECEIVED", "PLANNING", "REPLANNING"].includes(replacement.state)) {
      plan = await this.options.planning.plan(replacementRunId);
    }
    if (!plan) throw new Error(`corrected run ${replacement.state} has no durable plan proposal`);
    replacement = this.options.supervisor.getRun(replacementRunId);
    return { sourceRun, replacementRun: replacement, plan };
  }

  private deriveSafeCorrections(runId: string, allowedPaths: string[]): Array<{
    code: SafeCorrectionCode;
    sourceRecordIds: string[];
    file: string | null;
    lineStart: number | null;
    lineEnd: number | null;
  }> {
    const actions: Array<{
      code: SafeCorrectionCode;
      sourceRecordIds: string[];
      file: string | null;
      lineStart: number | null;
      lineEnd: number | null;
    }> = [];
    for (const finding of this.options.supervisor.listSecurityFindings(runId).filter((item) => item.status === "OPEN")) {
      const signal = `${finding.category} ${finding.description}`.toLowerCase();
      const boundedFile = finding.file && !finding.file.startsWith("/") && !finding.file.includes("\\") &&
          !finding.file.split("/").some((segment) => !segment || segment === "." || segment === "..") &&
          allowedPaths.some((pattern) => manifestPatternMatchesPath(pattern, finding.file!))
        ? finding.file
        : null;
      const code: SafeCorrectionCode = /possible.secret|credential.like|hard.?coded (?:secret|credential)|test secret/.test(signal)
        ? "GENERATE_NON_SECRET_TEST_FIXTURES"
        : /unauthori[sz]ed|outside (?:the )?(?:allowlist|allowed paths)|scope violation/.test(signal)
          ? "REMOVE_UNAUTHORIZED_PATH_CHANGES"
          : /test (?:integrity|baseline)|baseline test/.test(signal)
            ? "RESTORE_TEST_BASELINE_INTEGRITY"
            : "ADDRESS_RECORDED_SECURITY_FINDING";
      actions.push({
        code,
        sourceRecordIds: [finding.securityFindingId],
        file: boundedFile,
        lineStart: boundedFile ? finding.lineStart : null,
        lineEnd: boundedFile ? finding.lineEnd : null,
      });
    }
    for (const failure of this.options.supervisor.listFailures(runId)) {
      if (failure.failureClass !== "TEST_FAILURE" && !/TEST|VERIFICATION/.test(failure.reasonCode)) continue;
      actions.push({
        code: "REPAIR_FAILED_VERIFICATION",
        sourceRecordIds: [failure.failureId],
        file: null,
        lineStart: null,
        lineEnd: null,
      });
    }
    const unique = new Map(actions.map((action) => [sha256(action), action]));
    return [...unique.values()];
  }

  /** Prevents new detached work, aborts execution, and waits for verification/publication cleanup. */
  async drain(): Promise<void> {
    this.draining = true;
    await this.options.execution?.drain(false);
    await Promise.allSettled([...this.background]);
    for (const run of this.options.supervisor.listRuns(["QUEUED"])) {
      this.options.supervisor.transition({
        runId: run.runId,
        expectedStateVersion: run.stateVersion,
        nextState: "TIMED_OUT",
        reasonCode: "GATEWAY_DRAINED_BEFORE_EXECUTION",
        manifestHash: run.manifestHash,
        idempotencyKey: `gateway-drain:${run.stateVersion}`,
      });
    }
    this.options.execution?.destroyAll({ preserveResumable: true });
  }

  events(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.listEvents(runId);
  }

  artifacts(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.listArtifacts(runId).map(({ storageReference: _privateStorageReference, ...artifact }) => artifact);
  }

  artifactPreview(principal: EngineerPrincipal, runId: string, artifactId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if (!this.options.artifactStore) throw new Error("Engineer artifact store is not configured");
    const artifact = this.options.supervisor.listArtifacts(runId).find((item) => item.artifactId === artifactId);
    if (!artifact) throw new Error("Engineer artifact not found");
    return previewEngineerArtifact(this.options.artifactStore,artifact,undefined,
      Boolean(this.options.supervisor.isOptionalHardeningChild?.(runId)));
  }

  claims(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.listClaimEvidence(runId);
  }

  evidenceBundles(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.listEvidenceBundles(runId);
  }

  evidenceExport(principal: EngineerPrincipal, runId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if (!this.options.artifactStore) throw new Error("Engineer artifact store is required for a complete evidence export");
    const snapshot = this.options.supervisor.evidenceExportSnapshot(runId);
    const strict=Boolean(this.options.supervisor.isOptionalHardeningChild?.(runId));
    const artifactPayloads = snapshot.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      encoding: "base64" as const,
      content:(strict?this.options.artifactStore!.readVerifiedExact(artifact):
        this.options.artifactStore!.read(artifact)).toString("base64"),
    }));
    const content = {
      exportVersion: 2,
      run: snapshot.run,
      manifest: snapshot.manifest,
      riskAssessment: snapshot.riskAssessment,
      events: snapshot.events,
      completeness: { eventsComplete: snapshot.events.length === snapshot.latestEventSequence, eventCount: snapshot.events.length },
      artifacts: snapshot.artifacts,
      artifactPayloads,
      durableRecords: snapshot.durableRecords,
      claims: snapshot.claims,
      evidenceBundles: snapshot.evidenceBundles,
      tests: snapshot.tests,
      securityFindings: snapshot.securityFindings,
      failures: snapshot.failures,
      decisions: snapshot.decisions,
    };
    const sanitized=withoutArtifactStorageReferences(content);
    return { ...sanitized, exportHash: sha256(sanitized) };
  }

  evidenceExportStream(principal: EngineerPrincipal, runId: string): ReadableStream<Uint8Array> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if (!this.options.artifactStore) throw new Error("Engineer artifact store is required for a complete evidence export");
    const snapshot = this.options.supervisor.evidenceExportSummary(runId);
    const supervisor = this.options.supervisor;
    const artifactStore = this.options.artifactStore;
    const strict=Boolean(supervisor.isOptionalHardeningChild?.(runId));
    const hash = createHash("sha256");
    const encoder = new TextEncoder();
    const encoded = (value: string, checksum = true): Uint8Array => {
      if (checksum) hash.update(value, "utf8");
      return encoder.encode(value);
    };
    const record = (value: Record<string, unknown>): Uint8Array => encoded(
      `${JSON.stringify(withoutArtifactStorageReferences(value))}\n`);
    const stripStorageReferences = (value: unknown): string => JSON.stringify(
      withoutArtifactStorageReferences(value));

    async function* chunks(): AsyncGenerator<Uint8Array> {
      const artifacts = snapshot.artifacts.map(({ storageReference: _privateStorageReference, ...artifact }) => artifact);
      yield record({ type: "header", exportVersion: 3, runId, generatedAt: new Date().toISOString(), format: "application/x-ndjson" });
      yield record({ type: "run", value: snapshot.run });
      yield record({ type: "manifest", value: snapshot.manifest });
      yield record({ type: "riskAssessment", value: snapshot.riskAssessment });

      yield encoded('{"type":"events","value":[');
      let eventCursor = 0;
      let eventCount = 0;
      let firstEvent = true;
      while (eventCursor < snapshot.latestEventSequence) {
        const page = supervisor.listEvents(runId, eventCursor, 1_000)
          .filter((event) => event.sequence <= snapshot.latestEventSequence);
        if (page.length === 0) break;
        for (const event of page) {
          yield encoded(`${firstEvent ? "" : ","}${JSON.stringify(event)}`);
          firstEvent = false;
          eventCount += 1;
        }
        const nextCursor = page.at(-1)!.sequence;
        if (nextCursor <= eventCursor) throw new Error("Engineer event export cursor did not advance");
        eventCursor = nextCursor;
      }
      yield encoded(`],"complete":${eventCount === snapshot.latestEventSequence}}\n`);
      yield record({ type: "artifacts", value: artifacts });

      yield encoded('{"type":"durableRecords","value":{');
      let firstTable = true;
      for (const table of supervisor.exportRunRecordTables(runId)) {
        yield encoded(`${firstTable ? "" : ","}${JSON.stringify(table)}:[`);
        firstTable = false;
        let firstRow = true;
        for (let offset = 0; ; offset += 500) {
          const page = supervisor.exportRunRecordPage(runId, table, offset, 500);
          for (const row of page) {
            yield encoded(`${firstRow ? "" : ","}${stripStorageReferences(row)}`);
            firstRow = false;
          }
          if (page.length < 500) break;
        }
        yield encoded("]");
      }
      yield encoded("}}\n");

      yield record({ type: "claims", value: snapshot.claims });
      yield record({ type: "evidenceBundles", value: snapshot.evidenceBundles });
      yield record({ type: "tests", value: snapshot.tests });
      yield record({ type: "securityFindings", value: snapshot.securityFindings });
      yield record({ type: "failures", value: snapshot.failures });
      yield record({ type: "decisions", value: snapshot.decisions });

      for (const artifact of snapshot.artifacts) {
        const prefix = JSON.stringify({
          type: "artifactPayload",
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          encoding: "base64",
        });
        yield encoded(`${prefix.slice(0, -1)},"content":"`);
        let carry = Buffer.alloc(0);
        const source=strict?(async function*(){const exact=artifactStore.readVerifiedExact(artifact);
          for(let offset=0;offset<exact.byteLength;offset+=48*1024)yield exact.subarray(offset,offset+48*1024);})():
          artifactStore.verifiedChunks(artifact);
        for await (const bytes of source) {
          const combined = carry.byteLength === 0 ? bytes : Buffer.concat([carry, bytes]);
          const completeBytes = combined.byteLength - (combined.byteLength % 3);
          if (completeBytes > 0) yield encoded(combined.subarray(0, completeBytes).toString("base64"));
          carry = completeBytes === combined.byteLength ? Buffer.alloc(0) : Buffer.from(combined.subarray(completeBytes));
        }
        if (carry.byteLength > 0) yield encoded(carry.toString("base64"));
        yield encoded('"}\n');
      }

      yield encoded(`${JSON.stringify({ type: "checksum", algorithm: "sha256", value: `sha256:${hash.digest("hex")}` })}\n`, false);
    }

    const iterator = chunks();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() { await iterator.return?.(undefined); },
    });
  }

  tests(runId: string) { this.assertOwner(runId, this.options.principal); return this.options.supervisor.listTestExecutions(runId); }

  security(runId: string) { this.assertOwner(runId, this.options.principal); return this.options.supervisor.listSecurityFindings(runId); }

  failures(runId: string) { this.assertOwner(runId, this.options.principal); return this.options.supervisor.listFailures(runId); }

  gitOperations(runId: string) { this.assertOwner(runId, this.options.principal); return this.options.supervisor.listGitOperations(runId); }

  /**
   * Owner-scoped org audit export (R5D item 1). Returns the run's DETERMINISTIC,
   * REDACTED, org-scoped event/evidence/attestation chain in the frozen
   * AuditExport shape, sourced from the REAL `TenantScopedLedgerDal`
   * `exportRunAuditChain` (the R4 B1 org fence: every read carries `AND org_id=?`,
   * secrets/tokens/paths/storage-references are scrubbed). A single install is
   * fixed to `ENGINEER_DEFAULT_ORG_ID`, so the org fence and the owner fence
   * coincide here: an UNKNOWN run (getRun throws) AND a run owned by a DIFFERENT
   * principal both collapse to the SAME `EngineerNotFoundError` (no ownership
   * oracle), which the handler maps to 404. A run with NO v35 attestation still
   * returns its event/evidence chain (the ATTESTATION entries are simply absent).
   */
  auditExport(principal: EngineerPrincipal, runId: string): AuditExport {
    this.assertPrincipal(principal);
    // Unknown run → EngineerNotFoundError (getRun, org-scoped). A cross-owner run
    // exists in the single-tenant store, so fence it to the byte-identical
    // not-found shape rather than leaking an ownership oracle.
    const run = this.options.supervisor.getRun(runId);
    if (run.userId !== principal.ownerId) throw new EngineerNotFoundError("run", runId);
    const dal = new TenantScopedLedgerDal(this.options.supervisor.resolutionDeskConnection(), {
      orgId: ENGINEER_DEFAULT_ORG_ID,
      actor: defineHumanActor(principal.ownerId),
    });
    return dal.exportRunAuditChain(runId);
  }

  decisions(principal: EngineerPrincipal, runId: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    return this.options.supervisor.listDecisions(runId).map((decision) => {
      const resolution = this.options.supervisor.getDecisionResolution(runId, decision.decisionId);
      return {
        decisionId: decision.decisionId,
        question: decision.question,
        classification: decision.classification,
        reasonCodes: decision.reasonCodes,
        options: decision.options.map(({ sourceEvidenceIds: _sourceEvidenceIds, ...option }) => option),
        recommendedOptionId: decision.recommendedOptionId,
        status: resolution ? "RESOLVED" as const : "OPEN" as const,
        selectedOptionId: resolution?.selectedOptionId ?? null,
        createdAt: decision.createdAt,
        selectionMode: "EXCLUSIVE" as const,
        provenance: { origin: "AI_GENERATED" as const, trust: "UNTRUSTED_MODEL_OUTPUT" as const },
      };
    });
  }

  async resolveDecision(principal: EngineerPrincipal, runId: string, decisionId: string, input: {
    expectedStateVersion: number;
    selectedOptionId: string;
    rationale: string;
    idempotencyKey: string;
  }) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    const resolution = this.options.supervisor.resolveDecision({
      runId,
      decisionId,
      expectedStateVersion: input.expectedStateVersion,
      selectedOptionId: input.selectedOptionId,
      actorId: principal.reviewerId,
      rationale: input.rationale,
      sourceEvidence: [{
        evidenceId: `human-response:${input.expectedStateVersion}`,
        runId,
        sourceType: "HUMAN_RESPONSE",
        trust: "TRUSTED_HUMAN",
        summary: "Authenticated local Engineer principal selected this option.",
      }],
      idempotencyKey: input.idempotencyKey,
    });
    let plan = null;
    let planningError: string | null = null;
    if (this.options.supervisor.getRun(runId).state === "PLANNING") {
      if (!this.options.planning) {
        planningError = "Engineer planning is not configured on this gateway";
      } else {
        try {
          plan = await this.options.planning.plan(runId);
          this.clearError(runId);
        } catch (error) {
          if (error instanceof BudgetPausedError) {
            this.clearError(runId);
          } else {
            planningError = redactSecrets(error instanceof Error ? error.message : String(error));
            this.options.supervisor.setLastError(runId, planningError);
          }
        }
      }
    }
    let publication: Awaited<ReturnType<EngineerPublicationManager["start"]>> | null = null;
    const afterDecision = this.options.supervisor.getRun(runId);
    const deferredRemaining = this.options.supervisor.listOpenDecisions(runId)
      .some((decision) => decision.classification === "DEFER");
    if (this.options.publication && !deferredRemaining && !this.options.supervisor.isOptionalHardeningChild?.(runId)) {
      if (afterDecision.state === "REVIEW_APPROVED") {
        publication = await this.options.publication.start(runId, principal.reviewerId);
      } else if (afterDecision.state === "HUMAN_APPROVED") {
        publication = await this.options.publication.resume(runId);
      }
    }
    return { resolution, plan, planningError, publication };
  }

  private beginPlanning(runId: string): void {
    let run = this.options.supervisor.getRun(runId);
    if (run.state !== "REQUEST_RECEIVED") return;
    run = this.options.supervisor.normalizeRequest({
      runId,
      expectedStateVersion: run.stateVersion,
      normalizedRequest: run.requestOriginal,
      idempotencyKey: `gateway:planning-normalize:${sha256(run.requestOriginal)}`,
    }).run;
    this.options.supervisor.transition({
      runId,
      expectedStateVersion: run.stateVersion,
      nextState: "PLANNING",
      reasonCode: "EVIDENCE_PLANNING_STARTED",
      idempotencyKey: `gateway:planning-start:${run.stateVersion}`,
    });
  }

  private persistError(runId: string, error: unknown): string {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    this.options.supervisor.setLastError(runId, message);
    return message;
  }

  private clearError(runId: string): void {
    this.options.supervisor.setLastError(runId, null);
  }

  diff(runId: string) {
    this.assertOwner(runId, this.options.principal);
    if (!this.options.diffForRun) throw new Error("Engineer diff is not available on this gateway");
    return this.options.diffForRun(runId);
  }

  approval(runId: string) {
    this.assertOwner(runId, this.options.principal);
    return this.options.supervisor.latestApprovalRequest(runId);
  }

  async approve(principal: EngineerPrincipal, runId: string, reason: string, expected: ApprovalAuthorityExpectation) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    this.options.publication.assertApprovalAuthority(runId, expected);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    return this.options.publication.approve(runId, principal.reviewerId, reason, expected);
  }

  async requestChanges(principal: EngineerPrincipal, runId: string, reason: string, expected: ApprovalAuthorityExpectation): Promise<void> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    this.options.publication.assertApprovalAuthority(runId, expected);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    await this.options.publication.requestChanges(runId, principal.reviewerId, reason, expected);
  }

  async reject(principal: EngineerPrincipal, runId: string, reason: string, expected: ApprovalAuthorityExpectation): Promise<void> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    this.options.publication.assertApprovalAuthority(runId, expected);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    await this.options.publication.reject(runId, principal.reviewerId, reason, expected);
  }

  async resolveHumanReview(principal: EngineerPrincipal, runId: string, decision: "reject" | "retry", reason: string) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if ((decision as string) === "approve") throw new VerifiedCandidateRequiredError();
    // This is a control-plane decision over the immutable, hash-bound review
    // evidence already produced for the run. It must remain available when the
    // canonical branch advances after verification. Any configured publication
    // path performs its own current-base checks before a remote mutation.
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "HUMAN_REVIEW_REQUIRED") throw new Error(`human review requires HUMAN_REVIEW_REQUIRED, not ${run.state}`);
    if(decision==="retry")this.assertRequiredLaneAction(runId);
    const flakeFailure = (this.options.supervisor.listFailures?.(runId) ?? [])
      .find((failure) => failure.reasonCode === "FLAKY_TEST_QUARANTINED");
    if (flakeFailure) {
      if (decision === "reject") {
        return { run: this.options.supervisor.transition({
          runId, expectedStateVersion: run.stateVersion, nextState: "REJECTED",
          reasonCode: "HUMAN_REJECTED_FLAKY_CANDIDATE", actorType: "HUMAN", actorId: principal.reviewerId,
          evidenceIds: flakeFailure.evidenceIds, manifestHash: run.manifestHash,
          idempotencyKey: `human-flake:reject:${run.stateVersion}:${sha256(reason)}`,
        }).run };
      }
      if (!this.options.verification) throw new Error("Engineer verification is not configured for a quarantined-test retry");
      const recovery = this.options.supervisor.transition({
        runId, expectedStateVersion: run.stateVersion, nextState: "VERIFICATION_RECOVERY",
        reasonCode: "HUMAN_RETRY_FLAKY_TEST", actorType: "HUMAN", actorId: principal.reviewerId,
        evidenceIds: flakeFailure.evidenceIds.length ? flakeFailure.evidenceIds : [flakeFailure.failureId], manifestHash: run.manifestHash,
        idempotencyKey: `human-flake:retry:${run.stateVersion}:${sha256(reason)}`,
        facts: { reviewerRetryAuthorized: true },
      }).run;
      this.options.verification.resumeRecovered(runId);
      return { run: recovery, publication: null };
    }
    const bundle = this.options.supervisor.listEvidenceBundles(runId).at(-1);
    if (decision === "reject") {
      const evidenceIds = bundle ? [bundle.evidenceBundleId] : [];
      return { run: this.options.supervisor.transition({
        runId, expectedStateVersion: run.stateVersion, nextState: "REJECTED",
        reasonCode: "HUMAN_REVIEW_REJECTED", actorType: "HUMAN", actorId: principal.reviewerId,
        evidenceIds, manifestHash: run.manifestHash, idempotencyKey: `human-review:reject:${run.stateVersion}:${sha256(reason)}`,
      }).run };
    }
    if (decision === "retry") {
      if (!this.options.verification) throw new Error("Engineer verification is not configured for Reviewer recovery");
      const sequence = this.options.supervisor.latestEventSequence(runId);
      const latestEvent = sequence > 0 ? this.options.supervisor.listEvents(runId, sequence - 1, 1)[0] : undefined;
      const reviewerFailure = [...(this.options.supervisor.listFailures(runId) ?? [])].reverse().find((failure) =>
        failure.reasonCode === "PHASE3_UNEXPECTED_FAILURE" && failure.failureClass === "WORKFLOW_FAILURE");
      if (!reviewerFailure || latestEvent?.reasonCode !== "PHASE3_UNEXPECTED_FAILURE" || latestEvent.previousState !== "REVIEWING") {
        throw new Error("Reviewer retry requires a recorded failed Reviewer attempt");
      }
      const recovery = this.options.supervisor.transition({
        runId, expectedStateVersion: run.stateVersion, nextState: "VERIFICATION_RECOVERY",
        reasonCode: "HUMAN_RETRY_FAILED_REVIEWER", actorType: "HUMAN", actorId: principal.reviewerId,
        evidenceIds: [reviewerFailure.failureId], manifestHash: run.manifestHash,
        idempotencyKey: `human-review:retry:${run.stateVersion}:${sha256(reason)}`,
        facts: { reviewerRetryAuthorized: true },
      }).run;
      this.options.supervisor.setLastError(runId, null);
      this.options.verification.resumeRecovered(runId);
      return { run: recovery, publication: null };
    }
    throw new Error("Reviewer retry requires a recorded failed Reviewer attempt");
  }

  async extendApproval(principal: EngineerPrincipal, runId: string, reason: string, extensionSeconds: number, expected: ApprovalAuthorityExpectation) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    this.options.publication.assertApprovalAuthority(runId, expected);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    return this.options.publication.extend(runId, principal.reviewerId, reason, extensionSeconds, expected);
  }

  async expireApproval(principal: EngineerPrincipal, runId: string, expected: ApprovalAuthorityExpectation): Promise<void> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    this.options.publication.assertApprovalAuthority(runId, expected);
    await this.options.publication.expire(runId, expected);
  }

  async cancel(principal: EngineerPrincipal, runId: string, reason: string): Promise<void> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    // Persist the user's stop authority before signalling any in-memory work.
    // A process crash or an abort-ignoring transport therefore leaves an
    // actionable CANCELLATION_PENDING record, never a misleading active run.
    this.requestCancellationWithoutPublication(runId,principal.ownerId,reason);
    if(this.options.supervisor.getRun(runId).state==="CANCELLED")return;
    // All callers converge on the same cleanup/reconciliation operation after
    // the durable stop intent exists. This includes a user double-click racing
    // the boot/watchdog recovery path; neither may perform cleanup twice.
    const existing=this.cancellationRecovery.get(runId);
    if(existing){await existing;return;}
    let operation!:Promise<void>;
    operation=this.performCancellation(runId).finally(()=>{
      if(this.cancellationRecovery.get(runId)===operation)this.cancellationRecovery.delete(runId);
    });
    this.cancellationRecovery.set(runId,operation);
    await operation;
  }

  private async performCancellation(runId:string):Promise<void>{
    let handedOff=false;
    try{
      this.activePlanningRevocations.get(runId)?.();
      this.activePlanning.get(runId)?.abort(new EngineerPlanningCancelledError());
      this.options.execution?.cancel?.(runId);
      this.options.verification?.cancel?.(runId);
      const drain=Promise.allSettled([
        this.activePlanningSettled.get(runId)??Promise.resolve(),
        this.options.execution?.waitForIdle?.(runId)??Promise.resolve(),
        this.options.verification?.waitForIdle?.(runId)??Promise.resolve(),
      ]);
      const leaseBound=Math.max(1,this.options.leaseTtlMs??30_000);
      const drainTimeout=Math.max(1,Math.min(this.options.cancellationDrainTimeoutMs??5_000,leaseBound));
      let timer:ReturnType<typeof setTimeout>|null=null;
      const drained=await Promise.race([drain.then(()=>true),new Promise<false>((resolve)=>{
        timer=setTimeout(()=>resolve(false),drainTimeout);timer.unref?.();
      })]);
      if(timer)clearTimeout(timer);
      if(!drained){
        // All renewable authorities were synchronously revoked above. Finish
        // cleanup off the request path so the UI returns promptly even when a
        // provider transport ignores AbortSignal.
        handedOff=true;
        let job!:Promise<void>;
        job=this.completeCancellation(runId)
          .catch((error)=>{this.options.supervisor.setLastError(runId,
            `Cancellation cleanup failed: ${error instanceof Error?error.message:String(error)}`);})
          .finally(()=>{
            this.options.execution?.finishCancellation?.(runId);this.options.verification?.finishCancellation?.(runId);
            if(this.cancellationRecovery.get(runId)===job)this.cancellationRecovery.delete(runId);
          });
        // Replace the request-path promise with the durable convergence job so
        // any later duplicate cancellation or recovery awaits the same owner.
        this.cancellationRecovery.set(runId,job);
        this.background.add(job);void job.finally(()=>this.background.delete(job));
        return;
      }
      await this.completeCancellation(runId);
    }finally{
      if(!handedOff){this.options.execution?.finishCancellation?.(runId);this.options.verification?.finishCancellation?.(runId);}
    }
  }

  private async completeCancellation(runId:string):Promise<void>{
    const leaseManager=this.options.leaseManager;
    if(!leaseManager){
      await this.completeCancellationWithAuthority(runId,null,()=>undefined,(operation)=>operation());
      const supervisor=this.options.supervisor as EngineerSupervisor&DurableCancellationSupervisor;
      const expectedLastError=supervisor.getLastError(runId);
      supervisor.finalizeRunCancellation({runId,outcome:"CANCELLED",expectedLastError,
        lastError:this.cancellationCompletionLastError(expectedLastError)});
      return;
    }
    const leaseTtlMs=Math.max(1,this.options.leaseTtlMs??30_000);
    const ownerId=`gateway-cancel-${sha256({workerOwnerId:this.options.workerOwnerId??"gateway",instance:this.managerInstanceId})
      .slice("sha256:".length)}`;
    let lease:WorkerLeaseGrant;
    try{
      lease=leaseManager.acquire({resourceKey:`run:${runId}`,ownerId,ttlMs:leaseTtlMs,
        idempotencyKey:`cancel-owner:${this.managerInstanceId}:${randomUUID()}`});
    }catch(error){
      if(error instanceof WorkerLeaseConflictError||error instanceof WorkerLeaseCapacityError){
        // Another fenced gateway owns cleanup. The durable pending intent and
        // periodic sweep are sufficient; a losing worker must not race the
        // owner's final cancellation CAS with an unfenced diagnostic write.
        return;
      }
      throw error;
    }
    let heartbeatFailure:unknown=null,heartbeatSequence=0;
    const heartbeatEvery=Math.max(1,Math.min(this.options.heartbeatIntervalMs??10_000,Math.floor(leaseTtlMs/3)||1));
    let heartbeat:ReturnType<typeof setInterval>|null=setInterval(()=>{
      try{
        heartbeatSequence+=1;
        const renewed=leaseManager.heartbeat({leaseId:lease.lease.leaseId,ownerId,
          fencingToken:lease.lease.fencingToken,leaseToken:lease.leaseToken,
          idempotencyKey:`cancel-heartbeat:${this.managerInstanceId}:${heartbeatSequence}`});
        lease={...lease,lease:renewed};
      }catch(error){heartbeatFailure=error;if(heartbeat){clearInterval(heartbeat);heartbeat=null;}}
    },heartbeatEvery);
    heartbeat.unref?.();
    const assertAuthority=()=>{
      if(heartbeatFailure)throw heartbeatFailure;
      const active=leaseManager.assertActive({leaseId:lease.lease.leaseId,ownerId,
        fencingToken:lease.lease.fencingToken,leaseToken:lease.leaseToken});
      lease={...lease,lease:active};
    };
    const proof=()=>({leaseId:lease.lease.leaseId,ownerId,fencingToken:lease.lease.fencingToken,
      leaseToken:lease.leaseToken});
    const guarded=<T>(operation:()=>T):T=>leaseManager.withActiveLease(proof(),()=>operation());
    try{
      await this.completeCancellationWithAuthority(runId,()=>({lease,ownerId}),assertAuthority,guarded);
      if(heartbeat){clearInterval(heartbeat);heartbeat=null;}
      if(heartbeatFailure)throw heartbeatFailure;
      guarded(()=>{
        const supervisor=this.options.supervisor as EngineerSupervisor&DurableCancellationSupervisor;
        const expectedLastError=supervisor.getLastError(runId);
        return supervisor.finalizeRunCancellation({runId,outcome:"CANCELLED",expectedLastError,
          lastError:this.cancellationCompletionLastError(expectedLastError)});
      });
    }catch(error){
      if(heartbeat){clearInterval(heartbeat);heartbeat=null;}
      try{guarded(()=>this.options.supervisor.setLastError(runId,
        `Cancellation cleanup failed: ${error instanceof Error?error.message:String(error)}`));}
      catch{/* Stale authority leaves the durable pending intent for watchdog recovery. */}
      throw error;
    }finally{
      if(heartbeat)clearInterval(heartbeat);
      try{leaseManager.release({leaseId:lease.lease.leaseId,ownerId,fencingToken:lease.lease.fencingToken,
        leaseToken:lease.leaseToken,idempotencyKey:`cancel-release:${this.managerInstanceId}`});}
      catch{/* Expiry/watchdog recovery already revoked this generation. */}
    }
  }

  private async completeCancellationWithAuthority(runId:string,
    leaseAuthority:(()=>{lease:WorkerLeaseGrant;ownerId:string})|null,assertAuthority:()=>void,
    guarded:<T>(operation:()=>T)=>T):Promise<void>{
    // Reconcile paid-call uncertainty while the durable run still carries the
    // CANCELLATION_PENDING intent. Only after accounting and outbox effects
    // converge may the workflow become terminal CANCELLED.
    if(this.options.supervisor.isOptionalHardeningChild(runId)){
      const leaseManager=this.options.leaseManager;
      const authority=leaseAuthority?.();
      if(!leaseManager||!authority)throw new Error("hardening cancellation requires the fenced worker-lease authority");
      assertAuthority();
      const nowMs=(this.options.now??(()=>new Date()))().getTime();
      this.options.supervisor.recoverHardeningPaidCallLifecycle({childRunId:runId,ownerId:authority.ownerId,
        rawToken:sha256({namespace:"hardening-cancel-recovery-v1",runId,workerLeaseId:authority.lease.lease.leaseId}),nowMs,
        recoveryWorkerLease:{leaseId:authority.lease.lease.leaseId,ownerId:authority.ownerId,
          fencingToken:authority.lease.lease.fencingToken,leaseToken:authority.lease.leaseToken}});
      assertAuthority();
      if(this.options.supervisor.listOpenHardeningPaidCallReservations(runId).length>0||
          this.options.supervisor.listPendingHardeningPaidCallFinalizations(runId).length>0){
        throw new CancellationStillPendingError("Cancellation is waiting for the bounded paid-call fence to expire and reconcile.");
      }
    }
    // Optional-hardening recovery must own orphan finalization first: its
    // exact RECOVERY_TERMINAL proof is the audit successor for any paid call.
    // Generic cancellation draining is safe only after every paid reservation
    // and finalization has converged (and remains the normal-run path).
    guarded(()=>this.options.supervisor.finalizeRunningAgentExecutions(runId,"FAILED","USER_CANCELLATION_DRAINED"));
    // Cancellation is a fail-safe control, not a new execution admission.
    // A run must remain stoppable after its base becomes stale or a connector
    // grant is revoked; ownership and publication cleanup fences still apply.
    assertAuthority();
    await this.options.cleanupRun?.(runId);
    assertAuthority();
  }

  private assertOwner(runId: string, principal: EngineerPrincipal): void {
    if (this.options.supervisor.getRun(runId).userId !== principal.ownerId) {
      throw new Error("authenticated Engineer principal does not own this run");
    }
  }

  private assertPrincipal(principal: EngineerPrincipal): void {
    if (principal.ownerId !== this.options.principal.ownerId ||
        principal.reviewerId !== this.options.principal.reviewerId ||
        principal.sessionId !== this.options.principal.sessionId ||
        principal.safetyIdentifier !== this.options.principal.safetyIdentifier) {
      throw new Error("untrusted Engineer principal");
    }
  }

  private requestCancellationWithoutPublication(runId:string,actorId:string,reason:string):void{
    const artifactStore = this.options.artifactStore;
    if (!artifactStore) throw new Error("Engineer control is not configured on this gateway");
    const run = this.options.supervisor.getRun(runId);
    if (actorId !== run.userId) throw new Error("cancellation actor does not own this run");
    if(run.state==="CANCELLED"||run.state==="CANCELLATION_PENDING")return;
    if (run.terminalAt) throw new Error(`terminal run ${run.state} cannot be cancelled`);
    if (!isCancellationAllowed(run.state)) {
      throw new Error(`cancellation is fenced while publication state is ${run.state}; remote cleanup is not safely available`);
    }
    if (hasUnreconciledRemotePublication(this.options.supervisor.listGitOperations(runId))) {
      throw new Error("cancellation is fenced because remote publication was attempted and no durable remote cleanup is available");
    }
    const artifact=artifactStore.put({runId,type:"CANCELLATION_REQUEST",
      bytes:JSON.stringify({actorId,reason,requestedAt:(this.options.now??(()=>new Date()))().toISOString()}),
      producerType:"SYSTEM",producerId:"engineer-supervisor",trusted:true});
    try{
      const result=(this.options.supervisor as EngineerSupervisor&DurableCancellationSupervisor)
        .requestRunCancellation({runId,actorId,artifact});
      if(!result.applied)this.removeUnreferencedCancellationArtifact(runId,artifact);
    }catch(error){
      this.removeUnreferencedCancellationArtifact(runId,artifact);
      throw error;
    }
  }

  private removeUnreferencedCancellationArtifact(runId:string,artifact:ArtifactRecord):void{
    // LocalArtifactStore is content-addressed. A duplicate request can resolve
    // to the exact same bytes as the elected artifact, so physical deletion is
    // allowed only after the authoritative ledger proves no ArtifactRecord for
    // this run references that storage path.
    if(this.options.supervisor.listArtifacts(runId)
      .some((record)=>record.storageReference===artifact.storageReference))return;
    try{unlinkSync(artifact.storageReference);}catch{/* Missing cleanup candidate is already safe. */}
  }

  private cancellationCompletionLastError(current:string|null):string|null{
    if(current?.startsWith("Cancellation cleanup pending:")||current?.startsWith("Cancellation cleanup failed:"))return null;
    return current;
  }

  subscribe(runId: string, afterSequence = 0): ReadableStream<Uint8Array> {
    this.assertOwner(runId, this.options.principal);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("invalid Engineer event cursor");
    const latestSequence = this.options.supervisor.latestEventSequence(runId);
    if (afterSequence > latestSequence) throw new Error("Engineer event cursor is ahead of the durable ledger");
    const encoder = new TextEncoder();
    let nextSequence = afterSequence + 1;
    let timer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let pendingEvents: ReturnType<EngineerSupervisor["listEvents"]> = [];
    const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try { controller.close(); } catch { /* Client cancellation may close the controller first. */ }
    };
    const pump = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (closed) return;
      if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
      while (controller.desiredSize === null || controller.desiredSize > 0) {
        if (pendingEvents.length === 0) {
          pendingEvents = this.options.supervisor.listEvents(runId, nextSequence - 1, 250);
          if (pendingEvents.length === 0) break;
        }
        const event = pendingEvents.shift()!;
        controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`));
        nextSequence = event.sequence + 1;
      }
      if (pendingEvents.length > 0) return;
      const state = this.options.supervisor.getRun(runId).state;
      const ledgerIsDrained = nextSequence > this.options.supervisor.latestEventSequence(runId);
      if ([
        ...(!this.options.publication ? ["REVIEW_APPROVED"] : []),
        "COMPLETED", "REJECTED", "CANCELLED", "TIMED_OUT", "RETRY_BUDGET_EXHAUSTED",
        "BLOCKED_BY_ENVIRONMENT", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "SECURITY_ESCALATION",
        "VERIFICATION_INCOMPLETE", "ROLLED_BACK", "FAILED",
      ].includes(state) && ledgerIsDrained) {
        close(controller);
      }
    };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        pump(controller);
        if (!closed) {
          // Durable events are low-frequency relative to model/command work;
          // a one-second cadence keeps the UI live without four synchronous
          // SQLite polls per subscriber every second.
          timer = setInterval(() => pump(controller), 1_000);
          timer.unref?.();
          heartbeatTimer = setInterval(() => {
            if (!closed && (controller.desiredSize === null || controller.desiredSize > 0)) {
              controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
            }
          }, 15_000);
          heartbeatTimer.unref?.();
        }
      },
      pull: (controller) => pump(controller),
      cancel: () => {
        closed = true;
        if (timer) clearInterval(timer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      },
    });
  }
}
