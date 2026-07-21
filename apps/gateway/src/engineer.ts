import {
  RepositoryReferenceSchema,
  TaskManifestContentSchema,
  type EngineerExecutionManager,
  type EngineerContextManager,
  type EngineerPublicationManager,
  type PublicationStartResult,
  type EngineerPlanningManager,
  type PlanProposal,
  type EngineerVerificationManager,
  type EngineerRun,
  type EngineerSupervisor,
  type RepositoryReference,
  type TaskManifestContent,
  type LocalArtifactStore,
  type ArtifactRecord,
  type BudgetTopUp,
  type EngineerBudgetSelection,
  EngineerBudgetSelectionSchema,
  type EngineerBudgetSnapshot,
  engineerObservabilitySnapshot,
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
  assertManifestPreservesExplicitApiContract,
  ExplicitContractViolationError,
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

export class EngineerCreateIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  readonly httpStatus = 409;
  constructor() {
    super("run id was already used for a different Engineer request");
    this.name = "EngineerCreateIdempotencyConflictError";
  }
}

/** The planner always reserves this fixed maximum completion before a call. */
export const MINIMUM_ENGINEER_PLANNER_TOKENS = 8_000;

export class EngineerPlanningBudgetTooSmallError extends Error {
  readonly code = "PLANNER_BUDGET_MINIMUM";
  readonly httpStatus = 400;
  constructor() {
    super(`token budget must be at least ${MINIMUM_ENGINEER_PLANNER_TOKENS.toLocaleString()} to fund the first planning reservation`);
    this.name = "EngineerPlanningBudgetTooSmallError";
  }
}

// R8-3 P1 #3: the legacy human-gate approval WRITE lane (approve / request-changes
// / reject / extend-approval / expire-approval) is REMOVED from the run manager.
// R5A had already retired the legacy publication authority from every run path,
// so these methods could only ever fail closed (a dead 410 surface). Recovery for
// a stranded HUMAN_APPROVAL_PENDING / BASE_BRANCH_STALE run now runs EXCLUSIVELY
// through the Resolution Desk (durable case + directive + budget authorization),
// the single correction authority. Historical evidence stays readable through the
// supervisor ledger reads (approvalView / evidenceBundles / gitOperations /
// artifacts), and the run's stop authority (`cancel`) is preserved.

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

/**
 * A read-only projection of what the gateway will admit at this exact durable
 * run/budget revision.  This is deliberately not an authority token: every
 * mutation still performs its ownership, state, budget, and idempotency checks.
 * Its job is to prevent the browser from presenting a button that the ledger
 * already knows it must reject.
 */
export type EngineerRunAction =
  | "PLAN" | "FREEZE_PLAN" | "START_EXECUTION" | "REPLAN_EXPLICIT_CONTRACT"
  | "RETRY_PROVIDER" | "RETRY_REVIEWER" | "RESUME_BUDGET" | "TOP_UP_BUDGET" | "CANCEL_RUN"
  | "OPEN_RESOLUTION_CASE" | "PREPARE_NEW_INTAKE";
export type EngineerActionAvailability = "AVAILABLE" | "UNAVAILABLE" | "NOT_APPLICABLE";
export interface EngineerActionCapability {
  action: EngineerRunAction;
  availability: EngineerActionAvailability;
  reasonCode: string;
  message: string;
  nextSafeAction: EngineerRunAction | null;
  expectedStateVersion: number;
  expectedBudgetRevision?: number;
  costImpact: "NONE" | "MAY_CALL_MODEL" | "NEW_SIGNED_BUDGET_REQUIRED";
}
export interface EngineerRunCapabilities {
  schemaVersion: 1;
  runId: string;
  state: EngineerRun["state"];
  stateVersion: number;
  budget: {
    revision: number;
    canIncreaseWithinLifetime: boolean;
    isResolutionReplacement: boolean;
    isOptionalHardeningChild: boolean;
  };
  actions: EngineerActionCapability[];
}

/** A browser attempted an action against a run revision it no longer owns. */
export class EngineerStaleClientStateError extends Error {
  readonly code = "STALE_CLIENT_STATE" as const;
  readonly httpStatus = 409 as const;
  constructor() {
    super("This run changed in another action. Refresh the run before trying again.");
    this.name = "EngineerStaleClientStateError";
  }
}

export class EngineerControlIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT" as const;
  readonly httpStatus = 409 as const;
  constructor() {
    super("This action key was already used for a different Engineer operation.");
    this.name = "EngineerControlIdempotencyConflictError";
  }
}

/**
 * Raised only after a durable, zero-cost clarification has been recorded. The
 * browser refreshes the run and presents the decision instead of sending a
 * planner or Builder request that cannot satisfy the user's frozen scope.
 */
export class EngineerVerificationScopeDecisionRequiredError extends Error {
  readonly code = "VERIFICATION_SCOPE_DECISION_REQUIRED" as const;
  readonly httpStatus = 409 as const;
  constructor() {
    super("Choose whether to verify the task-specific test or require the existing repository-wide suite.");
    this.name = "EngineerVerificationScopeDecisionRequiredError";
  }
}

const VERIFICATION_SCOPE_DECISION_KEY = "verification-scope-before-planning-v1";
const ROOT_SUITE_REQUEST = /\b(?:run|execute|verify)\b[^.\n]{0,100}\b(?:repository(?:['’]s)?|existing|root|full)\b[^.\n]{0,100}\b(?:test(?:s| suite| command)?|suite)\b/i;
const NEW_FILES_ONLY_REQUEST = /\bdo not modify\b[^.\n]{0,100}\b(?:existing files?|configuration|lockfiles?|dependencies)\b/i;

function hasVerificationScopeConflict(request: string): boolean {
  return ROOT_SUITE_REQUEST.test(request) && NEW_FILES_ONLY_REQUEST.test(request);
}

const unavailableCheckpointAttestor: CheckpointAttestor = {
  algorithm: "unavailable",
  keyId: "unavailable",
  sign: () => { throw new Error("Engineer verified-candidate attestor is not configured"); },
  verify: () => { throw new Error("Engineer verified-candidate attestor is not configured"); },
};

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
  /** In-memory completion promises make an in-flight replan retry await the new proposal, never the prior one. */
  private readonly replanReplay = new Map<string, Promise<PlanProposal>>();
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
    const selectedBudget = EngineerBudgetSelectionSchema.parse(input.budget ?? {});
    const matchesExistingIntake = (existing: EngineerRun): boolean => {
      const existingBudget = this.options.supervisor.reconcileBudget(existing.runId);
      return existing.requestOriginal === input.request.trim() &&
        sha256(existing.repository) === sha256(repository) &&
        existingBudget.limits.costUsd === selectedBudget.costBudgetUsd &&
        existingBudget.limits.tokens === selectedBudget.tokenBudget &&
        existingBudget.limits.timeSeconds === selectedBudget.timeBudgetSeconds &&
        existingBudget.lifetimeLimits.costUsd === selectedBudget.lifetimeCostBudgetUsd &&
        existingBudget.lifetimeLimits.tokens === selectedBudget.lifetimeTokenBudget &&
        existingBudget.lifetimeLimits.timeSeconds === selectedBudget.lifetimeTimeBudgetSeconds;
    };
    // A browser may lose the response after submitting a create request.  The
    // caller-generated run ID is therefore a durable idempotency identity, not
    // a cosmetic field: replaying the same logical create returns its existing
    // owner-scoped run and never begins a second paid planning lane.
    if (input.runId) {
      try {
        const existing = this.options.supervisor.getRun(input.runId);
        this.assertOwner(input.runId, principal);
        if (!matchesExistingIntake(existing)) throw new EngineerCreateIdempotencyConflictError();
        return existing;
      } catch (error) {
        if (!(error instanceof EngineerNotFoundError)) throw error;
      }
    }
    // The planner has a fixed 8k completion ceiling. Reject a run that cannot
    // pay that known minimum before we create a durable record that will pause
    // at zero usage. Context-derived input tokens remain a later hard admission
    // check because they cannot be known safely until the trusted context exists.
    if (this.options.planning && (selectedBudget.tokenBudget < MINIMUM_ENGINEER_PLANNER_TOKENS || selectedBudget.lifetimeTokenBudget < MINIMUM_ENGINEER_PLANNER_TOKENS)) {
      throw new EngineerPlanningBudgetTooSmallError();
    }
    await this.options.preflight.assertRunAdmission(repository);
    try {
      return this.options.supervisor.receiveRequest({
        ...input, budget: selectedBudget,
        userId: principal.ownerId,
        repository,
      });
    } catch (error) {
      // Concurrent identical creates race at the unique run-id constraint.
      // Re-read only our own matching run; a different payload still fails
      // closed rather than becoming an accidental replay.
      if (!input.runId) throw error;
      try {
        const existing = this.options.supervisor.getRun(input.runId);
        this.assertOwner(input.runId, principal);
        if (matchesExistingIntake(existing)) return existing;
        throw new EngineerCreateIdempotencyConflictError();
      } catch (readError) {
        if (!(readError instanceof EngineerNotFoundError)) throw readError;
      }
      throw error;
    }
  }

  get(runId: string): { run: EngineerRun; budget: EngineerBudgetSnapshot; lastError: string | null; activity: { active: boolean; role: "PLANNER" | "BUILDER" | "VERIFIER" | null; detail: string }; capabilities: EngineerRunCapabilities } {
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
    return { run, budget, lastError: legacySafePauseError ? null : durableLastError, activity, capabilities: this.capabilitiesFor(run, budget) };
  }

  /**
   * Keep action admission in one place.  The browser consumes this projection,
   * but the mutation methods below remain the security boundary.
   */
  private capabilitiesFor(run: EngineerRun, budget: EngineerBudgetSnapshot): EngineerRunCapabilities {
    // Status/snapshot callers in older integrations may provide a deliberately
    // partial budget projection. Fail closed in that compatibility seam rather
    // than turning a read-only status request into a 500 or inventing controls.
    if (!budget || !budget.limits || !budget.lifetimeLimits || !budget.remaining) {
      const actions: EngineerRunAction[] = ["PLAN", "FREEZE_PLAN", "START_EXECUTION", "REPLAN_EXPLICIT_CONTRACT", "RETRY_PROVIDER", "RETRY_REVIEWER", "RESUME_BUDGET", "TOP_UP_BUDGET", "CANCEL_RUN", "OPEN_RESOLUTION_CASE", "PREPARE_NEW_INTAKE"];
      return {
        schemaVersion: 1, runId: run.runId, state: run.state, stateVersion: run.stateVersion,
        budget: { revision: 0, canIncreaseWithinLifetime: false, isResolutionReplacement: false, isOptionalHardeningChild: false },
        actions: actions.map((action) => ({ action, availability: "UNAVAILABLE", reasonCode: "READINESS_NOT_MET", message: "The gateway has not produced a complete budget projection for this run.", nextSafeAction: null, expectedStateVersion: run.stateVersion, costImpact: "NONE" })),
      };
    }
    const isResolutionReplacement = Boolean(this.options.supervisor.resolutionCorrectedRunDirective?.(run.runId));
    const isOptionalHardeningChild = Boolean(this.options.supervisor.isOptionalHardeningChild?.(run.runId));
    const canIncreaseWithinLifetime =
      budget.limits.costUsd < budget.lifetimeLimits.costUsd - Number.EPSILON ||
      budget.limits.tokens < budget.lifetimeLimits.tokens ||
      budget.limits.timeSeconds < budget.lifetimeLimits.timeSeconds;
    const hasRemainingBudget = budget.remaining.costUsd > 0 && budget.remaining.tokens > 0 && budget.remaining.timeSeconds > 0;
    const isTerminal = run.terminalAt !== null;
    const action = (input: Omit<EngineerActionCapability, "expectedStateVersion">): EngineerActionCapability => ({
      ...input,
      expectedStateVersion: run.stateVersion,
      ...(input.action === "TOP_UP_BUDGET" || input.action === "RESUME_BUDGET" ? { expectedBudgetRevision: budget.revision } : {}),
    });
    const unavailable = (name: EngineerRunAction, reasonCode: string, message: string, nextSafeAction: EngineerRunAction | null = null): EngineerActionCapability =>
      action({ action: name, availability: "UNAVAILABLE", reasonCode, message, nextSafeAction, costImpact: "NONE" });
    const available = (name: EngineerRunAction, message: string, costImpact: EngineerActionCapability["costImpact"] = "NONE"): EngineerActionCapability =>
      action({ action: name, availability: "AVAILABLE", reasonCode: "READY", message, nextSafeAction: null, costImpact });

    const actions: EngineerActionCapability[] = [];
    const planningActive = this.activePlanning.has(run.runId);
    actions.push(run.state === "REQUEST_RECEIVED" || ((run.state === "PLANNING" || run.state === "REPLANNING") && !planningActive)
      ? available("PLAN", run.state === "REQUEST_RECEIVED" ? "Planning can begin once the gateway worker claims this run." : "Retry the interrupted planning checkpoint.", "MAY_CALL_MODEL")
      : unavailable("PLAN", planningActive ? "PENDING_OPERATION" : (isTerminal ? "RUN_TERMINAL" : "STATE_NOT_ELIGIBLE"), planningActive ? "Planning is already in progress." : "Planning is not the safe next action for this run."));
    actions.push(run.state === "PLAN_READY"
      ? available("FREEZE_PLAN", "Freeze the reviewed contract before execution.")
      : unavailable("FREEZE_PLAN", isTerminal ? "RUN_TERMINAL" : "STATE_NOT_ELIGIBLE", "A ready plan is required before it can be frozen."));
    actions.push(run.state === "PLAN_FROZEN"
      ? available("START_EXECUTION", "Start the already frozen contract.", "MAY_CALL_MODEL")
      : unavailable("START_EXECUTION", isTerminal ? "RUN_TERMINAL" : "STATE_NOT_ELIGIBLE", "Execution can start only from a frozen contract."));
    actions.push(run.state === "PLAN_READY"
      ? available("REPLAN_EXPLICIT_CONTRACT", "Regenerate the plan only when the explicit contract needs correction.", "MAY_CALL_MODEL")
      : unavailable("REPLAN_EXPLICIT_CONTRACT", isTerminal ? "RUN_TERMINAL" : "STATE_NOT_ELIGIBLE", "There is no ready plan to correct."));
    actions.push(run.state === "MODEL_PROVIDER_RETRY_PENDING"
      ? available("RETRY_PROVIDER", "Retry the recorded provider checkpoint only within the gateway retry policy.", "MAY_CALL_MODEL")
      : unavailable("RETRY_PROVIDER", isTerminal ? "RUN_TERMINAL" : "STATE_NOT_ELIGIBLE", "No provider retry is currently authorized."));
    // A Reviewer provider outcome can be ambiguous after deterministic checks
    // have already passed.  That is evidence recovery, not a failed candidate:
    // retain the checkpoint and permit only a reviewer pass from it.  The
    // browser must never infer this from a stale event list.
    const reviewerFailures = this.options.supervisor.listFailures(run.runId) ?? [];
    const reviewerAmbiguousTimeoutCount = reviewerFailures.filter((failure) =>
      failure.reasonCode === "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS" ||
      failure.reasonCode === "VERIFICATION_PROVIDER_TIMEOUT_REQUIRES_HUMAN_REVIEW",
    ).length;
    const reviewerEvidenceRecovery = run.state === "HUMAN_REVIEW_REQUIRED" &&
      reviewerFailures.some((failure) =>
        failure.reasonCode === "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS" ||
        failure.reasonCode === "VERIFICATION_PROVIDER_TIMEOUT_REQUIRES_HUMAN_REVIEW" ||
        (failure.reasonCode === "PHASE3_UNEXPECTED_FAILURE" && failure.failureClass === "WORKFLOW_FAILURE"));
    // Initial review plus one explicit recovery is the entire paid Reviewer
    // allowance. A Human Review button must not bypass this same guard and
    // create an unbounded series of ambiguous provider reservations.
    const reviewerRetryExhausted = reviewerEvidenceRecovery && reviewerAmbiguousTimeoutCount >= 2;
    actions.push(reviewerEvidenceRecovery && !reviewerRetryExhausted
      ? available("RETRY_REVIEWER", "Retry only the recorded Reviewer evidence from the verified checkpoint. This does not rebuild code or re-run tests.", "MAY_CALL_MODEL")
      : unavailable("RETRY_REVIEWER", reviewerRetryExhausted ? "REVIEWER_RETRY_LIMIT_REACHED" : (isTerminal ? "RUN_TERMINAL" : "STATE_NOT_ELIGIBLE"), reviewerRetryExhausted
        ? "Reviewer is unavailable after two attempts. The verified checkpoint is preserved; no further Reviewer charge is authorized."
        : "No Reviewer-only recovery is authorized for this run."));

    if (run.state !== "PAUSED_BUDGET") {
      actions.push(unavailable("RESUME_BUDGET", "STATE_NOT_ELIGIBLE", "This run is not paused for budget review."));
      actions.push(unavailable("TOP_UP_BUDGET", "STATE_NOT_ELIGIBLE", "Budget changes are allowed only while a run is paused."));
    } else {
      actions.push(hasRemainingBudget
        ? available("RESUME_BUDGET", "Resume from the retained checkpoint using the current allowance.", "MAY_CALL_MODEL")
        : unavailable("RESUME_BUDGET", "NO_REMAINING_BUDGET", "No current allowance remains to resume safely.", canIncreaseWithinLifetime ? "TOP_UP_BUDGET" : "PREPARE_NEW_INTAKE"));
      if (isOptionalHardeningChild) {
        actions.push(unavailable("TOP_UP_BUDGET", "NEW_SIGNED_BUDGET_REQUIRED", "Optional hardening runs use a separately approved fixed budget.", "PREPARE_NEW_INTAKE"));
      } else if (isResolutionReplacement) {
        actions.push(unavailable("TOP_UP_BUDGET", "SIGNED_CORRECTION_BUDGET_FIXED", "This corrected run has the fixed budget you approved in the Resolution Desk. It cannot be extended.", "PREPARE_NEW_INTAKE"));
      } else if (!canIncreaseWithinLifetime) {
        actions.push(unavailable("TOP_UP_BUDGET", "LIFETIME_BUDGET_EXHAUSTED", "This run has reached its lifetime budget ceiling. Prepare a new request with a fresh, explicit budget instead.", "PREPARE_NEW_INTAKE"));
      } else {
        actions.push(available("TOP_UP_BUDGET", "Add only allowance within this run's pre-approved lifetime ceiling."));
      }
    }

    actions.push(!isTerminal && isCancellationAllowed(run.state)
      ? available("CANCEL_RUN", "Stop this run and retain its durable audit record.")
      : unavailable("CANCEL_RUN", isTerminal ? "RUN_TERMINAL" : "STATE_NOT_ELIGIBLE", "Cancellation is not safe during this durable operation."));
    const resolutionEligible = ["BASE_BRANCH_STALE", "HUMAN_APPROVAL_PENDING", "HUMAN_REVIEW_REQUIRED", "FAILED", "REJECTED"].includes(run.state) && !reviewerEvidenceRecovery;
    actions.push(resolutionEligible
      ? available("OPEN_RESOLUTION_CASE", "Open the Resolution Desk for a bounded, auditable correction.")
      : unavailable("OPEN_RESOLUTION_CASE", reviewerEvidenceRecovery ? "REVIEWER_EVIDENCE_RECOVERY_REQUIRED" : "STATE_NOT_ELIGIBLE", reviewerEvidenceRecovery ? "This candidate already has a verified checkpoint. Retry the Reviewer only; do not create a replacement run." : "This run has no Resolution Desk recovery path at this state."));
    actions.push(run.state === "PAUSED_BUDGET" && !canIncreaseWithinLifetime
      ? available("PREPARE_NEW_INTAKE", "Prepare a separate fresh request. It does not reuse this unverified checkpoint or budget.")
      : unavailable("PREPARE_NEW_INTAKE", "STATE_NOT_ELIGIBLE", "Continue this run with its current safe action instead."));
    return {
      schemaVersion: 1,
      runId: run.runId,
      state: run.state,
      stateVersion: run.stateVersion,
      budget: { revision: budget.revision, canIncreaseWithinLifetime, isResolutionReplacement, isOptionalHardeningChild },
      actions,
    };
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
      // Publication evidence is created only for a reviewer-approved candidate.
      // A reviewer escalation intentionally has no approved candidate (and therefore
      // no publication binding) to expose. Looking it up for HUMAN_REVIEW_REQUIRED
      // converted an honest escalation into a misleading snapshot read error.
      const reachedPublicationReview = events.some((event) => [
        "REVIEW_APPROVED", "HUMAN_APPROVAL_PENDING", "HUMAN_APPROVED",
        "PR_PREFLIGHT", "PR_CREATING", "PR_CREATED", "COMPLETED",
      ].includes(event.nextState));
      const status = this.get(runId);
      const reviewBinding = reachedPublicationReview ? section<{
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

  capabilities(principal: EngineerPrincipal, runId: string): EngineerRunCapabilities {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    return this.get(runId).capabilities;
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
    // A budget can pause either the initial evidence plan or an explicit
    // contract correction. Both states own the same Planner checkpoint and
    // must restart it after a successful durable budget resume.
    if (["PLANNING", "REPLANNING"].includes(result.run.state) && this.options.planning) {
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
    // This is deliberately before freeze and before enqueue/model admission:
    // planner choices may fill gaps, but cannot replace an explicitly requested
    // public API with a different architecture.
    try {
      assertManifestPreservesExplicitApiContract(TaskManifestContentSchema.parse(input.manifest));
    } catch (error) {
      if (error instanceof ExplicitContractViolationError) this.options.supervisor.setLastError(runId, error.message);
      throw error;
    }
    return this.options.supervisor.freezePlan({
      runId,
      expectedStateVersion: input.expectedStateVersion,
      manifest: TaskManifestContentSchema.parse(input.manifest),
      actorId: principal.reviewerId,
      idempotencyKey: input.idempotencyKey,
    }).run;
  }

  /**
   * A narrow, new-files-only request cannot safely promise a red root suite.
   * Ask before planning so the first model call is made against a contract the
   * Builder can actually satisfy. A resolved decision is carried into the
   * planner's normal human-decision reconciliation payload.
   */
  private requireVerificationScopeChoice(runId: string, expectedStateVersion?: number): void {
    const run = this.options.supervisor.getRun(runId);
    if (!hasVerificationScopeConflict(run.requestOriginal)) return;
    const existing = this.options.supervisor.listDecisions(runId)
      .find((decision) => decision.idempotencyKey === VERIFICATION_SCOPE_DECISION_KEY);
    if (existing && this.options.supervisor.getDecisionResolution(runId, existing.decisionId)) return;
    if (existing) throw new EngineerVerificationScopeDecisionRequiredError();
    if (expectedStateVersion !== undefined && run.stateVersion !== expectedStateVersion) {
      throw new EngineerStaleClientStateError();
    }
    const evidenceId = "verification-scope-user-request";
    this.options.supervisor.createDecision({
      runId,
      expectedStateVersion: run.stateVersion,
      question: "This request forbids editing existing files but also requires the repository-wide existing test suite. Which verification contract should Zintus use?",
      factors: {
        affectsMustCriterion: true,
        changesScope: false,
        affectsAuthentication: false,
        affectsAuthorization: false,
        handlesSecrets: false,
        requiresMigration: false,
        changesPublicApi: false,
        destructiveAction: false,
        externalSideEffect: false,
        changesBudget: false,
        noSafeDefault: true,
        safeDocumentedDefault: false,
        reversible: true,
        withinFrozenScope: false,
        raisesRisk: false,
        riskFloorRequiresHuman: false,
      },
      options: [
        {
          optionId: "scoped-task-test",
          label: "Verify only the generated task test",
          impact: "Keeps the requested file scope and verifies the new test directly. Existing repository failures remain recorded separately.",
          reversibility: "REVERSIBLE",
          riskTier: "MEDIUM",
          sourceEvidenceIds: [evidenceId],
          recommended: true,
        },
        {
          optionId: "preserve-root-suite",
          label: "Require the existing repository-wide suite",
          impact: "Preserves the original full-suite requirement. The run will stop before Builder work if the immutable base suite is already failing.",
          reversibility: "REVERSIBLE",
          riskTier: "MEDIUM",
          sourceEvidenceIds: [evidenceId],
          recommended: false,
        },
      ],
      recommendedOptionId: "scoped-task-test",
      sourceEvidence: [{
        evidenceId,
        runId,
        sourceType: "USER_REQUEST",
        trust: "TRUSTED_SYSTEM",
        summary: "The authenticated gateway normalized a user request that combines a new-files-only scope with an existing repository-wide test requirement.",
      }],
      idempotencyKey: VERIFICATION_SCOPE_DECISION_KEY,
    });
    throw new EngineerVerificationScopeDecisionRequiredError();
  }

  async plan(principal: EngineerPrincipal, runId: string, fence?: { expectedStateVersion: number; idempotencyKey: string }) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertExpectedStateVersion(runId, fence?.expectedStateVersion);
    // Admission is deliberately before normalization: a rejected repository
    // must leave the durable run byte-for-byte unchanged, including request
    // identity state.
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    // Normalize the immutable request identity before asking an early
    // deterministic clarification.  Otherwise an ASK_NOW decision can resume
    // directly into PLANNING with requestNormalized still empty; the Planner
    // then creates a valid proposal that the freeze guard must reject.
    const normalizedRun = this.normalizeRequestForPlanning(runId, fence?.idempotencyKey);
    const planningFence = fence ? { ...fence, expectedStateVersion: normalizedRun.stateVersion } : undefined;
    this.requireVerificationScopeChoice(runId, planningFence?.expectedStateVersion);
    this.assertRequiredLaneAction(runId);
    const operation = this.controlOperation(runId, "PLAN", planningFence, { expectedStateVersion: planningFence?.expectedStateVersion });
    if (operation.replayed) return this.replayedPlan(runId);
    this.assertExpectedStateVersion(runId, planningFence?.expectedStateVersion);
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
    this.beginPlanning(runId, operation.key);
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

  /** Explicit user API drift is corrected through the same durable run, never by silently weakening the contract. */
  async replanExplicitContract(principal: EngineerPrincipal, runId: string, fence?: { expectedStateVersion: number; idempotencyKey: string }): Promise<PlanProposal> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    const run = this.options.supervisor.getRun(runId);
    const operation = this.controlOperation(runId, "REPLAN_EXPLICIT_CONTRACT", fence, { expectedStateVersion: fence?.expectedStateVersion });
    if (operation.replayed) {
      const inFlight = operation.key ? this.replanReplay.get(operation.key) : undefined;
      if (inFlight) return inFlight;
      return this.replayedPlan(runId, { requireReplanCompletion: true });
    }
    this.assertExpectedStateVersion(runId, fence?.expectedStateVersion);
    if (run.state !== "PLAN_READY") throw new Error(`explicit contract replan requires PLAN_READY, not ${run.state}`);
    const message = this.options.supervisor.getLastError(runId) ?? "Frozen plan omitted explicit user API requirements";
    this.options.supervisor.transition({
      runId, expectedStateVersion: run.stateVersion, nextState: "REPLANNING",
      // The browser authorizes this recovery request, but it does not directly
      // promote the state machine.  The gateway records the request above and
      // performs the deterministic transition as the execution authority.
      reasonCode: "EXPLICIT_CONTRACT_REPLAN_REQUESTED", actorType: "SYSTEM", actorId: "engineer-gateway",
      idempotencyKey: operation.key ?? `explicit-contract-replan:${run.stateVersion}`,
    });
    // Persist this correction cause only after the state transition succeeds.
    // It guides the next plan but is not a provider failure and never burns a
    // Planner retry allowance; repeated failed clicks are therefore harmless.
    const fingerprint = sha256({ runId, manifestHash: run.manifestHash, message });
    if (!this.options.supervisor.listFailures(runId).some((failure) =>
      failure.reasonCode === "EXPLICIT_CONTRACT_PLAN_DRIFT" && failure.fingerprint === fingerprint,
    )) {
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: randomUUID(), runId, failureClass: "REQUEST_FAILURE", reasonCode: "EXPLICIT_CONTRACT_PLAN_DRIFT",
        fingerprint, evidenceIds: [], retryable: true, createdAt: new Date().toISOString(),
      }));
    }
    const planning = this.plan(principal, runId);
    if (operation.key) this.replanReplay.set(operation.key, planning);
    try {
      return await planning;
    } finally {
      if (operation.key && this.replanReplay.get(operation.key) === planning) this.replanReplay.delete(operation.key);
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

  async start(principal: EngineerPrincipal, runId: string, fence?: { expectedStateVersion: number; idempotencyKey: string }): Promise<EngineerRun> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    const operation = this.controlOperation(runId, "START_EXECUTION", fence, { expectedStateVersion: fence?.expectedStateVersion });
    if (operation.replayed) return this.options.supervisor.getRun(runId);
    this.assertExpectedStateVersion(runId, fence?.expectedStateVersion);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    if (!this.options.execution) throw new Error("Engineer execution is not configured on this gateway");
    const run = (this.options.execution.enqueue as (id: string, actionIdempotencyKey?: string) => EngineerRun)(runId, operation.key);
    this.clearError(runId);
    this.launchExecution(runId);
    return run;
  }

  /**
   * A Resolution Desk directive is explicit human authorization for a fresh,
   * bounded replacement budget. Its executable run must enter the ordinary
   * planner lane; otherwise it is durable but inert at REQUEST_RECEIVED with no
   * user control that can advance it.
   */
  async launchCorrectedReplacement(principal: EngineerPrincipal, runId: string): Promise<EngineerRun> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    if (!this.options.supervisor.resolutionCorrectedRunDirective(runId)) {
      throw new Error("resolution replacement lineage is required");
    }
    let run = this.options.supervisor.getRun(runId);
    if (run.state === "REQUEST_RECEIVED") {
      try {
        await this.options.preflight.assertRunAdmission(run.repository);
        this.beginPlanning(runId);
        run = this.options.supervisor.getRun(runId);
      } catch (error) {
        this.persistError(runId, error);
        return this.options.supervisor.getRun(runId);
      }
    }
    if (run.state !== "PLANNING" || this.activePlanning.has(runId)) return run;
    const job = this.plan(principal, runId)
      .then(() => undefined)
      .catch((error) => {
        // `plan` persists lifecycle failures itself. This covers a failure before
        // that lifecycle begins, so an auto-launched correction cannot stall
        // silently (for example, when the worker lease is unavailable).
        if (!(error instanceof BudgetPausedError)) this.persistError(runId, error);
      });
    this.background.add(job);
    void job.finally(() => this.background.delete(job));
    return this.options.supervisor.getRun(runId);
  }

  /** Restart-safe recovery for corrected runs committed before a gateway restart. */
  recoverCorrectedReplacements(): Array<{ runId: string; promise: Promise<EngineerRun> }> {
    return this.options.supervisor.listRuns(["REQUEST_RECEIVED"])
      .filter((run) => !this.options.supervisor.isOptionalHardeningChild(run.runId))
      .filter((run) => this.options.supervisor.resolutionCorrectedRunDirective(run.runId) !== null)
      .map((run) => ({ runId: run.runId, promise: this.launchCorrectedReplacement(this.options.principal, run.runId) }));
  }

  async retryProviderTimeout(principal: EngineerPrincipal, runId: string, fence?: { expectedStateVersion: number; idempotencyKey: string }): Promise<EngineerRun> {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    this.assertRequiredLaneAction(runId);
    const operation = this.controlOperation(runId, "RETRY_PROVIDER", fence, { expectedStateVersion: fence?.expectedStateVersion });
    if (operation.replayed) return this.options.supervisor.getRun(runId);
    this.assertExpectedStateVersion(runId, fence?.expectedStateVersion);
    await this.options.preflight.assertRunAdmission(this.options.supervisor.getRun(runId).repository);
    const pending = this.options.supervisor.getRun(runId);
    const reason = this.options.supervisor.listEvents(runId).at(-1)?.reasonCode;
    if (reason === "PLANNING_PROVIDER_OUTCOME_AMBIGUOUS") {
      const run = this.options.supervisor.transition({
        runId, expectedStateVersion: pending.stateVersion, nextState: "PLANNING",
        reasonCode: "HUMAN_RETRY_PLANNING_PROVIDER", idempotencyKey: operation.key ?? `human-retry-planning:${pending.stateVersion}`,
      }).run;
      this.clearError(runId);
      this.resumePlanning(runId);
      return run;
    }
    if (reason === "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS") {
      if (!this.options.verification) throw new Error("Engineer verification is not configured on this gateway");
      const priorAmbiguousOutcomes = this.options.supervisor.listFailures(runId)
        .filter((failure) => failure.reasonCode === "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS").length;
      // The gateway owns this resume route, so it must enforce the same
      // Reviewer-timeout policy as the verification worker. Otherwise a click
      // here could repeatedly redispatch an already-ambiguous paid review.
      if (priorAmbiguousOutcomes >= 2) {
        return this.options.supervisor.transition({
          runId, expectedStateVersion: pending.stateVersion, nextState: "HUMAN_REVIEW_REQUIRED",
          reasonCode: "VERIFICATION_PROVIDER_TIMEOUT_REQUIRES_HUMAN_REVIEW",
          idempotencyKey: operation.key ?? `verification-provider-timeout-human-review:${pending.stateVersion}`,
        }).run;
      }
      const run = this.options.supervisor.transition({
        runId, expectedStateVersion: pending.stateVersion, nextState: "SECURITY_REVIEW",
        reasonCode: "HUMAN_RETRY_VERIFICATION_PROVIDER", idempotencyKey: operation.key ?? `human-retry-verification:${pending.stateVersion}`,
      }).run;
      this.clearError(runId);
      this.options.verification.resumeRecovered(runId);
      return run;
    }
    if (!this.options.execution) throw new Error("Engineer execution is not configured on this gateway");
    const run = await (this.options.execution.retryProviderTimeout as (id: string, actionIdempotencyKey?: string) => Promise<EngineerRun>)(runId, operation.key);
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

  // R8-3 P1 #2: stale-base recovery is REMOVED from the run manager. It used to
  // directly create / plan / freeze / execute a replacement run on the advanced
  // base — a bypass of the Resolution Desk's single correction authority (durable
  // case + directive + budget authorization + compare-and-swap) that could begin
  // model spending WITHOUT an explicit correction decision. A BASE_BRANCH_STALE
  // run is an adoptable legacy state, so recovery now runs EXCLUSIVELY through the
  // Resolution Desk: open a case for the stale run, then authorize a bounded
  // corrected run there. The gateway route returns 410 GONE (successor:
  // resolution-cases); the stale run stays fully readable through its GET reads.
  //
  // R8-3 FINDING 2: the old `createCorrectedRun` bypass (and its
  // `deriveSafeCorrections` helper) is removed too. It minted an executable
  // corrected run + planner directive outside the Resolution Desk — a latent
  // second correction authority. The desk's signed CREATE_CORRECTED_RUN directive
  // (issueDirective -> applyDirective) is the sole path to a corrected run.

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
      if (!this.options.context) {
        planningError = "Engineer context is not configured on this gateway";
      } else if (!this.options.planning) {
        planningError = "Engineer planning is not configured on this gateway";
      } else {
        try {
          // An ASK_NOW resolution resumes directly into PLANNING.  It must take
          // the same durable exact-base context path as a normal plan request;
          // otherwise the Planner correctly refuses an unbound proposal and the
          // browser misleadingly offers a retry for a deterministic omission.
          await this.options.context.build(runId);
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
    // Sol P2-2/#8: name the retired manager's result via the barrel `PublicationStartResult`
    // type rather than `ReturnType<EngineerPublicationManager["start"]>`, which forces
    // declaration emit to reference the retired module's physical path (TS2742) once the
    // `./publication-manager` value subpath is removed. Same runtime type, portable name.
    let publication: PublicationStartResult | null = null;
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

  private beginPlanning(runId: string, actionIdempotencyKey?: string): void {
    let run = this.options.supervisor.getRun(runId);
    if (run.state === "REQUEST_RECEIVED") run = this.normalizeRequestForPlanning(runId, actionIdempotencyKey);
    if (run.state !== "REQUEST_NORMALIZED") return;
    this.options.supervisor.transition({
      runId,
      expectedStateVersion: run.stateVersion,
      nextState: "PLANNING",
      reasonCode: "EVIDENCE_PLANNING_STARTED",
      idempotencyKey: actionIdempotencyKey ?? `gateway:planning-start:${run.stateVersion}`,
    });
  }

  private normalizeRequestForPlanning(runId: string, actionIdempotencyKey?: string): EngineerRun {
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "REQUEST_RECEIVED") return run;
    return this.options.supervisor.normalizeRequest({
      runId,
      expectedStateVersion: run.stateVersion,
      normalizedRequest: run.requestOriginal,
      idempotencyKey: actionIdempotencyKey ? `planning-normalize:${sha256(actionIdempotencyKey)}` : `gateway:planning-normalize:${sha256(run.requestOriginal)}`,
    }).run;
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

  // R8-3 P1 #3: approve / requestChanges / reject were the legacy human-gate
  // approval WRITE lane, retired from every run path by R5A and removed here.
  // Recovery for a stranded run now runs exclusively through the Resolution Desk.

  async resolveHumanReview(principal: EngineerPrincipal, runId: string, decision: "reject" | "retry", reason: string, fence?: { expectedStateVersion: number; idempotencyKey: string }) {
    this.assertPrincipal(principal);
    this.assertOwner(runId, principal);
    if ((decision as string) === "approve") throw new VerifiedCandidateRequiredError();
    // This is a control-plane decision over the immutable, hash-bound review
    // evidence already produced for the run. It must remain available when the
    // canonical branch advances after verification. Any configured publication
    // path performs its own current-base checks before a remote mutation.
    const run = this.options.supervisor.getRun(runId);
    const reviewOperation = this.controlOperation(runId, `HUMAN_REVIEW_${decision.toUpperCase()}`, fence, {
      expectedStateVersion: fence?.expectedStateVersion, decision, reason,
    });
    if (reviewOperation.replayed) return { run: this.options.supervisor.getRun(runId), publication: null };
    this.assertExpectedStateVersion(runId, fence?.expectedStateVersion);
    if (run.state !== "HUMAN_REVIEW_REQUIRED") throw new Error(`human review requires HUMAN_REVIEW_REQUIRED, not ${run.state}`);
    const reviewOperationKey = reviewOperation.key;
    if(decision==="retry")this.assertRequiredLaneAction(runId);
    const flakeFailure = (this.options.supervisor.listFailures?.(runId) ?? [])
      .find((failure) => failure.reasonCode === "FLAKY_TEST_QUARANTINED");
    if (flakeFailure) {
      if (decision === "reject") {
        return { run: this.options.supervisor.transition({
          runId, expectedStateVersion: run.stateVersion, nextState: "REJECTED",
          reasonCode: "HUMAN_REJECTED_FLAKY_CANDIDATE", actorType: "HUMAN", actorId: principal.reviewerId,
          evidenceIds: flakeFailure.evidenceIds, manifestHash: run.manifestHash,
          idempotencyKey: reviewOperationKey ?? `human-flake:reject:${run.stateVersion}:${sha256(reason)}`,
        }).run };
      }
      if (!this.options.verification) throw new Error("Engineer verification is not configured for a quarantined-test retry");
      const recovery = this.options.supervisor.transition({
        runId, expectedStateVersion: run.stateVersion, nextState: "VERIFICATION_RECOVERY",
        reasonCode: "HUMAN_RETRY_FLAKY_TEST", actorType: "HUMAN", actorId: principal.reviewerId,
        evidenceIds: flakeFailure.evidenceIds.length ? flakeFailure.evidenceIds : [flakeFailure.failureId], manifestHash: run.manifestHash,
        idempotencyKey: reviewOperationKey ?? `human-flake:retry:${run.stateVersion}:${sha256(reason)}`,
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
        evidenceIds, manifestHash: run.manifestHash, idempotencyKey: reviewOperationKey ?? `human-review:reject:${run.stateVersion}:${sha256(reason)}`,
      }).run };
    }
    if (decision === "retry") {
      if (!this.options.verification) throw new Error("Engineer verification is not configured for Reviewer recovery");
      const retryableFailure = [...(this.options.supervisor.listFailures(runId) ?? [])].reverse().find((failure) =>
        ["VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS", "VERIFICATION_PROVIDER_TIMEOUT_REQUIRES_HUMAN_REVIEW"].includes(failure.reasonCode) ||
        (failure.reasonCode === "PHASE3_UNEXPECTED_FAILURE" && failure.failureClass === "WORKFLOW_FAILURE"));
      if (!retryableFailure) {
        throw new Error("Reviewer retry requires a recorded failed Reviewer attempt");
      }
      const timeoutRecovery = ["VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS", "VERIFICATION_PROVIDER_TIMEOUT_REQUIRES_HUMAN_REVIEW"].includes(retryableFailure.reasonCode);
      if (timeoutRecovery) {
        const timeoutCount = (this.options.supervisor.listFailures(runId) ?? []).filter((failure) =>
          failure.reasonCode === "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS" ||
          failure.reasonCode === "VERIFICATION_PROVIDER_TIMEOUT_REQUIRES_HUMAN_REVIEW",
        ).length;
        if (timeoutCount >= 2) {
          throw new Error("Reviewer retry limit reached; the verified checkpoint is preserved and no further Reviewer charge is authorized");
        }
      }
      const recovery = this.options.supervisor.transition({
        runId, expectedStateVersion: run.stateVersion, nextState: "VERIFICATION_RECOVERY",
        reasonCode: timeoutRecovery ? "HUMAN_RETRY_VERIFICATION_PROVIDER" : "HUMAN_RETRY_FAILED_REVIEWER", actorType: "HUMAN", actorId: principal.reviewerId,
        evidenceIds: [retryableFailure.failureId], manifestHash: run.manifestHash,
        idempotencyKey: reviewOperationKey ?? `human-review:retry:${run.stateVersion}:${sha256(reason)}`,
        facts: { reviewerRetryAuthorized: true },
      }).run;
      this.options.supervisor.setLastError(runId, null);
      this.options.verification.resumeRecovered(runId);
      return { run: recovery, publication: null };
    }
    throw new Error("Reviewer retry requires a recorded failed Reviewer attempt");
  }

  // R8-3 P1 #3: extendApproval / expireApproval were part of the retired legacy
  // human-gate approval WRITE lane and are removed. Only cancel + the historical
  // GET reads remain; recovery runs exclusively through the Resolution Desk.

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

  private assertExpectedStateVersion(runId: string, expectedStateVersion: number | undefined): void {
    if (expectedStateVersion === undefined) return;
    if (this.options.supervisor.getRun(runId).stateVersion !== expectedStateVersion) {
      throw new EngineerStaleClientStateError();
    }
  }

  /**
   * Bind a caller key to an exact canonical action payload using the existing
   * append-only state-event idempotency record. The raw caller key remains a
   * searchable prefix, so reusing it with changed intent fails before a paid
   * dispatch; the derived key makes exact retries replay the same transition.
   */
  private controlOperation(
    runId: string,
    action: string,
    fence: { expectedStateVersion: number; idempotencyKey: string } | undefined,
    payload: unknown,
  ): { key: string | undefined; replayed: boolean } {
    if (!fence) return { key: undefined, replayed: false };
    if (fence.idempotencyKey.length < 1 || fence.idempotencyKey.length > 200) {
      throw new Error("idempotencyKey must be between 1 and 200 characters");
    }
    const prefix = `control:${fence.idempotencyKey}:`;
    const key = `${prefix}${sha256({ action, payload })}`;
    const previous = this.options.supervisor.listEvents(runId).find((event) => event.idempotencyKey.startsWith(prefix));
    if (previous && previous.idempotencyKey !== key) throw new EngineerControlIdempotencyConflictError();
    return { key, replayed: previous?.idempotencyKey === key };
  }

  /** Return the already-durable planning result after a lost client response; never plan twice. */
  private async replayedPlan(runId: string, options: { requireReplanCompletion?: boolean } = {}): Promise<PlanProposal> {
    const current = this.options.supervisor.latestPlanProposal(runId);
    const run = this.options.supervisor.getRun(runId);
    // A correction replay must never surface the proposal it was specifically
    // asked to replace. Only a fresh PLAN_READY state can certify completion;
    // any failure, timeout, clarification, or retry-pending state is returned
    // to the UI as an explicit refresh-needed outcome instead.
    if (current && (!options.requireReplanCompletion || run.state === "PLAN_READY")) return current;
    const pending = this.activePlanningSettled.get(runId);
    if (pending) await pending;
    const proposal = this.options.supervisor.latestPlanProposal(runId);
    if (proposal && (!options.requireReplanCompletion || this.options.supervisor.getRun(runId).state === "PLAN_READY")) return proposal;
    throw new Error("The previous planning request finished without a durable proposal; refresh the run before choosing a new action.");
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
