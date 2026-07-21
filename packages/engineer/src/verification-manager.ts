import { randomUUID } from "node:crypto";
import {
  EvidenceBundleSchema,
  RepairContextSchema,
  ReviewerInputSchema,
  TrustedEvidenceSchema,
  reviewerEvidenceBundleHash,
  type ModelRole,
  type ReviewerOutput,
  type RunStateEvent,
  type TaskManifest,
  type TrustedEvidence,
} from "./contracts.js";
import { FailureRecordSchema } from "./control-contracts.js";
import { classifyPhase3UnderlyingCause } from "./resolution-case.js";
import type { LocalArtifactStore } from "./artifact-store.js";
import { BuilderContinuationSchema, BuilderNoProgressError, CODEX_BUILDER_PROMPT_VERSION, CodexBuilder, isProviderModelTimeout, type ResponsesTransport } from "./codex-builder.js";
import { ArtifactRecordSchema, BuilderResultSchema, ModelCallRecordSchema, type AgentExecutionRecord, type ArtifactRecord, type ModelCallRecord, type SandboxRecord } from "./execution-contracts.js";
import type { EngineerExecutionManager, OptionalHardeningWorkspaceRecoverySnapshot } from "./execution-manager.js";
import type { ISandbox, ProvisionedSandbox } from "./sandbox-manager.js";
import { canonicalJson, compareCodeUnits, sha256 } from "./hash.js";
import { IndependentVerifier, IndependentVerificationFailure, StableRequiredTestFailure, type IndependentVerificationOutput } from "./independent-verifier.js";
import {
  buildIsolatedReviewerRequestPlan,
  IsolatedReviewer,
  REVIEWER_POLICY_VERSION,
} from "./isolated-reviewer.js";
import { LUNA_FAILURE_ADVISOR_POLICY_VERSION, LunaFailureAdvisor } from "./luna-failure-advisor.js";
import { resolveEngineerModel, type EngineerModelConfiguration } from "./model-routing.js";
import type { EngineerSupervisor, RecoveryWorkerLeaseProof } from "./supervisor.js";
import { TERRA_ADVISOR_POLICY_VERSION, TerraAdvisors } from "./terra-advisors.js";
import { TrustedCommandExecutor } from "./trusted-executor.js";
import { canTransition, isTerminalState } from "./state-machine.js";
import { derivePostVerificationRiskFeatures } from "./post-verification-risk.js";
import { buildFinalChangeScopeAttestation } from "./final-change-scope.js";
import { RuntimeBudgetExhaustedError } from "./runtime-budget.js";
import { BudgetPausedError, BuilderModelCallLimitError, HardeningGenericOperationForbiddenError,
  HardeningPromptCacheAuthorityUnavailableError, HardeningReviewerRecoveryAuthorityInvalidError,
  HardeningWorkspaceRecoveryAuthorityInvalidError } from "./errors.js";
import { isWorkerAuthorityLoss, type EngineerWorkerLeaseManager, type WorkerLeaseGrant } from "./worker-lease.js";
import { TestIntegrityGuard, TestIntegrityViolationError, type TestIntegrityComparison } from "./test-integrity.js";
import { loadTestCommandBaseline } from "./test-command-baseline.js";
import { assertWorkspaceSatisfiesExplicitApiContract, ExplicitContractViolationError } from "./explicit-contract.js";
import {
  buildAdversarialCoverageReport,
  type AdversarialCoverageReport,
} from "./adversarial-coverage.js";

const REPAIR_DIAGNOSTIC_MAX_BYTES = 6_000;

/** Keep repair prompts actionable without forwarding credentials or local paths. */
function boundedRepairDiagnostic(value: string): string {
  const redacted = value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED_SECRET]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth(?:orization)?|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(?:\/Users|\/home|\/var|\/tmp|\/private|\/etc|\/opt|\/root)\/[^\s:'\"`]+/g, "[REDACTED_PATH]");
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= REPAIR_DIAGNOSTIC_MAX_BYTES) return redacted;
  const marker = `\n[diagnostic truncated at ${REPAIR_DIAGNOSTIC_MAX_BYTES} bytes]`;
  return `${bytes.subarray(0, REPAIR_DIAGNOSTIC_MAX_BYTES - Buffer.byteLength(marker, "utf8")).toString("utf8")}${marker}`;
}
import {
  ClaimEvidenceRecordSchema,
  EvidenceBundleRecordSchema,
  SecurityFindingRecordSchema,
  VerificationExecutionRecordSchema,
  trustedEvidenceSupportsCriterion,
  VerificationResultSchema,
  type ClaimEvidenceRecord,
  type EvidenceBundleRecord,
  type ReviewFindingRecord,
  type ReviewerSessionRecord,
  type SecurityFindingRecord,
  type VerificationResult,
} from "./verification-contracts.js";
import { classifyReviewerOutput, type ReviewClassificationBatch } from "./review-classification.js";
import type { CheckpointAttestor } from "./verified-candidate-checkpoint.js";
import { hardeningCheckpointMilestoneKey, OptionalHardeningIndependentCheckpointSchema,
  OptionalHardeningReviewInputAuthoritySchema,validateOptionalHardeningCheckpointChain,
  hardeningFinalScopeArtifactId,hardeningPreReviewArtifactId,hardeningReviewAuthorityArtifactId,
  hardeningReviewerIngressTimes,projectHardeningArtifactAuthority,resolveHardeningArtifactAuthority } from
  "./hardening-verification-recovery.js";
import { buildHardeningPendingSemanticRows,resolveHardeningReviewerEvidenceAuthority,
  resolveHardeningReviewerSemanticAuthority,type HardeningPendingSemanticRow } from "./hardening-review-input-authority.js";

export function reviewerClaimEvidenceId(input: {
  runId: string;
  attempt: number;
  kind: "CRITERION" | "UNSUPPORTED";
  key: string;
}): string {
  return sha256({ namespace: "reviewer-claim-evidence-v1", ...input });
}

export interface EngineerVerificationManagerOptions {
  supervisor: EngineerSupervisor;
  executionManager: EngineerExecutionManager;
  sandboxManager: ISandbox;
  artifactStore: LocalArtifactStore;
  transportForRole: (runId: string, role: "BUILDER" | "TESTER" | "SECURITY" | "REVIEWER") =>
    ResponsesTransport | Promise<ResponsesTransport>;
  transportForFailureClassifier?: (runId: string) => ResponsesTransport | Promise<ResponsesTransport>;
  modelConfiguration?: EngineerModelConfiguration;
  now?: () => Date;
  idFactory?: () => string;
  safetyIdentifierForUser?: (userId: string) => string;
  /** Dedicated server-only prompt-cache key; distinct from identity and lease secrets. */
  hardeningPromptCacheSecret?: string;
  leaseManager?: EngineerWorkerLeaseManager;
  workerOwnerId?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  /** Required only when a classified READY candidate is promoted to REVIEW_APPROVED. */
  checkpointAttestor?: CheckpointAttestor;
  /** Fault-injection seam used only by deterministic crash-recovery tests. */
  afterClassificationPersistedForTest?: (classification: ReviewClassificationBatch) => void | Promise<void>;
  /** Fault-injection seam used only after the exact classified Evidence Bundle is durable. */
  afterEvidenceBundlePersistedForTest?: (bundle: EvidenceBundleRecord) => void | Promise<void>;
  /** Fault-injection seam used only by deterministic Builder recovery tests. */
  beforeBuilderDispatchForTest?: (input: { runId: string; inputHash: string }) => void | Promise<void>;
  /** Fault-injection seam used only by deterministic Builder recovery tests. */
  afterBuilderDispatchRecordedForTest?: (input: { runId: string; inputHash: string; agentExecutionId: string }) => void;
  /** Fault-injection seam used only by lease/claim boundary tests. */
  afterBuilderClaimPersistedForTest?: (input: { runId: string; inputHash: string; agentExecutionId: string }) => void | Promise<void>;
  /** Fault-injection seam used only by paid-boundary lease tests. */
  afterBuilderTransportAcquiredForTest?: (input: { runId: string; inputHash: string; agentExecutionId: string }) => void | Promise<void>;
  /** Fault-injection seam used only by post-reservation lease tests. */
  afterBuilderReservationForTest?: (input: { runId: string; inputHash: string; agentExecutionId: string; reservationId?: string }) => void | Promise<void>;
  /** Fault-injection seam used only by deterministic Builder recovery tests. */
  afterBuilderModelCallPersistedForTest?: (input: { runId: string; inputHash: string; agentExecutionId: string }) => void;
  /** Fault-injection seam used only by deterministic Builder recovery tests. */
  afterBuilderResultPersistedForTest?: (input: { runId: string; inputHash: string; artifactId: string }) => void;
  /** Crash seam immediately after the immutable optional-hardening H checkpoint is durable. */
  afterOptionalHardeningCheckpointPersistedForTest?:(artifact:ArtifactRecord)=>void;
  /** Crash seam after atomic ingress C is durable and before Reviewer agent/provider admission. */
  afterOptionalHardeningIngressCommittedForTest?:(input:{runId:string;authorityArtifactId:string})=>void;
  /** Adversarial seam after one full authority read and before a paid boundary recheck. */
  afterHardeningReviewerAuthorityCheckedForTest?:(stage:"BEFORE_RESERVATION"|"BEFORE_DISPATCH")=>void;
}

interface AgentContext {
  id: string;
  routingDecisionId: string;
  role: ModelRole;
  startedAt: string;
  inputHash: string;
  route: ReturnType<typeof resolveEngineerModel>;
}

class BuilderRecoveryPausedError extends Error {
  constructor(runId: string) {
    super(`Builder recovery for ${runId} requires an explicit human/provider reconciliation`);
    this.name = "BuilderRecoveryPausedError";
  }
}

class BuilderDispatchClaimLostError extends Error {
  constructor(runId: string) {
    super(`another worker owns the durable Builder dispatch for ${runId}`);
    this.name = "BuilderDispatchClaimLostError";
  }
}

class HardeningVerificationStoppedError extends Error {
  constructor(runId: string, testId: string) {
    super(`optional hardening ${runId} stopped because inherited required test ${testId} failed stably`);
    this.name = "HardeningVerificationStoppedError";
  }
}

export { scopeCriterionIds } from "./final-change-scope.js";

/** Phase-3 authority: independent tools verify, Terra advises, isolated Sol challenges. */
export class EngineerVerificationManager {
  private readonly options: EngineerVerificationManagerOptions;
  private readonly active = new Map<string, Promise<VerificationResult>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly cancelling = new Set<string>();
  private readonly activeLeases = new Map<string, WorkerLeaseGrant>();
  private readonly cancellationWorkerLeaseRevocations = new Map<string, () => void>();
  private readonly cancellationPaidFenceRevocations = new Map<string, () => void>();
  private readonly hardeningRecoveryTokens = new Map<string, string>();

  constructor(options: EngineerVerificationManagerOptions) {
    this.options = options;
    this.options.supervisor.configureArtifactReadAuthority?.(options.artifactStore);
    if(options.leaseManager)this.options.supervisor.configureRecoveryWorkerLeaseAuthority?.(options.leaseManager);
  }

  usesWorkerLeaseAuthority(authority:EngineerWorkerLeaseManager):boolean{
    return this.options.leaseManager===authority;
  }

  isActive(runId: string): boolean { return this.active.has(runId); }

  private recoverHardeningPaidCallLifecycleIfUnowned(runId:string):boolean{
    if(!this.options.supervisor.isOptionalHardeningChild(runId))return false;
    if(!this.options.hardeningPromptCacheSecret)return false;
    if(!this.options.supervisor.hasOutstandingHardeningPaidCallRecoveryWork(runId))return false;
    const leaseManager=this.options.leaseManager;if(!leaseManager)return false;
    const ownerId=`${this.options.workerOwnerId??"engineer-verification-worker"}:paid-call-recovery`;
    let lease:WorkerLeaseGrant;
    try{lease=leaseManager.acquire({resourceKey:`run:${runId}`,ownerId,ttlMs:this.options.leaseTtlMs??30_000,
      idempotencyKey:`paid-recovery:${randomUUID()}`});}
    catch(error){if(error instanceof Error&&["WorkerLeaseConflictError","WorkerLeaseCapacityError"].includes(error.name))return false;throw error;}
    const nowMs=(this.options.now??(()=>new Date()))().getTime();
    let primaryError:unknown;
    try{
      let rawToken=this.hardeningRecoveryTokens.get(runId);
      if(!rawToken){rawToken=randomUUID();this.hardeningRecoveryTokens.set(runId,rawToken);}
      this.options.supervisor.recoverHardeningPaidCallLifecycle({childRunId:runId,ownerId,rawToken,nowMs,
        recoveryWorkerLease:{leaseId:lease.lease.leaseId,ownerId,fencingToken:lease.lease.fencingToken,
          leaseToken:lease.leaseToken}});
      return true;
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

  ownsBudgetCheckpoint(runId: string): boolean {
    const latestWorkTransition = this.latestRepairCheckpoint(runId);
    return latestWorkTransition?.nextState === "IMPLEMENTING"
      && ["REVIEW_REPAIR_STARTED", "STABLE_REQUIRED_TEST_REPAIR_STARTED"].includes(latestWorkTransition.reasonCode);
  }

  verify(runId: string): Promise<VerificationResult> {
    return this.runActive(runId, () => this.verifyPass(runId));
  }

  resumeOptionalHardeningRecovered(snapshot:OptionalHardeningWorkspaceRecoverySnapshot):Promise<VerificationResult>{
    const operation=snapshot.state==="FAST_CHECKS"?()=>this.verifyPass(snapshot.runId):
      snapshot.state==="REVIEWING"&&snapshot.stage.kind==="INDEPENDENT"?
        snapshot.stage.classified?()=>this.recoverClassifiedReview(snapshot.runId):()=>this.verifyPass(snapshot.runId):
      ()=>this.recoverInterruptedVerification(snapshot.runId);
    return this.runActive(snapshot.runId,operation,snapshot);
  }

  resumeBudgetCheckpoint(runId: string): Promise<VerificationResult> {
    return this.runActive(runId, () => this.recoverInterruptedVerification(runId));
  }

  private runActive(runId: string, operation: () => Promise<VerificationResult>,
    preparedSnapshot?:OptionalHardeningWorkspaceRecoverySnapshot): Promise<VerificationResult> {
    let hardeningSnapshot:OptionalHardeningWorkspaceRecoverySnapshot|undefined;
    if(this.options.supervisor.isOptionalHardeningChild(runId)){
      const prepare=(this.options.executionManager as EngineerExecutionManager&{
        prepareOptionalHardeningWorkspaceRecoveryForRun?:(runId:string)=>OptionalHardeningWorkspaceRecoverySnapshot;
      }).prepareOptionalHardeningWorkspaceRecoveryForRun;
      // Minimal unit fakes that exercise only deterministic verification do
      // not implement the restart boundary. Every real ExecutionManager does.
      if(prepare){
        if(!this.options.hardeningPromptCacheSecret)throw new HardeningPromptCacheAuthorityUnavailableError();
        // Pure read-only snapshot preparation is deliberately before controller,
        // active-map, worker-lease, sandbox, or failure mutation.
        hardeningSnapshot=preparedSnapshot??prepare.call(this.options.executionManager,runId);
      }
    }
    const existing = this.active.get(runId);
    if (existing) return existing;
    const controller = new AbortController();
    this.abortControllers.set(runId, controller);
    // Fail closed while the worker still owns its fencing lease. Handling the
    // rejection outside withWorkerLease() races its finally block: the lease is
    // released first, then transition() rejects the failure-state write as
    // stale, leaving the run stranded in REVIEWING/VERIFYING.
    const guardedOperation = async (): Promise<VerificationResult> => {
      try {
        return await operation();
      } catch (error) {
        if(error instanceof HardeningGenericOperationForbiddenError&&hardeningSnapshot){
          this.assertLeaseAuthority(runId);const current=this.options.supervisor.getRun(runId);
          if(!current.terminalAt&&!['CANCELLATION_PENDING','CANCELLED'].includes(current.state)&&
            current.state===hardeningSnapshot.state&&current.stateVersion===hardeningSnapshot.stateVersion){
            const reasonCode=hardeningSnapshot.state==="REVIEWING"
              ?"HARDENING_REVIEWER_RECOVERY_AUTHORITY_INVALID" as const
              :"HARDENING_WORKSPACE_RECOVERY_AUTHORITY_INVALID" as const;
            this.options.supervisor.quarantineOptionalHardeningRecovery({runId,
              expectedStateVersion:hardeningSnapshot.stateVersion,reasonCode});
            throw reasonCode==="HARDENING_REVIEWER_RECOVERY_AUTHORITY_INVALID"
              ?new HardeningReviewerRecoveryAuthorityInvalidError(runId)
              :new HardeningWorkspaceRecoveryAuthorityInvalidError(runId);
          }
        }
        if (!(error instanceof BudgetPausedError) && !(error instanceof BuilderRecoveryPausedError) &&
            !(error instanceof HardeningVerificationStoppedError) &&
            !(error instanceof BuilderDispatchClaimLostError) &&
            !isWorkerAuthorityLoss(error, controller.signal) && !controller.signal.aborted) {
          this.failClosed(runId, error);
        }
        throw error;
      }
    };
    const leaseOperation=async()=>{
      if(hardeningSnapshot){
        // Recompute the complete durable stage hash under the worker lease,
        // then and only then recover/reset=false and inspect workspace bytes.
        try{
          this.options.executionManager.assertOptionalHardeningRecoveryAuthority(hardeningSnapshot);
          await this.options.executionManager.activateOptionalHardeningWorkspaceRecovery(hardeningSnapshot,
            ()=>this.assertLeaseAuthority(runId),()=>{const grant=this.activeLeases.get(runId);return grant?{
              leaseId:grant.lease.leaseId,ownerId:grant.lease.ownerId,fencingToken:grant.lease.fencingToken,
            }:null;});
        }catch(error){
          if(!(error instanceof HardeningGenericOperationForbiddenError))throw error;
          this.assertLeaseAuthority(runId);
          const reasonCode=hardeningSnapshot.state==="REVIEWING"
            ?"HARDENING_REVIEWER_RECOVERY_AUTHORITY_INVALID" as const
            :"HARDENING_WORKSPACE_RECOVERY_AUTHORITY_INVALID" as const;
          this.options.supervisor.quarantineOptionalHardeningRecovery({runId,
            expectedStateVersion:hardeningSnapshot.stateVersion,reasonCode});
          throw reasonCode==="HARDENING_REVIEWER_RECOVERY_AUTHORITY_INVALID"
            ?new HardeningReviewerRecoveryAuthorityInvalidError(runId)
            :new HardeningWorkspaceRecoveryAuthorityInvalidError(runId);
        }
      }
      return guardedOperation();
    };
    const promise = this.withWorkerLease(runId, controller, leaseOperation)
      .finally(() => {
        this.active.delete(runId);
        this.abortControllers.delete(runId);
        this.activeLeases.delete(runId);
        if(this.options.supervisor.isOptionalHardeningChild(runId)&&!this.cancelling.has(runId)){
          try{this.recoverHardeningPaidCallLifecycleIfUnowned(runId);}catch{/* periodic provider-free recovery retries durably */}
        }
      });
    this.active.set(runId, promise);
    return promise;
  }

  cancel(runId: string): void {
    this.cancelling.add(runId);
    this.abortControllers.get(runId)?.abort(new Error("Engineer verification was cancelled"));
    this.cancellationPaidFenceRevocations.get(runId)?.();
    this.cancellationWorkerLeaseRevocations.get(runId)?.();
  }

  async waitForIdle(runId:string):Promise<void>{
    const active=this.active.get(runId);if(active)await active.catch(()=>undefined);
  }

  finishCancellation(runId:string):void{this.cancelling.delete(runId);}

  resumeRecovered(runId: string): void {
    if(this.options.supervisor.isOptionalHardeningChild(runId)&&!this.options.hardeningPromptCacheSecret)return;
    const existing = this.active.get(runId);
    if (existing) {
      this.cancel(runId);
      void existing.finally(() => {
        const run = this.options.supervisor.getRun(runId);
        if (!run.terminalAt && run.state !== "CANCELLATION_PENDING") {
          void this.resumeBudgetCheckpoint(runId).catch(() => undefined);
        }
      });
      return;
    }
    const run = this.options.supervisor.getRun(runId);
    if (!run.terminalAt && run.state !== "CANCELLATION_PENDING") {
      void this.resumeBudgetCheckpoint(runId).catch(() => undefined);
    }
  }

  private async withWorkerLease(
    runId: string,
    controller: AbortController,
    operation: () => Promise<VerificationResult>,
  ): Promise<VerificationResult> {
    const leaseManager = this.options.leaseManager;
    if (!leaseManager) return operation();
    const ownerId = this.options.workerOwnerId ?? "engineer-verification-worker";
    let grant = leaseManager.acquire({
      resourceKey: `run:${runId}`,
      ownerId,
      ttlMs: this.options.leaseTtlMs ?? 30_000,
      idempotencyKey: `verify:${runId}:${this.options.supervisor.getRun(runId).stateVersion}`,
    });
    this.activeLeases.set(runId, grant);
    let heartbeatSequence = 0;
    const timer = setInterval(() => {
      heartbeatSequence += 1;
      try {
        const lease = leaseManager.heartbeat({
          leaseId: grant.lease.leaseId,
          ownerId,
          fencingToken: grant.lease.fencingToken,
          leaseToken: grant.leaseToken,
          idempotencyKey: `verify-heartbeat:${heartbeatSequence}`,
        });
        grant = { ...grant, lease };
        this.activeLeases.set(runId, grant);
      } catch (error) {
        clearInterval(timer);
        controller.abort(error);
      }
    }, this.options.heartbeatIntervalMs ?? 10_000);
    timer.unref?.();
    const revokeCancellationAuthority=()=>{
      clearInterval(timer);
      this.activeLeases.delete(runId);
      controller.abort(new Error("Engineer verification authority was revoked for cancellation"));
      try{leaseManager.release({leaseId:grant.lease.leaseId,ownerId,fencingToken:grant.lease.fencingToken,
        leaseToken:grant.leaseToken,idempotencyKey:`verify-cancel-release:${grant.lease.renewalCount}`});}
      catch{/* expiry/recovery already revoked it */}
    };
    this.cancellationWorkerLeaseRevocations.set(runId,revokeCancellationAuthority);
    if(this.cancelling.has(runId))revokeCancellationAuthority();
    try {
      return await operation();
    } finally {
      if(this.cancellationWorkerLeaseRevocations.get(runId)===revokeCancellationAuthority)
        this.cancellationWorkerLeaseRevocations.delete(runId);
      clearInterval(timer);
      try {
        leaseManager.release({
          leaseId: grant.lease.leaseId,
          ownerId,
          fencingToken: grant.lease.fencingToken,
          leaseToken: grant.leaseToken,
          idempotencyKey: `verify-release:${grant.lease.renewalCount}`,
        });
      } catch { /* an expired/fenced lease is already released from authority */ }
    }
  }

  recoverReady(runIds?:readonly string[]): Array<{ runId: string; promise: Promise<VerificationResult> }> {
    const states = [
      "FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "FLAKE_QUARANTINE",
      "SECURITY_REVIEW", "CODE_REVIEW", "EVIDENCE_SYNTHESIS", "REVIEWING",
      "REVIEW_CHANGES_REQUESTED", "REVIEW_FIX_PREPARING", "VERIFICATION_RECOVERY", "IMPLEMENTING",
      "HUMAN_REVIEW_REQUIRED",
    ] as const;
    const recoveries: Array<{ runId: string; promise: Promise<VerificationResult> }> = [];
    const stateSet=new Set<string>(states);
    const candidates=runIds?
      runIds.map((runId)=>this.options.supervisor.getRun(runId)).filter((run)=>stateSet.has(run.state)):
      this.options.supervisor.listRuns([...states]);
    for (const run of candidates) {
      const hardeningChild=this.options.supervisor.isOptionalHardeningChild(run.runId);
      if(hardeningChild){
        if(!this.options.hardeningPromptCacheSecret)continue;
        if(!this.options.executionManager.hasOptionalHardeningAuthority(run.runId))continue;
        if(this.options.supervisor.hasOutstandingHardeningPaidCallRecoveryWork(run.runId)){
          const nowMs=(this.options.now??(()=>new Date()))().getTime();
          if(!this.options.supervisor.hardeningPaidCallRecoveryReady(run.runId,nowMs))continue;
          if(!this.recoverHardeningPaidCallLifecycleIfUnowned(run.runId))continue;
          if(this.options.supervisor.getRun(run.runId).terminalAt)continue;
        }
      }
      const expectedBuilderInputHash = this.expectedBuilderRepairInputHash(run.runId);
      const ambiguousBuilder = expectedBuilderInputHash !== null &&
        this.options.supervisor.builderRepairExecutions(run.runId, expectedBuilderInputHash)
          .some((agent) => ["RUNNING", "FAILED", "PAUSED"].includes(agent.status));
      const ambiguousModelAgent = ambiguousBuilder ||
        (this.options.supervisor.exportRunRecords(run.runId)?.agent_executions ?? [])
          .some((agent) => agent.status === "RUNNING" && typeof agent.role === "string" &&
            ["TESTER", "SECURITY", "REVIEWER"].includes(agent.role));
      if (!hardeningChild && ambiguousModelAgent && canTransition(run.state, "MODEL_PROVIDER_RETRY_PENDING")) {
        const now = this.timestamp();
        this.options.supervisor.finalizeRunningAgentExecutions(run.runId, "FAILED", "VERIFICATION_PROCESS_INTERRUPTED", now);
        this.options.supervisor.recordFailure(FailureRecordSchema.parse({
          failureId: this.id(), runId: run.runId, failureClass: "MODEL_FAILURE",
          reasonCode: "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS",
          fingerprint: sha256({ runId: run.runId, stateVersion: run.stateVersion, reason: "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS" }),
          evidenceIds: [], retryable: true, createdAt: now,
        }));
        this.transition(run.runId, "MODEL_PROVIDER_RETRY_PENDING", "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS");
        continue;
      }
      if ((["REVIEWING", "REVIEW_CHANGES_REQUESTED", "REVIEW_FIX_PREPARING"].includes(run.state) ||
          (run.state === "IMPLEMENTING" && this.latestRepairCheckpoint(run.runId)?.reasonCode === "REVIEW_REPAIR_STARTED")) &&
          this.options.supervisor.latestClassifiedReview(run.runId)) {
        recoveries.push({ runId: run.runId, promise: this.runActive(run.runId, () => this.recoverClassifiedReview(run.runId)) });
        continue;
      }
      // A raw Reviewer artifact is evidence, never durable execution authority.
      // HUMAN_REVIEW_REQUIRED remains paused until a human acts; it cannot be
      // resurrected into an automatic repair by legacy raw-output recovery.
      if (run.state === "HUMAN_REVIEW_REQUIRED" ||
          (run.state === "IMPLEMENTING" && !this.isInterruptedPhase3Repair(run.runId))) continue;
      recoveries.push({
        runId: run.runId,
        promise: run.state === "FAST_CHECKS"
          ? this.verify(run.runId)
          : this.resumeBudgetCheckpoint(run.runId),
      });
    }
    return recoveries;
  }

  private async recoverClassifiedReview(runId: string): Promise<VerificationResult> {
    const supervisor = this.options.supervisor;
    const authority = supervisor.latestClassifiedReview(runId);
    const manifest = supervisor.getManifest(runId);
    if (!authority || !manifest) throw new Error("classified review recovery authority is unavailable");
    const { classification, reviewerInput, session } = authority;
    // Strict classified rehydration is necessary but not sufficient: a worker
    // that lost its fencing lease must not persist any derived authority.
    this.assertLeaseAuthority(runId);
    const pass = Math.max(1, ...reviewerInput.trustedEvidence.map((item) =>
      typeof item.payload.verificationPass === "number" ? item.payload.verificationPass : 1));
    const claims = this.mapClaims(manifest, session.output, reviewerInput.trustedEvidence, pass, classification.createdAt);
    if(supervisor.isOptionalHardeningChild(runId)){
      const expectedById=new Map(claims.map((claim)=>[claim.claimId,claim]));
      const existing=supervisor.listClaimEvidence(runId);
      if(existing.length>claims.length||existing.some((claim)=>{
        const expected=expectedById.get(claim.claimId);return !expected||canonicalJson(expected)!==canonicalJson(claim);
      }))throw new HardeningGenericOperationForbiddenError();
    }
    await this.options.afterClassificationPersistedForTest?.(classification);
    this.assertLeaseAuthority(runId);
    for (const claim of claims) supervisor.recordClaimEvidence(claim);
    const sandbox = await this.options.executionManager.recoverSandbox(
      runId, false, () => this.assertLeaseAuthority(runId),
    );
    this.assertLeaseAuthority(runId);
    const expectedBundle = this.bundle(
      manifest, sandbox.record, reviewerInput.resultCommitSha, claims, session.reviewerSessionId,
      classification.classificationHash, classification.result, classification.createdAt, session.decision,
      this.classificationArtifacts(reviewerInput, classification.rawOutput.artifactId),
    );
    if(supervisor.isOptionalHardeningChild(runId)){
      const bundles=supervisor.listEvidenceBundles(runId);
      if(bundles.length>1||(bundles.length===1&&canonicalJson(bundles[0])!==canonicalJson(expectedBundle)))
        throw new HardeningGenericOperationForbiddenError();
    }
    this.assertLeaseAuthority(runId);
    const evidenceBundle = this.recordOrVerifyClassifiedBundle(expectedBundle);
    this.assertLeaseAuthority(runId);
    await this.options.afterEvidenceBundlePersistedForTest?.(evidenceBundle);
    this.assertLeaseAuthority(runId);
    const result = VerificationResultSchema.parse({
      runId, verificationExecutions: [], securityFindings: supervisor.listSecurityFindings(runId),
      reviewerSession: session, claims, evidenceBundle,
    });
    return this.applyClassifiedOutcome({
      manifest, sandbox, reviewerInput, classification, session, findings: authority.findings, result,
      evidenceIds: [classification.rawOutput.artifactId],
      recoveryOnly: true,
    });
  }

  private async verifyPass(runId: string): Promise<VerificationResult> {
    const supervisor = this.options.supervisor;
    const initial = supervisor.getRun(runId);
    const hardeningChild=supervisor.isOptionalHardeningChild?.(runId)===true;
    if ((!hardeningChild||initial.state!=="REVIEWING")&&!["FAST_CHECKS", "SECURITY_REVIEW"].includes(initial.state) || !initial.manifestHash) {
      throw new Error(`Phase 3 verification requires FAST_CHECKS or a durable SECURITY_REVIEW checkpoint, not ${initial.state}`);
    }
    const manifest = supervisor.getManifest(runId);
    if (!manifest) throw new Error("frozen manifest is unavailable");
    const safetyIdentifier = this.options.safetyIdentifierForUser?.(initial.userId);
    const sandbox = this.options.executionManager.getSandbox(runId)
      ?? await this.options.executionManager.recoverSandbox(
        runId, false, () => this.assertLeaseAuthority(runId),
      );
    this.assertLeaseAuthority(runId);
    const workspaceManager = this.options.sandboxManager.workspaceManager();
    const testIntegrity = TestIntegrityGuard.load({
      supervisor,
      artifactStore: this.options.artifactStore,
      manifest,
      workspace: sandbox.workspace,
      now: this.options.now,
      strictArtifactReads:hardeningChild,
    });
    const resultCommitSha = await workspaceManager.checkpointAsync(sandbox.workspace, `zintus engineer ${runId} verification checkpoint`);
    const diff = await workspaceManager.diffAsync(sandbox.workspace);
    const rawCheckpoints=supervisor.listArtifacts(runId).filter((artifact)=>artifact.type==="INDEPENDENT_VERIFICATION_CHECKPOINT");
    if(hardeningChild&&rawCheckpoints.length>1)throw new Error("optional-hardening independent checkpoint authority is ambiguous");
    let finalDiffArtifact:ArtifactRecord,independentCheckpointArtifact:ArtifactRecord|undefined=rawCheckpoints[0];
    if(hardeningChild&&rawCheckpoints.length===1){
      const raw=rawCheckpoints[0]!;
      if(!raw.trusted||raw.producerType!=="SYSTEM"||raw.producerId!=="engineer-verification")
        throw new Error("optional-hardening independent checkpoint authority is invalid");
      const value=JSON.parse(this.options.artifactStore.readVerifiedExact(raw).toString("utf8")) as Record<string,unknown>;
      if(value.version!==2||typeof value.diffArtifactId!=="string"||typeof value.diffArtifactHash!=="string")
        throw new Error("optional-hardening independent checkpoint v2 is required");
      const matches=supervisor.listArtifacts(runId).filter((artifact)=>artifact.artifactId===value.diffArtifactId&&
        artifact.sha256===value.diffArtifactHash&&artifact.type==="FINAL_DIFF"&&artifact.trusted&&
        artifact.producerType==="SYSTEM"&&artifact.producerId==="engineer-verification");
      if(matches.length!==1||this.options.artifactStore.readVerifiedExact(matches[0]!).toString("utf8")!==diff)
        throw new Error("optional-hardening checkpoint diff authority is invalid");
      finalDiffArtifact=matches[0]!;
    }else{
      finalDiffArtifact=supervisor.recordArtifact(this.options.artifactStore.put({
        runId,type:"FINAL_DIFF",bytes:diff,producerType:"SYSTEM",producerId:"engineer-verification",trusted:true,
      }));
    }
    const pass = supervisor.nextReviewerAttempt(runId);
    if(hardeningChild&&pass!==1)throw new HardeningGenericOperationForbiddenError();
    let verified = this.loadIndependentVerificationCheckpoint(runId, manifest.manifestHash, sha256(diff), resultCommitSha);
    if (!verified) {
      if (initial.state !== "FAST_CHECKS") throw new Error("durable independent-verification checkpoint is unavailable");
      const preVerificationIntegrity = testIntegrity.attest("PRE_VERIFICATION");
      const executor = this.executor(manifest, sandbox);
      try {
      // A locally checkable explicit API contract must hold before any advisor
      // or Reviewer model dispatch. This catches planner drift (for example a
      // requested exported class implemented as a different functional API)
      // with zero additional provider cost.
      try {
        assertWorkspaceSatisfiesExplicitApiContract(sandbox.workspace.workspaceRoot, manifest);
      } catch (error) {
        if (!(error instanceof ExplicitContractViolationError)) throw error;
        throw new IndependentVerificationFailure({
          failureClass: "IMPLEMENTATION_FAILURE",
          reasonCode: "EXPLICIT_CONTRACT_VIOLATION",
          evidenceIds: [],
          details: { violations: error.violations },
          message: error.message,
        });
      }
      const verification = new IndependentVerifier({
        supervisor,
        artifactStore: this.options.artifactStore,
        manifest,
        executor,
        diff: () => diff,
        // Every return to FAST_CHECKS has a new durable state version, including
        // Builder repair loops that occur before any Reviewer session exists.
        verificationPass: initial.stateVersion,
        deterministicSecurityGateCovered: hardeningChild,
        beforeCommand: () => testIntegrity.captureCommandSnapshot(),
        afterCommand: (command, beforeSnapshot) => testIntegrity.assertCommandDidNotMutate(beforeSnapshot, command),
        now: this.options.now,
        idFactory: this.options.idFactory,
        commandBaseline: loadTestCommandBaseline({ supervisor, artifactStore: this.options.artifactStore, manifest }),
      }).run();
      verified = await verification;
      verified.trustedEvidence.unshift(this.testIntegrityEvidence(preVerificationIntegrity.artifact, preVerificationIntegrity.comparison));
      const postVerificationIntegrity = testIntegrity.attest("POST_INDEPENDENT_VERIFICATION");
      verified.trustedEvidence.push(this.testIntegrityEvidence(postVerificationIntegrity.artifact, postVerificationIntegrity.comparison));
      } catch (error) {
        if (error instanceof StableRequiredTestFailure) {
          if(hardeningChild){
            const evidenceIds=error.evidence.map((item)=>item.evidenceId);
            supervisor.stopOptionalHardeningForStableRequiredTest(FailureRecordSchema.parse({
              failureId:sha256({namespace:"engineer-hardening-stable-required-test-stop-v1",runId,
                manifestHash:manifest.manifestHash,testId:error.test.testId,
                failureFingerprint:error.failureFingerprint,evidenceIds}),
              runId,failureClass:"TEST_FAILURE",reasonCode:"STABLE_REQUIRED_TEST_FAILED",
              fingerprint:error.failureFingerprint,evidenceIds,retryable:false,
              createdAt:error.evidence.at(-1)?.createdAt??this.timestamp(),
            }));
            throw new HardeningVerificationStoppedError(runId,error.test.testId);
          }
          return this.repairStableRequiredTest(manifest, sandbox, resultCommitSha, diff, error);
        }
        if (error instanceof IndependentVerificationFailure) {
          // An explicit-contract failure is already a deterministic, local
          // fact. Do not pay an advisory model merely to restate it.
          if(!hardeningChild && error.reasonCode !== "EXPLICIT_CONTRACT_VIOLATION") await this.recordLunaFailureAdvisory(manifest, error).catch(() => undefined);
        }
        throw error;
      }
      independentCheckpointArtifact=this.storeIndependentVerificationCheckpoint(
        runId,manifest.manifestHash,sha256(diff),resultCommitSha,verified,finalDiffArtifact);
      if(hardeningChild)this.options.afterOptionalHardeningCheckpointPersistedForTest?.(independentCheckpointArtifact);
    }
    if (!verified) throw new Error("independent verification checkpoint resolution failed");

    let recoveredReviewerInput:ReturnType<typeof ReviewerInputSchema.parse>|null=null,
      hardeningCheckpoint:ReturnType<EngineerVerificationManager["optionalHardeningCheckpointAuthority"]>|null=null,
      hardeningRequestAuthority:ReturnType<typeof buildIsolatedReviewerRequestPlan>["authority"]|null=null,
      hardeningIngressTimes:ReturnType<typeof hardeningReviewerIngressTimes>|null=null,
      pendingHardeningScope:{artifact:ArtifactRecord;payload:ReturnType<typeof buildFinalChangeScopeAttestation>}|null=null;
    if(hardeningChild){
      if(!independentCheckpointArtifact)throw new HardeningGenericOperationForbiddenError();
      hardeningCheckpoint=this.optionalHardeningCheckpointAuthority(runId,manifest.manifestHash,independentCheckpointArtifact);
      hardeningIngressTimes=hardeningReviewerIngressTimes({headTimestamp:hardeningCheckpoint.chain.head.timestamp,
        checkpointCreatedAt:independentCheckpointArtifact.createdAt,
        checkpointEvidence:hardeningCheckpoint.checkpoint.verified.trustedEvidence});
      if(initial.state==="REVIEWING"&&!hardeningCheckpoint.chain.completed)throw new HardeningGenericOperationForbiddenError();
      const inputAuthorities=supervisor.listArtifacts(runId).filter((artifact)=>artifact.type==="HARDENING_REVIEW_INPUT_AUTHORITY");
      if(hardeningCheckpoint.chain.completed&&inputAuthorities.length!==1)throw new HardeningGenericOperationForbiddenError();
      if(!hardeningCheckpoint.chain.completed&&inputAuthorities.length)throw new HardeningGenericOperationForbiddenError();
      if(hardeningCheckpoint.chain.completed){
        const loaded=this.loadOptionalHardeningReviewInputAuthority({runId,manifestHash:manifest.manifestHash,
          diffHash:sha256(diff),resultCommitSha,checkpointArtifact:independentCheckpointArtifact,
          checkpointHash:hardeningCheckpoint.checkpoint.checkpointHash,
          completionEvidenceIds:hardeningCheckpoint.chain.completed.evidenceIds,safetyIdentifier});
        recoveredReviewerInput=loaded.authority.reviewerInput;
        hardeningRequestAuthority=loaded.authority.requestAuthority;
        if(recoveredReviewerInput.reviewAttempt!==pass)throw new HardeningGenericOperationForbiddenError();
      }
    }

    // Scope is a Supervisor-owned fact. It must never be delegated back to the
    // Builder as a speculative test or inferred from a Reviewer narrative.
    if(!recoveredReviewerInput){
      if(hardeningChild){
        if(!hardeningCheckpoint||!hardeningIngressTimes)throw new HardeningGenericOperationForbiddenError();
        const payload=buildFinalChangeScopeAttestation({manifest,diff,resultCommitSha,
          credentialedGitOperationCount:supervisor.listGitOperations(runId).length}),pending=this.options.artifactStore.put({
            runId,type:"FINAL_CHANGE_SCOPE_ATTESTATION",bytes:canonicalJson(payload),producerType:"SYSTEM",
            producerId:"final-change-scope-policy",trusted:true,createdAt:hardeningIngressTimes.scopeAt}),
          artifact=ArtifactRecordSchema.parse({...pending,artifactId:hardeningFinalScopeArtifactId({runId,
            checkpointHash:hardeningCheckpoint.checkpoint.checkpointHash,scopePayloadHash:sha256(payload)})});
        pendingHardeningScope={artifact,payload};
        verified.trustedEvidence.push(TrustedEvidenceSchema.parse({evidenceId:artifact.artifactId,runId,
          eventType:"FINAL_CHANGE_SCOPE_ATTESTATION",producerType:"SYSTEM",producerId:"final-change-scope-policy",
          sha256:artifact.sha256,payload,createdAt:artifact.createdAt}));
      }else{
        const finalScopeEvidence=this.finalChangeScopeEvidence(manifest,diff,resultCommitSha);
        verified.trustedEvidence.push(finalScopeEvidence);
      }
    }

    let adversarialCoverage:AdversarialCoverageReport|null=null;
    let advisoryFindingRecords:SecurityFindingRecord[]=[];
    let unresolvedSecurityAdvisories=0;
    if(!hardeningChild){
    const advisorAgents = new Map<"TESTER" | "SECURITY", AgentContext>();
    const advisors = new TerraAdvisors({
      signal: this.abortControllers.get(runId)?.signal,
      transportForRole: (role) => this.options.transportForRole(runId, role),
      modelConfiguration: this.options.modelConfiguration,
      safetyIdentifier,
      reserveModelCall: ({ role, model, inputTokenUpperBound, maxOutputTokens, attempt }) => {
        const agent = advisorAgents.get(role);
        if (!agent) throw new Error(`missing ${role} execution context for budget reservation`);
        return supervisor.reserveModelBudget({
          runId, reservationId: sha256({ runId, agentExecutionId: agent.id, role, pass, attempt, purpose: "advisor-model-call" }),
          agentExecutionId: agent.id,
          model, inputTokenUpperBound, maxOutputTokens,
        });
      },
      authorizeModelRetry: ({ role, error, attempt, failedAttempt, inputHash, cacheKey, reservationId, latencyMs }) => {
        const agent = advisorAgents.get(role);
        if (!agent) throw new Error(`missing ${role} execution context for failed call evidence`);
        supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: agent.id,
          logicalTier: agent.route.logicalTier, resolvedModel: agent.route.model,
          promptTemplateVersion: TERRA_ADVISOR_POLICY_VERSION, inputContextRefs: [manifest.manifestHash, inputHash],
          outputSchemaVersion: "phase3-advisory-v1", cacheKey, cacheHit: null, latencyMs,
          inputTokens: null, outputTokens: null, retryCount: failedAttempt, status: "FAILED", createdAt: this.timestamp(),
        }, reservationId);
        return this.authorizeTransientModelRetry(runId, role, error, attempt);
      },
      onModelCall: (observation) => {
        const agent = advisorAgents.get(observation.role);
        if (!agent) throw new Error(`missing ${observation.role} execution context`);
        supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: agent.id,
          logicalTier: agent.route.logicalTier, resolvedModel: agent.route.model,
          promptTemplateVersion: TERRA_ADVISOR_POLICY_VERSION,
          inputContextRefs: [manifest.manifestHash, observation.inputHash], outputSchemaVersion: "phase3-advisory-v1",
          cacheKey: observation.cacheKey, cacheHit: observation.cachedInputTokens === null ? null : observation.cachedInputTokens > 0, latencyMs: observation.latencyMs,
          inputTokens: observation.inputTokens, outputTokens: observation.outputTokens,
          cachedInputTokens: observation.cachedInputTokens, cacheWriteInputTokens: observation.cacheWriteInputTokens,
          retryCount: observation.retryCount, status: "SUCCEEDED", createdAt: this.timestamp(),
        }, observation.reservationId);
      },
    });
    const testerEvidence=[...verified.trustedEvidence].sort((left,right)=>compareCodeUnits(left.evidenceId,right.evidenceId));
    const testerAgent = this.startAgent(runId, "TESTER", sha256({ manifest: manifest.manifestHash, diff: sha256(diff), evidence: testerEvidence }));
    advisorAgents.set("TESTER", testerAgent);
    let testAdvisory;
    try {
      testAdvisory = await advisors.testCoverage(manifest, diff, testerEvidence);
      this.assertLeaseAuthority(runId);
      this.storeAgentOutput(runId, testerAgent, "TEST_ADVISORY", testAdvisory);
      adversarialCoverage = buildAdversarialCoverageReport(manifest, testAdvisory);
      const coverageArtifact = supervisor.recordArtifact(this.options.artifactStore.put({
        runId,
        type: "ADVERSARIAL_COVERAGE_REPORT",
        bytes: canonicalJson(adversarialCoverage),
        producerType: "SYSTEM",
        producerId: "adversarial-coverage-policy",
        trusted: true,
      }));
      verified.trustedEvidence.push(TrustedEvidenceSchema.parse({
        evidenceId: coverageArtifact.artifactId,
        runId,
        eventType: "ADVERSARIAL_COVERAGE_REPORT",
        producerType: "SYSTEM",
        producerId: "adversarial-coverage-policy",
        sha256: coverageArtifact.sha256,
        payload: adversarialCoverage,
        createdAt: coverageArtifact.createdAt,
      }));
    } catch (error) {
      this.failAgent(runId, testerAgent);
      throw error;
    }

    const securityAgent = this.startAgent(runId, "SECURITY", sha256({ manifest: manifest.manifestHash, diff: sha256(diff) }));
    advisorAgents.set("SECURITY", securityAgent);
    let securityAdvisory;
    let securityArtifact;
    try {
      securityAdvisory = await advisors.security(manifest, diff);
      this.assertLeaseAuthority(runId);
      securityArtifact = this.storeAgentOutput(runId, securityAgent, "SECURITY_ADVISORY", securityAdvisory);
    } catch (error) {
      this.failAgent(runId, securityAgent);
      throw error;
    }
    advisoryFindingRecords = securityAdvisory.findings.map((finding) =>
      supervisor.recordSecurityFinding(SecurityFindingRecordSchema.parse({
        securityFindingId: this.id(), runId, severity: finding.severity,
        category: `AI_ADVISORY_${finding.category}`.slice(0, 200), description: finding.description,
        file: finding.file || null, lineStart: finding.lineStart || null, lineEnd: finding.lineEnd || null,
        evidenceIds: [securityArtifact.artifactId], status: "OPEN", createdAt: this.timestamp(),
      })),
    );unresolvedSecurityAdvisories=securityAdvisory.findings.length;
    }
    // Model security advice remains non-certifying. The adversarial coverage
    // report above is trusted only as a system-validated risk-floor record; it
    // can block approval but can never substantiate an acceptance criterion.
    let reviewerInput:ReturnType<typeof ReviewerInputSchema.parse>;
    if(recoveredReviewerInput){
      reviewerInput=recoveredReviewerInput;
    }
    else{
      const trustedEvidence=[...verified.trustedEvidence];
      let preReviewIntegrity:{artifact:ArtifactRecord;comparison:TestIntegrityComparison};
      if(hardeningChild){
        if(!hardeningCheckpoint||!hardeningIngressTimes)throw new HardeningGenericOperationForbiddenError();
        const prepared=testIntegrity.prepareAttestation("PRE_REVIEW",{comparedAt:hardeningIngressTimes.preReviewAt});
        preReviewIntegrity={...prepared,artifact:ArtifactRecordSchema.parse({...prepared.artifact,
          artifactId:hardeningPreReviewArtifactId({runId,checkpointHash:hardeningCheckpoint.checkpoint.checkpointHash,
            baselineHash:prepared.comparison.baselineHash,comparisonHash:prepared.comparison.comparisonHash})})};
        if(!preReviewIntegrity.comparison.passed)throw new TestIntegrityViolationError("TEST_BASELINE_TAMPERED",
          `immutable test surface changed at PRE_REVIEW: ${preReviewIntegrity.comparison.immutableChanges.join(", ")}`,
          preReviewIntegrity.artifact.artifactId);
      }else preReviewIntegrity=testIntegrity.attest("PRE_REVIEW");
      trustedEvidence.push(this.testIntegrityEvidence(preReviewIntegrity.artifact,preReviewIntegrity.comparison));
      trustedEvidence.sort((left,right)=>compareCodeUnits(left.evidenceId,right.evidenceId));
      const finalRiskFeatures=derivePostVerificationRiskFeatures({diff,
        requiredChecksPassed:verified.executions.every((execution)=>execution.status==="PASSED"),
        retryCount:supervisor.retryAttemptCount(runId),unresolvedWarnings:unresolvedSecurityAdvisories+
          (adversarialCoverage?.blockingGapIds.length??0)+(adversarialCoverage?.warnings.length??0),
        securityFindings:[...verified.securityFindings,...advisoryFindingRecords]});
      supervisor.assertRuntimeBudget(runId,{diffLines:finalRiskFeatures.diffLines});
      const currentRiskRun=supervisor.getRun(runId),finalRiskAssessment=hardeningChild?supervisor.prepareOptionalHardeningFinalRisk({
        runId,expectedStateVersion:currentRiskRun.stateVersion,checkpointHash:hardeningCheckpoint!.checkpoint.checkpointHash,
        features:finalRiskFeatures,assessedAt:hardeningIngressTimes!.riskAt,options:{autoApproveLowRisk:true}}):
        supervisor.assessRunRisk(runId,currentRiskRun.stateVersion,finalRiskFeatures,{autoApproveLowRisk:true}),
        evidenceBundleHash=reviewerEvidenceBundleHash({manifestHash:manifest.manifestHash,
          diffHash:sha256(diff),resultCommitSha,trustedEvidence,riskAssessment:finalRiskAssessment}),
        reviewCreatedAt=hardeningChild?hardeningIngressTimes!.reviewerAt:new Date(Math.max(
          Date.parse(finalRiskAssessment.assessedAt),...trustedEvidence.map((item)=>Date.parse(item.createdAt)))).toISOString(),
        reviewSessionId=hardeningChild?sha256({namespace:"engineer-hardening-review-session-v1",runId,
          checkpointHash:hardeningCheckpoint?.checkpoint.checkpointHash,attempt:pass}):this.id();
      reviewerInput=ReviewerInputSchema.parse({reviewSessionId,runId,reviewAttempt:pass,manifest,
        manifestHash:manifest.manifestHash,finalDiff:diff,diffHash:sha256(diff),trustedEvidence,evidenceBundleHash,
        resultCommitSha,riskAssessment:finalRiskAssessment,reviewPolicyVersion:REVIEWER_POLICY_VERSION,createdAt:reviewCreatedAt});
      if(hardeningChild){
        if(!independentCheckpointArtifact)throw new HardeningGenericOperationForbiddenError();
        hardeningCheckpoint=hardeningCheckpoint??this.optionalHardeningCheckpointAuthority(
          runId,manifest.manifestHash,independentCheckpointArtifact);
        const pendingSemanticRows=buildHardeningPendingSemanticRows({runId,
          checkpointHash:hardeningCheckpoint.checkpoint.checkpointHash,
          preReviewArtifact:preReviewIntegrity.artifact,preReview:preReviewIntegrity.comparison,
          riskAssessment:finalRiskAssessment});
        const reviewAuthority=this.prepareOptionalHardeningReviewInputAuthority({runId,manifestHash:manifest.manifestHash,
          diffHash:sha256(diff),resultCommitSha,checkpointArtifact:independentCheckpointArtifact,
          checkpointHash:hardeningCheckpoint.checkpoint.checkpointHash,reviewerInput,safetyIdentifier,
          pendingArtifacts:[pendingHardeningScope!.artifact,preReviewIntegrity.artifact],pendingSemanticRows,
          createdAt:hardeningIngressTimes!.reviewerAt});
        if(hardeningCheckpoint.chain.completed)throw new HardeningGenericOperationForbiddenError();
        this.assertLeaseAuthority(runId);const current=supervisor.getRun(runId),checkpoint=hardeningCheckpoint.checkpoint;
        supervisor.completeOptionalHardeningReviewInput({artifact:reviewAuthority,
          finalScopeArtifact:pendingHardeningScope!.artifact,finalScope:pendingHardeningScope!.payload,
          preReviewArtifact:preReviewIntegrity.artifact,preReview:preReviewIntegrity.comparison,
          riskAssessment:finalRiskAssessment,expectedStateVersion:current.stateVersion,
          manifestHash:manifest.manifestHash,checkpointEvidenceIds:[independentCheckpointArtifact.artifactId,
            independentCheckpointArtifact.sha256,checkpoint.checkpointHash],
          trustedEvidenceIds:trustedEvidence.map((item)=>item.evidenceId),idempotencyKey:hardeningCheckpointMilestoneKey({
            kind:"COMPLETED",runId,artifactId:independentCheckpointArtifact.artifactId,
            artifactHash:independentCheckpointArtifact.sha256,checkpointHash:checkpoint.checkpointHash,
            selectedEventId:checkpoint.selectedEventId,selectedEventSequence:checkpoint.selectedEventSequence,
            selectedEventStateVersion:checkpoint.selectedEventStateVersion,selectedEventHash:checkpoint.selectedEventHash}),
          reviewerInputCreatedAt:reviewerInput.createdAt,workerLease:this.requiredWorkerLeaseProof(runId)});
        this.assertLeaseAuthority(runId);hardeningCheckpoint=this.optionalHardeningCheckpointAuthority(
          runId,manifest.manifestHash,independentCheckpointArtifact);
        if(!hardeningCheckpoint.chain.completed)throw new HardeningGenericOperationForbiddenError();
        const durable=this.loadOptionalHardeningReviewInputAuthority({runId,manifestHash:manifest.manifestHash,
          diffHash:sha256(diff),resultCommitSha,checkpointArtifact:independentCheckpointArtifact,
          checkpointHash:hardeningCheckpoint.checkpoint.checkpointHash,
          completionEvidenceIds:hardeningCheckpoint.chain.completed.evidenceIds,safetyIdentifier});
        if(canonicalJson(durable.authority.reviewerInput)!==canonicalJson(reviewerInput))
          throw new HardeningGenericOperationForbiddenError();
        reviewerInput=durable.authority.reviewerInput;hardeningRequestAuthority=durable.authority.requestAuthority;
        this.options.afterOptionalHardeningIngressCommittedForTest?.({runId,
          authorityArtifactId:durable.artifact.artifactId});
      }else this.transition(runId,"REVIEWING","INDEPENDENT_VERIFICATION_COMPLETE",trustedEvidence.map((item)=>item.evidenceId));
    }
    const trustedEvidence=reviewerInput.trustedEvidence,reviewSessionId=reviewerInput.reviewSessionId;
    for (const evidence of trustedEvidence) {
      if (evidence.sha256 !== sha256(evidence.payload)) {
        throw new Error(`trusted Reviewer evidence ${evidence.eventType}:${evidence.evidenceId} is not canonically hash-bound`);
      }
      if (Date.parse(evidence.createdAt) > Date.parse(reviewerInput.createdAt)) {
        throw new Error(`trusted Reviewer evidence ${evidence.eventType}:${evidence.evidenceId} is future-dated`);
      }
    }
    const revalidateHardeningReviewerAuthority=()=>{
      if(!hardeningChild)return;
      if(!supervisor.isOptionalHardeningChild(runId)||!independentCheckpointArtifact||!hardeningCheckpoint)
        throw new HardeningGenericOperationForbiddenError();
      const currentCheckpoint=this.optionalHardeningCheckpointAuthority(runId,manifest.manifestHash,
        independentCheckpointArtifact);
      if(!currentCheckpoint.chain.completed||
        currentCheckpoint.checkpoint.checkpointHash!==hardeningCheckpoint.checkpoint.checkpointHash)
        throw new HardeningGenericOperationForbiddenError();
      const current=this.loadOptionalHardeningReviewInputAuthority({runId,manifestHash:manifest.manifestHash,
        diffHash:reviewerInput.diffHash,resultCommitSha,checkpointArtifact:independentCheckpointArtifact,
        checkpointHash:currentCheckpoint.checkpoint.checkpointHash,
        completionEvidenceIds:currentCheckpoint.chain.completed.evidenceIds,safetyIdentifier});
      if(canonicalJson(current.authority.reviewerInput)!==canonicalJson(reviewerInput)||
        canonicalJson(current.authority.requestAuthority)!==canonicalJson(hardeningRequestAuthority))
        throw new HardeningGenericOperationForbiddenError();
      hardeningCheckpoint=currentCheckpoint;
    };
    revalidateHardeningReviewerAuthority();
    const reviewerAgent = this.startAgent(runId, "REVIEWER", sha256(reviewerInput));
    let hardeningReviewerFence: ReturnType<EngineerSupervisor["acquireHardeningExecutionFence"]> | null = null;
    const revokeReviewerPaidFence=()=>{
      if(!hardeningReviewerFence)return;
      try{supervisor.releaseHardeningExecutionFence({childRunId:runId,ownerId:hardeningReviewerFence.ownerId,
        fenceGeneration:hardeningReviewerFence.fenceGeneration,rawFenceToken:hardeningReviewerFence.rawFenceToken,
        nowMs:(this.options.now??(()=>new Date()))().getTime()});}catch{/* expiry/recovery already revoked it */}
      hardeningReviewerFence=null;
    };
    let reviewerTransport: ResponsesTransport | undefined;
    try {
      if (hardeningChild) {
        hardeningReviewerFence = supervisor.acquireHardeningExecutionFence({
          childRunId: runId,
          ownerId: `${this.options.workerOwnerId ?? "engineer-verification-worker"}:reviewer`,
          ttlMs: 120_000,
          nowMs: (this.options.now ?? (() => new Date()))().getTime(),
          idempotencyKey: sha256({ namespace: "engineer-hardening-reviewer-fence-v1", runId,
            reviewerSessionId: reviewSessionId, inputHash: reviewerAgent.inputHash }),
        });
        this.cancellationPaidFenceRevocations.set(runId,revokeReviewerPaidFence);
        if(this.cancelling.has(runId))revokeReviewerPaidFence();
      } else {
        reviewerTransport = await this.options.transportForRole(runId, "REVIEWER");
      }
    } catch (error) {
      this.failAgent(runId, reviewerAgent);
      throw error;
    }
    const assertReviewerAuthority = () => {
      this.assertLeaseAuthority(runId);
      revalidateHardeningReviewerAuthority();
      if (hardeningReviewerFence) {
        supervisor.assertHardeningExecutionFence({
          childRunId: runId,
          ownerId: hardeningReviewerFence.ownerId,
          fenceGeneration: hardeningReviewerFence.fenceGeneration,
          rawFenceToken: hardeningReviewerFence.rawFenceToken,
          nowMs: (this.options.now ?? (() => new Date()))().getTime(),
        });
      }
    };
    const hardeningResponseReceipts=new Map<string,{modelCall:ModelCallRecord;artifactId:string}>();
    const reviewer = new IsolatedReviewer({
      signal: this.abortControllers.get(runId)?.signal,
      ...(hardeningChild
        ? { transportAfterReservation: () => this.options.transportForRole(runId, "REVIEWER") }
        : { transport: reviewerTransport! }),
      modelConfiguration: this.options.modelConfiguration,
      ...(hardeningChild ? { conservativeLocalInputAccounting: true } : {}),
      ...(hardeningChild ? { hardeningPromptCacheIdentity: {
        secret: this.options.hardeningPromptCacheSecret ?? (() => { throw new Error("hardening prompt-cache secret is unavailable"); })(),
        requesterUserId: supervisor.getRun(runId).userId,
        childRunId: runId,
      } } : {}),
      now: this.options.now,
      safetyIdentifier,
      ...(hardeningRequestAuthority?{expectedRequestAuthority:hardeningRequestAuthority}:{}),
      assertAuthority: assertReviewerAuthority,
      reserveModelCall: ({ model, inputTokenUpperBound, maxOutputTokens, attempt, requestHash, cacheDescriptor }) => {
        assertReviewerAuthority();
        if (hardeningChild) {
          this.options.afterHardeningReviewerAuthorityCheckedForTest?.("BEFORE_RESERVATION");
          assertReviewerAuthority();
          if (!hardeningReviewerFence) throw new Error("hardening Reviewer spend fence is unavailable");
          if (!cacheDescriptor) throw new Error("hardening Reviewer prompt-cache reservation authority is unavailable");
          const admission=supervisor.reserveHardeningPaidCall({
            childRunId: runId,
            role: "REVIEWER",
            modelTier: "GPT-5.6_SOL",
            resolvedModel: model,
            routingDecisionId: reviewerAgent.routingDecisionId,
            agentExecutionId: reviewerAgent.id,
            inputTokenUpperBound,
            outputTokenCeiling: maxOutputTokens,
            requestHash,
            cacheDescriptor,
            reservationIdempotencyKey: sha256({ runId, reviewSessionId, pass, attempt, purpose: "hardening-reviewer-model-call" }),
            fenceOwnerId: hardeningReviewerFence.ownerId,
            fenceGeneration: hardeningReviewerFence.fenceGeneration,
            rawFenceToken: hardeningReviewerFence.rawFenceToken,
            nowMs: (this.options.now ?? (() => new Date()))().getTime(),
          });
          try{assertReviewerAuthority();}
          catch(error){supervisor.voidHardeningPaidCallUnsent({childRunId:runId,
            reservationId:admission.reservation.reservationId,requestHash,
            clientRequestId:admission.reservation.clientRequestId,
            settlementIdempotencyKey:sha256({reservationId:admission.reservation.reservationId,outcome:"VOID_UNSENT"}),
            fenceOwnerId:hardeningReviewerFence.ownerId,fenceGeneration:hardeningReviewerFence.fenceGeneration,
            rawFenceToken:hardeningReviewerFence.rawFenceToken,nowMs:(this.options.now??(()=>new Date()))().getTime()});throw error;}
          return {reservationId:admission.reservation.reservationId,dispatchAllowed:admission.applied,
            clientRequestId:admission.reservation.clientRequestId};
        }
        return supervisor.reserveModelBudget({
          runId, reservationId: sha256({ runId, reviewSessionId, pass, attempt, purpose: "reviewer-model-call" }),
          agentExecutionId: reviewerAgent.id, model, inputTokenUpperBound, maxOutputTokens,
        });
      },
      beforeModelDispatch: hardeningChild ? ({reservationId,requestHash,clientRequestId})=>{
        if(!hardeningReviewerFence||!reservationId||!clientRequestId)throw new Error("hardening Reviewer dispatch authority is unavailable");
        assertReviewerAuthority();
        this.options.afterHardeningReviewerAuthorityCheckedForTest?.("BEFORE_DISPATCH");
        assertReviewerAuthority();
        supervisor.markHardeningPaidCallDispatching({childRunId:runId,reservationId,requestHash,clientRequestId,
          fenceOwnerId:hardeningReviewerFence.ownerId,fenceGeneration:hardeningReviewerFence.fenceGeneration,
          rawFenceToken:hardeningReviewerFence.rawFenceToken,nowMs:(this.options.now??(()=>new Date()))().getTime()});
      } : undefined,
      onModelResponseReceived: hardeningChild ? (observation)=>{
        if(!hardeningReviewerFence||!observation.reservationId||!observation.clientRequestId)
          throw new Error("hardening Reviewer response authority is unavailable");
        const hardeningUsageSafe=observation.inputTokens!==null&&observation.outputTokens!==null&&
          [observation.inputTokens,observation.outputTokens,observation.cachedInputTokens,observation.cacheWriteInputTokens]
            .every((value)=>value!==null&&Number.isSafeInteger(value)&&value>=0)&&
          observation.cachedInputTokens!+observation.cacheWriteInputTokens!<=observation.inputTokens;
        const modelCall=ModelCallRecordSchema.parse({modelCallId:this.id(),runId,agentExecutionId:reviewerAgent.id,
          logicalTier:reviewerAgent.route.logicalTier,resolvedModel:reviewerAgent.route.model,promptTemplateVersion:REVIEWER_POLICY_VERSION,
          inputContextRefs:[manifest.manifestHash,observation.dynamicInputHash,observation.requestHash,observation.clientRequestId,observation.responseId],
          outputSchemaVersion:"reviewer-output-v1",cacheKey:observation.cacheKey,
          cacheHit:hardeningUsageSafe?observation.cachedInputTokens!>0:null,latencyMs:observation.latencyMs,
          inputTokens:Number.isSafeInteger(observation.inputTokens)&&observation.inputTokens!>=0?observation.inputTokens:null,
          outputTokens:Number.isSafeInteger(observation.outputTokens)&&observation.outputTokens!>=0?observation.outputTokens:null,
          cachedInputTokens:Number.isSafeInteger(observation.cachedInputTokens)&&observation.cachedInputTokens!>=0?observation.cachedInputTokens:null,
          cacheWriteInputTokens:Number.isSafeInteger(observation.cacheWriteInputTokens)&&observation.cacheWriteInputTokens!>=0?observation.cacheWriteInputTokens:null,
          retryCount:observation.retryCount,status:"SUCCEEDED",createdAt:this.timestamp()});
        const artifact=supervisor.recordArtifact(this.options.artifactStore.put({runId,type:"MODEL_PROVIDER_RESPONSE",
          bytes:observation.providerResponseJson,producerType:"SYSTEM",producerId:"engineer-provider-response-recorder",trusted:true}));
        supervisor.recordHardeningPaidCallResponse({childRunId:runId,reservationId:observation.reservationId,
          requestHash:observation.requestHash,clientRequestId:observation.clientRequestId,modelCall,
          providerResponseId:observation.responseId,providerResponseArtifactId:artifact.artifactId,
          fenceOwnerId:hardeningReviewerFence.ownerId,fenceGeneration:hardeningReviewerFence.fenceGeneration,
          rawFenceToken:hardeningReviewerFence.rawFenceToken,nowMs:(this.options.now??(()=>new Date()))().getTime()});
        hardeningResponseReceipts.set(observation.reservationId,{modelCall,artifactId:artifact.artifactId});
      } : undefined,
      onReservedUnsentFailure: hardeningChild ? ({reservationId,requestHash,clientRequestId})=>{
        if(!hardeningReviewerFence)throw new Error("hardening Reviewer unsent authority is unavailable");
        supervisor.voidHardeningPaidCallUnsent({childRunId:runId,reservationId,requestHash,clientRequestId,
          settlementIdempotencyKey:sha256({reservationId,outcome:"VOID_UNSENT"}),fenceOwnerId:hardeningReviewerFence.ownerId,
          fenceGeneration:hardeningReviewerFence.fenceGeneration,rawFenceToken:hardeningReviewerFence.rawFenceToken,
          nowMs:(this.options.now??(()=>new Date()))().getTime()});
      } : undefined,
      authorizeModelRetry: ({ error, attempt, failedAttempt, inputHash, cacheKey, reservationId, latencyMs }) => {
        const modelCallId = this.id();
        const failedModelCall = ModelCallRecordSchema.parse({
          modelCallId, runId, agentExecutionId: reviewerAgent.id,
          logicalTier: reviewerAgent.route.logicalTier, resolvedModel: reviewerAgent.route.model,
          promptTemplateVersion: REVIEWER_POLICY_VERSION, inputContextRefs: [manifest.manifestHash, inputHash],
          outputSchemaVersion: "reviewer-output-v1", cacheKey, cacheHit: null, latencyMs,
          inputTokens: null, outputTokens: null, retryCount: failedAttempt, status: "FAILED", createdAt: this.timestamp(),
        });
        if (hardeningChild) {
          if (!hardeningReviewerFence || !reservationId) throw new Error("hardening Reviewer reservation evidence is unavailable");
          supervisor.settleHardeningPaidCall({
            childRunId: runId,
            reservationId,
            modelCall: failedModelCall,
            providerResponseId: null,
            providerResponseArtifactId: null,
            settlementIdempotencyKey: sha256({ reservationId, modelCallId, outcome: "AMBIGUOUS" }),
            fenceOwnerId: hardeningReviewerFence.ownerId,
            fenceGeneration: hardeningReviewerFence.fenceGeneration,
            rawFenceToken: hardeningReviewerFence.rawFenceToken,
            nowMs: (this.options.now ?? (() => new Date()))().getTime(),
          });
          return false;
        }
        supervisor.recordModelCall(failedModelCall, reservationId);
        return this.authorizeTransientModelRetry(runId, "REVIEWER", error, attempt);
      },
      onModelCall: (observation) => {
        const receipt=observation.reservationId?hardeningResponseReceipts.get(observation.reservationId):undefined;
        const modelCallId = receipt?.modelCall.modelCallId ?? this.id();
        const hardeningUsageSafe=!hardeningChild||(observation.inputTokens!==null&&observation.outputTokens!==null&&
          [observation.inputTokens,observation.outputTokens,observation.cachedInputTokens,observation.cacheWriteInputTokens]
            .every((value)=>value!==null&&Number.isSafeInteger(value)&&value>=0)&&
          observation.cachedInputTokens!+observation.cacheWriteInputTokens!<=observation.inputTokens);
        const modelCall = receipt?.modelCall ?? ModelCallRecordSchema.parse({
          modelCallId, runId, agentExecutionId: reviewerAgent.id,
          logicalTier: reviewerAgent.route.logicalTier, resolvedModel: reviewerAgent.route.model,
          promptTemplateVersion: REVIEWER_POLICY_VERSION,
          inputContextRefs: [manifest.manifestHash, observation.dynamicInputHash, observation.responseId], outputSchemaVersion: "reviewer-output-v1",
          cacheKey: observation.cacheKey, cacheHit: hardeningUsageSafe && observation.cachedInputTokens !== null ? observation.cachedInputTokens > 0 : null, latencyMs: observation.latencyMs,
          inputTokens: hardeningUsageSafe ? observation.inputTokens : null, outputTokens: hardeningUsageSafe ? observation.outputTokens : null,
          ...(hardeningUsageSafe?{cachedInputTokens:observation.cachedInputTokens,
            cacheWriteInputTokens:observation.cacheWriteInputTokens}:{}),
          retryCount: observation.retryCount, status: "SUCCEEDED", createdAt: this.timestamp(),
        });
        if (hardeningChild) {
          if (!hardeningReviewerFence || !observation.reservationId || !receipt) throw new Error("hardening Reviewer settlement authority is unavailable");
          supervisor.settleHardeningPaidCall({
            childRunId: runId,
            reservationId: observation.reservationId,
            modelCall,
            providerResponseId: observation.responseId,
            providerResponseArtifactId: receipt.artifactId,
            settlementIdempotencyKey: sha256({ reservationId: observation.reservationId, modelCallId, responseId: observation.responseId }),
            fenceOwnerId: hardeningReviewerFence.ownerId,
            fenceGeneration: hardeningReviewerFence.fenceGeneration,
            rawFenceToken: hardeningReviewerFence.rawFenceToken,
            nowMs: (this.options.now ?? (() => new Date()))().getTime(),
          });
        } else {
          supervisor.recordModelCall(modelCall, observation.reservationId);
        }
      },
    });
    let review;
    let reviewArtifact;
    try {
      review = await reviewer.review(reviewerInput, pass);
      this.assertLeaseAuthority(runId);
      const [reviewedCommitSha, reviewedDiff] = await Promise.all([
        workspaceManager.currentCommitAsync(sandbox.workspace),
        workspaceManager.diffAsync(sandbox.workspace),
      ]);
      if (reviewedCommitSha !== resultCommitSha || sha256(reviewedDiff) !== reviewerInput.diffHash) {
        throw new Error("workspace changed during isolated review; Reviewer decision is stale");
      }
      reviewArtifact = this.storeAgentOutput(runId, reviewerAgent, "REVIEWER_OUTPUT", review.session.output);
    } catch (error) {
      this.failAgent(runId, reviewerAgent);
      throw error;
    } finally {
      if(this.cancellationPaidFenceRevocations.get(runId)===revokeReviewerPaidFence)
        this.cancellationPaidFenceRevocations.delete(runId);
      if (hardeningReviewerFence) {
        try {
          supervisor.releaseHardeningExecutionFence({
            childRunId: runId,
            ownerId: hardeningReviewerFence.ownerId,
            fenceGeneration: hardeningReviewerFence.fenceGeneration,
            rawFenceToken: hardeningReviewerFence.rawFenceToken,
            nowMs: (this.options.now ?? (() => new Date()))().getTime(),
          });
        } catch { /* A stale/terminal main-ledger fence is already fail closed. */ }
      }
    }
    this.assertLeaseAuthority(runId);
    const rawReviewArtifact = supervisor.recordArtifact(this.options.artifactStore.put({
      runId, type: "REVIEWER_RAW_OUTPUT", bytes: review.rawOutputBytes,
      producerType: "SYSTEM", producerId: review.session.reviewerSessionId, trusted: true,
    }));
    const contract = supervisor.getRequiredLaneContract(runId, manifest.manifestHash);
    if (!contract) throw new Error("classified review requires the exact frozen Required Lane contract");
    const proposedClassification = classifyReviewerOutput({
      contract, manifest, session: review.session, findings: review.findings, trustedEvidence,
      rawOutput: {
        artifactId: rawReviewArtifact.artifactId, sha256: rawReviewArtifact.sha256,
        byteLength: rawReviewArtifact.sizeBytes, mediaType: "application/json",
      },
    });
    supervisor.recordClassifiedReviewerSession(review.session, review.findings, proposedClassification, {
      reviewerInput, rawOutputArtifact: rawReviewArtifact, provenanceConflict: false,
    });
    if(hardeningChild&&hardeningReviewerFence){
      const pending=supervisor.listPendingHardeningPaidCallFinalizations(runId).find((item)=>item.agentExecutionId===reviewerAgent.id&&item.role==="REVIEWER");
      if(!pending)throw new Error("hardening Reviewer finalization intent is unavailable");
      const idempotencyKey=sha256({finalizationId:pending.id,successor:"CLASSIFIED_REVIEW"});
      supervisor.consumeHardeningPaidCallFinalization({finalizationId:pending.id,ownerId:hardeningReviewerFence.ownerId,
        rawToken:hardeningReviewerFence.rawFenceToken,idempotencyKey,nowMs:(this.options.now??(()=>new Date()))().getTime(),
        expectedSuccessor:"SUCCESS"});
    }
    const classification = supervisor.getReviewClassification(review.session.reviewerSessionId);
    if (!classification || classification.classificationHash !== proposedClassification.classificationHash) {
      throw new Error("classified Reviewer persistence did not rehydrate the exact authoritative batch");
    }
    this.assertLeaseAuthority(runId);
    await this.options.afterClassificationPersistedForTest?.(classification);
    this.assertLeaseAuthority(runId);
    const claims = this.mapClaims(manifest, review.session.output, trustedEvidence, pass, classification.createdAt);
    for (const claim of claims) supervisor.recordClaimEvidence(claim);
    const evidenceBundle = this.bundle(
      manifest, sandbox.record, resultCommitSha, claims, review.session.reviewerSessionId,
      classification.classificationHash, classification.result, classification.createdAt, review.session.decision,
      this.classificationArtifacts(reviewerInput, classification.rawOutput.artifactId),
    );
    const durableEvidenceBundle = this.recordOrVerifyClassifiedBundle(evidenceBundle);
    this.assertLeaseAuthority(runId);
    await this.options.afterEvidenceBundlePersistedForTest?.(durableEvidenceBundle);
    this.assertLeaseAuthority(runId);

    const result = VerificationResultSchema.parse({
      runId,
      verificationExecutions: verified.executions,
      securityFindings: [
        ...verified.securityFindings,
        ...advisoryFindingRecords,
      ],
      reviewerSession: review.session,
      claims,
      evidenceBundle: durableEvidenceBundle,
    });
    return this.applyClassifiedOutcome({
      manifest, sandbox, reviewerInput, classification, session: review.session, findings: review.findings, result,
      evidenceIds: [reviewArtifact.artifactId, rawReviewArtifact.artifactId],
    });
  }

  private async applyClassifiedOutcome(input: {
    manifest: TaskManifest;
    sandbox: ProvisionedSandbox;
    reviewerInput: ReturnType<typeof ReviewerInputSchema.parse>;
    classification: ReviewClassificationBatch;
    session: ReviewerSessionRecord;
    findings: ReviewFindingRecord[];
    result: VerificationResult;
    evidenceIds: string[];
    recoveryOnly?: boolean;
  }): Promise<VerificationResult> {
    const { manifest, sandbox, reviewerInput, classification, session, findings, result } = input;
    const runId = manifest.runId;
    const authorityIds = [session.reviewerSessionId, classification.classificationHash,
      result.evidenceBundle.evidenceBundleId, ...input.evidenceIds];
    const hardeningChild = this.options.supervisor.isOptionalHardeningChild?.(runId) === true;
    if (hardeningChild && classification.result !== "READY" && classification.result !== "READY_WITH_ADVISORIES") {
      if (this.options.supervisor.getRun(runId).state === "REVIEWING") {
        this.transition(runId, "HUMAN_REVIEW_REQUIRED", "HARDENING_REVIEW_NOT_READY", authorityIds);
      }
      this.options.supervisor.recordOptionalHardeningStopped(runId,
        classification.result === "BLOCKED" ? "SECURITY_BLOCKED" : "FAILED");
      return result;
    }
    switch (classification.result) {
      case "READY":
      case "READY_WITH_ADVISORIES": { // The only classified outcomes authorized to cross the signed C2 boundary.
        const attestor = this.options.checkpointAttestor;
        if (!attestor) {
          throw new Error("verified-candidate checkpoint attestor is required for REVIEW_APPROVED");
        }
        const expectedStateVersion = this.options.supervisor.getRun(runId).stateVersion;
        this.assertLeaseAuthority(runId);
        const promotion = {
          runId,
          reviewerSessionId: session.reviewerSessionId,
          classificationHash: classification.classificationHash,
          evidenceBundleId: result.evidenceBundle.evidenceBundleId,
          attestor,
        };
        if (this.options.supervisor.isOptionalHardeningChild?.(runId) === true) {
          await this.options.supervisor.promoteVerifiedHardeningCandidate(promotion, expectedStateVersion);
        } else {
          await this.options.supervisor.promoteVerifiedCandidate(promotion, expectedStateVersion);
        }
        return result;
      }
      case "HUMAN_REVIEW_REQUIRED":
        this.transition(runId, "HUMAN_REVIEW_REQUIRED", "CLASSIFIED_REVIEW_REQUIRES_HUMAN", authorityIds);
        return result;
      case "REPAIR_REQUIRED":
        // Missing deterministic test evidence is re-verification work, not a
        // code change. A concrete in-scope Reviewer repair candidate follows
        // the bounded repair path below instead.
        if (!classification.classifications.some((item) => item.reasonCode === "IN_SCOPE_REVIEWER_REPAIR_CANDIDATE")) {
          this.transition(runId, "VERIFICATION_RECOVERY", "CLASSIFIED_REQUIRED_TEST_EVIDENCE_MISSING", authorityIds);
          return result;
        }
        break;
      case "BLOCKED":
        break;
      default: {
        const exhaustive: never = classification.result;
        throw new Error(`unsupported classified outcome: ${String(exhaustive)}`);
      }
    }
    const repairableIds = new Set(classification.classifications
      .filter((item) => item.disposition === "BLOCKING" || item.reasonCode === "IN_SCOPE_REVIEWER_REPAIR_CANDIDATE")
      .map((item) => item.findingId));
    const repairableFindings = findings.filter((finding) => repairableIds.has(finding.findingId));
    if (repairableFindings.length === 0) {
      this.transition(runId, "HUMAN_REVIEW_REQUIRED", "CLASSIFIED_REPAIR_REQUIRES_HUMAN", authorityIds);
      return result;
    }
    if (this.options.supervisor.getRun(runId).state === "REVIEWING") {
      this.transition(runId, "REVIEW_CHANGES_REQUESTED", "CLASSIFIED_REVIEW_REPAIR_REQUIRED", authorityIds, {
        reviewerFindingsActionable: true,
      });
    }
    if (input.recoveryOnly) return result;
    const retry = this.options.supervisor.authorizeRetry({
      runId,
      expectedStateVersion: this.options.supervisor.getRun(runId).stateVersion,
      kind: "REVIEWER_FIX",
      failureFingerprint: sha256({
        policyVersion: classification.policyVersion, contractHash: classification.contractHash,
        // Keep the durable retry identity stable for existing deterministic
        // blockers; repair candidates merely join the same bounded lane.
        blockingFingerprints: repairableFindings.map((finding) => finding.fingerprint).sort(),
      }),
      patchHash: reviewerInput.diffHash,
      progressMetric: -repairableFindings.length,
    });
    if (!retry.allowed) {
      this.transition(runId, "HUMAN_REVIEW_REQUIRED", "CLASSIFIED_REPAIR_BUDGET_REQUIRED", authorityIds);
      return result;
    }
    const classificationAuthority = [session.reviewerSessionId, classification.classificationHash];
    const blockingRawFindings = session.output.findings.filter((finding) =>
      repairableFindings.some((record) => record.findingId === sha256({
        namespace: "review-finding-record-v1", reviewerSessionId: session.reviewerSessionId,
        providerFindingId: finding.findingId,
      })));
    const repairContext = RepairContextSchema.parse({
      runId, manifestHash: manifest.manifestHash, manifest,
      reviewFindings: blockingRawFindings,
      reviewFindingsHash: sha256(blockingRawFindings),
      currentCommitSha: reviewerInput.resultCommitSha,
      allowedPaths: manifest.allowedPaths,
      remainingReviewFixAttempts: retry.remainingKindAttempts,
    });
    const storedContext = this.options.artifactStore.put({
      runId, type: "CLASSIFIED_REVIEW_REPAIR_CONTEXT", bytes: canonicalJson(repairContext),
      producerType: "SYSTEM", producerId: "engineer-verification", trusted: true,
    });
    const contextArtifact = this.options.supervisor.recordArtifact(ArtifactRecordSchema.parse({
      ...storedContext,
      artifactId: sha256({ namespace: "classified-review-repair-context-v1", runId, classificationHash: classification.classificationHash }),
      createdAt: classification.createdAt,
    }));
    const repairEvidenceIds = [...authorityIds, contextArtifact.artifactId];
    if (this.options.supervisor.getRun(runId).state === "REVIEW_CHANGES_REQUESTED") {
      this.transition(runId, "REVIEW_FIX_PREPARING", "REVIEW_REPAIR_CONTEXT_PREPARING", repairEvidenceIds, {
        retryBudgetAvailable: true, scopeWithinManifest: true,
      });
    }
    if (this.options.supervisor.getRun(runId).state === "REVIEW_FIX_PREPARING") {
      this.transition(runId, "IMPLEMENTING", "REVIEW_REPAIR_STARTED", repairEvidenceIds, { scopeWithinManifest: true });
    }
    await this.repair(manifest, sandbox, repairContext, "REVIEW_REPAIR_IMPLEMENTED", classificationAuthority);
    return this.verifyPass(runId);
  }

  private async repairStableRequiredTest(
    manifest: TaskManifest,
    sandbox: ProvisionedSandbox,
    currentCommitSha: string,
    diff: string,
    failure: StableRequiredTestFailure,
  ): Promise<VerificationResult> {
    const runId = manifest.runId;
    const supervisor = this.options.supervisor;
    const evidenceIds = failure.evidence.map((item) => item.evidenceId);
    const retry = supervisor.authorizeRetry({
      runId,
      expectedStateVersion: supervisor.getRun(runId).stateVersion,
      kind: "BUILDER_REPAIR",
      failureFingerprint: failure.failureFingerprint,
      patchHash: sha256(diff),
    });
    supervisor.recordFailure(FailureRecordSchema.parse({
      failureId: this.id(),
      runId,
      failureClass: "TEST_FAILURE",
      reasonCode: "STABLE_REQUIRED_TEST_FAILED",
      fingerprint: failure.failureFingerprint,
      evidenceIds,
      retryable: retry.allowed,
      createdAt: this.timestamp(),
    }));
    if (!retry.allowed) {
      this.transition(runId, "RETRY_BUDGET_EXHAUSTED", retry.reasonCode, evidenceIds);
      throw new Error(`Builder repair denied for ${failure.test.testId}: ${retry.reasonCode}`);
    }
    const reviewFindings = [{
      findingId: `verification-${failure.test.testId}-${retry.attemptNumber}`,
      severity: "HIGH" as const,
      category: "REQUIRED_TEST_FAILURE",
      file: "",
      lineStart: 0,
      lineEnd: 0,
      criterionIds: failure.requiredCriterionIds,
      description: `Frozen required test ${failure.test.testId} failed independently in three comparable executions.`,
      requiredChange: `Repair the implementation within frozen scope so ${failure.test.command ?? failure.test.testId} passes. Do not weaken, remove, or skip the test.`,
      evidenceIds,
    }];
    const artifactsById = new Map(supervisor.listArtifacts(runId).map((artifact) => [artifact.artifactId, artifact]));
    const stderrArtifactIds = failure.evidence.flatMap((evidence) => {
      const candidate = evidence.payload.stderrArtifact;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const artifactId = (candidate as Record<string, unknown>).artifactId;
      return typeof artifactId === "string" ? [artifactId] : [];
    });
    const diagnosticParts = stderrArtifactIds.flatMap((artifactId) => {
      const artifact = artifactsById.get(artifactId);
      if (!artifact) return [];
      try {
        const value = boundedRepairDiagnostic(this.options.artifactStore.read(artifact).toString("utf8").trim());
        return value ? [value] : [];
      } catch {
        // Evidence remains authoritative even when an optional prompt summary
        // cannot be read. A missing hint must never weaken the verification gate.
        return [];
      }
    });
    const uniqueDiagnosticParts = [...new Set(diagnosticParts)];
    // Each individual artifact is bounded, but up to three independently
    // observed failures can be joined here. Bound the assembled value too;
    // otherwise valid verbose diagnostics can violate RepairContextSchema and
    // terminate verification before the Builder sees the repair context.
    const diagnosticSummary = boundedRepairDiagnostic(uniqueDiagnosticParts.join("\n\n--- repeated independent execution ---\n\n"));
    const repairContext = RepairContextSchema.parse({
      runId,
      manifestHash: manifest.manifestHash,
      manifest,
      reviewFindings,
      reviewFindingsHash: sha256(reviewFindings),
      currentCommitSha,
      allowedPaths: manifest.allowedPaths,
      remainingReviewFixAttempts: retry.remainingKindAttempts,
      ...(diagnosticSummary ? {
        repairDiagnostics: [{
          testId: failure.test.testId,
          command: failure.test.command ?? failure.test.testId,
          summary: diagnosticSummary,
          evidenceIds,
        }],
      } : {}),
    });
    const repairContextArtifact = supervisor.recordArtifact(this.options.artifactStore.put({
      runId,
      type: "STABLE_REQUIRED_TEST_REPAIR_CONTEXT",
      bytes: JSON.stringify(repairContext),
      producerType: "SYSTEM",
      producerId: "engineer-verification",
      trusted: true,
    }));
    this.transition(runId, "IMPLEMENTING", "STABLE_REQUIRED_TEST_REPAIR_STARTED", [...evidenceIds, repairContextArtifact.artifactId], {
      retryBudgetAvailable: true,
      scopeWithinManifest: true,
    });
    await this.repair(manifest, sandbox, repairContext, "STABLE_REQUIRED_TEST_REPAIR_IMPLEMENTED");
    return this.verifyPass(runId);
  }

  private async repair(
    manifest: TaskManifest,
    sandbox: ProvisionedSandbox,
    repairContext: ReturnType<typeof RepairContextSchema.parse>,
    completionReason: "REVIEW_REPAIR_IMPLEMENTED" | "STABLE_REQUIRED_TEST_REPAIR_IMPLEMENTED",
    authorityEvidenceIds: string[] = [],
  ): Promise<void> {
    const runId = manifest.runId;
    const repairContextHash = sha256(repairContext);
    const builderInputHash = this.builderRepairInputHash(manifest, repairContext, completionReason, authorityEvidenceIds);
    const executor = this.executor(manifest, sandbox);
    const testIntegrity = TestIntegrityGuard.load({
      supervisor: this.options.supervisor,
      artifactStore: this.options.artifactStore,
      manifest,
      workspace: sandbox.workspace,
      now: this.options.now,
    });
    const priorExecutions = this.options.supervisor.builderRepairExecutions(runId, builderInputHash);
    const succeeded = priorExecutions.filter((candidate) => candidate.status === "SUCCEEDED");
    if (succeeded.length === 1 && priorExecutions.length === 1) {
      this.recoverSucceededBuilderRepair(manifest, testIntegrity, succeeded[0]!, completionReason, authorityEvidenceIds);
      return;
    }
    if (priorExecutions.length > 0) {
      const now = this.timestamp();
      this.options.supervisor.finalizeRunningAgentExecutions(runId, "FAILED", "BUILDER_PROVIDER_OUTCOME_AMBIGUOUS", now);
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: this.id(), runId, failureClass: "MODEL_FAILURE",
        reasonCode: "BUILDER_PROVIDER_OUTCOME_AMBIGUOUS",
        fingerprint: sha256({ builderInputHash, reasonCode: "BUILDER_PROVIDER_OUTCOME_AMBIGUOUS" }),
        evidenceIds: [...authorityEvidenceIds], retryable: true, createdAt: now,
      }));
      const current = this.options.supervisor.getRun(runId);
      if (canTransition(current.state, "MODEL_PROVIDER_RETRY_PENDING")) {
        this.transition(runId, "MODEL_PROVIDER_RETRY_PENDING", "BUILDER_PROVIDER_OUTCOME_AMBIGUOUS", authorityEvidenceIds);
      }
      throw new BuilderRecoveryPausedError(runId);
    }
    await this.options.beforeBuilderDispatchForTest?.({ runId, inputHash: builderInputHash });
    const claimed = this.claimBuilderAgent(runId, builderInputHash);
    if (!claimed.won) {
      if (claimed.agentRecord.status === "SUCCEEDED") {
        this.recoverSucceededBuilderRepair(manifest, testIntegrity, claimed.agentRecord, completionReason, authorityEvidenceIds);
        return;
      }
      if (claimed.agentRecord.status === "FAILED" || claimed.agentRecord.status === "PAUSED") {
        const current = this.options.supervisor.getRun(runId);
        if (canTransition(current.state, "MODEL_PROVIDER_RETRY_PENDING")) {
          this.transition(runId, "MODEL_PROVIDER_RETRY_PENDING", "BUILDER_PROVIDER_OUTCOME_AMBIGUOUS", authorityEvidenceIds);
        }
        throw new BuilderRecoveryPausedError(runId);
      }
      // The winner owns the in-flight dispatch. The loser performs no state
      // mutation and cannot create routing, reservations, or provider calls.
      throw new BuilderDispatchClaimLostError(runId);
    }
    const agent = claimed.agent;
    await this.options.afterBuilderClaimPersistedForTest?.({ runId, inputHash: builderInputHash, agentExecutionId: agent.id });
    // A lease can be revoked while this process waits for the database write
    // lock. Recheck after winning the durable claim and before any route,
    // reservation, or provider call.
    this.assertLeaseAuthority(runId);
    this.recordAgentRouting(runId, agent);
    this.options.afterBuilderDispatchRecordedForTest?.({ runId, inputHash: builderInputHash, agentExecutionId: agent.id });
    let transport;
    try {
      transport = await this.options.transportForRole(runId, "BUILDER");
      await this.options.afterBuilderTransportAcquiredForTest?.({ runId, inputHash: builderInputHash, agentExecutionId: agent.id });
    } catch (error) {
      if (isWorkerAuthorityLoss(error, this.abortControllers.get(runId)?.signal)) throw error;
      this.failAgent(runId, agent);
      throw error;
    }
    const continuation = this.options.supervisor.listArtifacts(runId)
      .filter((artifact) => artifact.type === "BUILDER_REPAIR_CONTINUATION" && artifact.trusted &&
        artifact.producerType === "SYSTEM" && artifact.producerId === "engineer-builder-checkpoint")
      .reverse()
      .flatMap((artifact) => {
        try {
          const parsed = BuilderContinuationSchema.parse(
            JSON.parse(this.options.artifactStore.read(artifact).toString("utf8")),
          );
          return parsed.manifestHash === manifest.manifestHash &&
            parsed.inputContextHash === repairContextHash ? [parsed] : [];
        } catch { return []; }
      })[0];
    const builder = new CodexBuilder({
      transport,
      manifest,
      workspace: sandbox.workspace,
      workspaceManager: this.options.sandboxManager.workspaceManager(),
      executor,
      modelConfiguration: this.options.modelConfiguration,
      repairContext,
      ...(continuation ? { continuation } : {}),
      onContinuation: (checkpoint) => {
        this.options.supervisor.recordArtifact(this.options.artifactStore.put({
          runId,
          type: "BUILDER_REPAIR_CONTINUATION",
          bytes: JSON.stringify(checkpoint),
          producerType: "SYSTEM",
          producerId: "engineer-builder-checkpoint",
          trusted: true,
        }));
      },
      now: this.options.now,
      safetyIdentifier: this.options.safetyIdentifierForUser?.(this.options.supervisor.getRun(runId).userId),
      assertAuthority: () => this.assertLeaseAuthority(runId),
      reserveModelCall: ({ model, inputTokenUpperBound, maxOutputTokens, round, attempt }) => {
        this.assertLeaseAuthority(runId);
        return this.options.supervisor.reserveModelBudget({
          runId, reservationId: sha256({ runId, agentExecutionId: agent.id, round, attempt, purpose: "repair-model-call" }),
          agentExecutionId: agent.id,
          model, inputTokenUpperBound, maxOutputTokens,
        });
      },
      afterModelReservationForTest: ({ reservationId }) => this.options.afterBuilderReservationForTest?.({
        runId, inputHash: builderInputHash, agentExecutionId: agent.id, reservationId,
      }),
      authorizeModelRetry: ({ error, attempt, failedAttempt, inputHash, cacheKey, reservationId, latencyMs }) => {
        const message = error instanceof Error ? error.message : String(error);
        const current = this.options.supervisor.getRun(runId);
        this.options.supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: agent.id,
          logicalTier: agent.route.logicalTier, resolvedModel: agent.route.model,
          promptTemplateVersion: CODEX_BUILDER_PROMPT_VERSION,
          inputContextRefs: [manifest.manifestHash, inputHash], outputSchemaVersion: null,
          cacheKey, cacheHit: null, latencyMs, inputTokens: null, outputTokens: null,
          retryCount: failedAttempt, status: "FAILED", createdAt: this.timestamp(),
        }, reservationId);
        const retry = this.options.supervisor.authorizeRetry({
          runId, expectedStateVersion: current.stateVersion, kind: "TRANSIENT_MODEL",
          failureFingerprint: sha256({ role: "BUILDER", message }), patchHash: null, progressMetric: attempt,
        });
        if (!retry.allowed && canTransition(current.state, "RETRY_BUDGET_EXHAUSTED")) {
          this.transition(runId, "RETRY_BUDGET_EXHAUSTED", retry.reasonCode);
        }
        return retry.allowed;
      },
      onModelCall: (observation) => {
        this.options.supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: agent.id,
          logicalTier: agent.route.logicalTier, resolvedModel: agent.route.model,
          promptTemplateVersion: CODEX_BUILDER_PROMPT_VERSION,
          inputContextRefs: [manifest.manifestHash, repairContext.reviewFindingsHash, observation.inputHash],
          outputSchemaVersion: null, cacheKey: observation.cacheKey, cacheHit: observation.cachedInputTokens === null ? null : observation.cachedInputTokens > 0,
          latencyMs: observation.latencyMs, inputTokens: observation.inputTokens, outputTokens: observation.outputTokens,
          cachedInputTokens: observation.cachedInputTokens, cacheWriteInputTokens: observation.cacheWriteInputTokens,
          retryCount: observation.retryCount, status: "SUCCEEDED", createdAt: this.timestamp(),
        }, observation.reservationId);
        this.options.afterBuilderModelCallPersistedForTest?.({ runId, inputHash: builderInputHash, agentExecutionId: agent.id });
      },
    });
    try {
      const builderResult = await builder.run();
      const artifact = this.storeAgentOutput(runId, agent, "BUILDER_REPAIR_RESULT", builderResult);
      this.options.afterBuilderResultPersistedForTest?.({ runId, inputHash: builderInputHash, artifactId: artifact.artifactId });
      const integrity = testIntegrity.attest("POST_REPAIR");
      this.transition(runId, "FAST_CHECKS", completionReason, [...authorityEvidenceIds, artifact.artifactId, integrity.artifact.artifactId]);
    } catch (error) {
      if (isWorkerAuthorityLoss(error, this.abortControllers.get(runId)?.signal)) throw error;
      // A process fault after the durable result write must not downgrade the
      // SUCCEEDED dispatch fence to FAILED. Recovery can safely consume that
      // exact output without another provider call.
      const durable = this.options.supervisor.builderRepairExecutions(runId, builderInputHash)
        .find((candidate) => candidate.agentExecutionId === agent.id);
      if (durable?.status !== "SUCCEEDED") this.failAgent(runId, agent);
      throw error;
    }
  }

  private executor(manifest: TaskManifest, sandbox: ProvisionedSandbox): TrustedCommandExecutor {
    return new TrustedCommandExecutor({
      artifactStore: this.options.artifactStore,
      workspace: sandbox.workspace,
      sandbox: sandbox.record,
      manifest,
      runner: sandbox.commandRunner,
      ...(sandbox.commandRunnerAsync ? { runnerAsync: sandbox.commandRunnerAsync } : {}),
      currentCommit: () => this.options.sandboxManager.currentCommit(sandbox.workspace),
      currentCommitAsync: () => this.options.sandboxManager.currentCommitAsync(sandbox.workspace),
      onRecord: (record) => this.options.supervisor.recordCommandExecution(record),
      now: this.options.now,
      idFactory: this.options.idFactory,
      signal: this.abortControllers.get(manifest.runId)?.signal,
    });
  }

  private async recordLunaFailureAdvisory(
    manifest: TaskManifest,
    failure: IndependentVerificationFailure,
  ): Promise<void> {
    const transportFactory = this.options.transportForFailureClassifier;
    if (!transportFactory) return;
    const runId = manifest.runId;
    const input = {
      runId,
      manifestHash: manifest.manifestHash,
      failureClass: failure.failureClass,
      reasonCode: failure.reasonCode,
      evidenceIds: failure.evidenceIds,
      details: failure.details,
    };
    const agent = this.startAgent(runId, "FAILURE_CLASSIFIER", sha256(input));
    try {
      const transport = await transportFactory(runId);
      const advisor = new LunaFailureAdvisor({
        transport,
        modelConfiguration: this.options.modelConfiguration,
        safetyIdentifier: this.options.safetyIdentifierForUser?.(this.options.supervisor.getRun(runId).userId),
        reserveModelCall: ({ model, inputTokenUpperBound, maxOutputTokens }) => this.options.supervisor.reserveModelBudget({
          runId,
          reservationId: sha256({ runId, agentExecutionId: agent.id, reasonCode: failure.reasonCode, purpose: "luna-failure-advisory" }),
          agentExecutionId: agent.id,
          model,
          inputTokenUpperBound,
          maxOutputTokens,
        }),
        onModelCall: (observation) => this.options.supervisor.recordModelCall({
          modelCallId: this.id(), runId, agentExecutionId: agent.id,
          logicalTier: agent.route.logicalTier, resolvedModel: agent.route.model,
          promptTemplateVersion: LUNA_FAILURE_ADVISOR_POLICY_VERSION,
          inputContextRefs: [manifest.manifestHash, observation.inputHash], outputSchemaVersion: "luna-failure-advisory-v1",
          cacheKey: observation.cacheKey, cacheHit: observation.cachedInputTokens === null ? null : observation.cachedInputTokens > 0, latencyMs: observation.latencyMs,
          inputTokens: observation.inputTokens, outputTokens: observation.outputTokens,
          cachedInputTokens: observation.cachedInputTokens, cacheWriteInputTokens: observation.cacheWriteInputTokens,
          retryCount: 0, status: "SUCCEEDED", createdAt: this.timestamp(),
        }, observation.reservationId),
      });
      const advisory = await advisor.advise(input);
      this.storeAgentOutput(runId, agent, "LUNA_FAILURE_ADVISORY", advisory);
    } catch (error) {
      this.failAgent(runId, agent);
      throw error;
    }
  }

  private async recoverInterruptedVerification(runId: string): Promise<VerificationResult> {
    const initial = this.options.supervisor.getRun(runId);
    this.options.supervisor.finalizeRunningAgentExecutions(
      runId,
      "FAILED",
      "VERIFICATION_PROCESS_INTERRUPTED",
      this.timestamp(),
    );
    const sandbox = await this.options.executionManager.recoverSandbox(
      runId, !this.options.supervisor.isOptionalHardeningChild(runId), () => this.assertLeaseAuthority(runId),
    );
    this.assertLeaseAuthority(runId);
    const repairCheckpoint = this.latestRepairCheckpoint(runId);
    if (repairCheckpoint?.reasonCode === "REVIEW_REPAIR_STARTED" ||
        repairCheckpoint?.reasonCode === "REVIEW_REPAIR_CONTEXT_PREPARING") {
      this.transition(runId, "HUMAN_REVIEW_REQUIRED", "CLASSIFIED_REPAIR_INTERRUPTED_REQUIRES_HUMAN", repairCheckpoint.evidenceIds);
      throw new Error("interrupted Reviewer repair cannot resume from raw output; human review is required");
    }
    if (repairCheckpoint?.reasonCode === "STABLE_REQUIRED_TEST_REPAIR_STARTED") {
      return this.recoverInterruptedStableRequiredTestRepair(runId, sandbox, repairCheckpoint);
    }
    if (this.hasIndependentVerificationCheckpoint(runId)) {
      if(this.options.supervisor.isOptionalHardeningChild(runId)){
        const manifest=this.options.supervisor.getManifest(runId);if(!manifest)throw new HardeningGenericOperationForbiddenError();
        let authority=this.optionalHardeningCheckpointAuthority(runId,manifest.manifestHash);
        if(authority.chain.completed){
          if(this.options.supervisor.getRun(runId).state!=="REVIEWING")throw new HardeningGenericOperationForbiddenError();
          return this.verifyPass(runId);
        }
        if(!authority.chain.opened){
          this.transitionHardeningCheckpointMilestone(runId,"OPENED","VERIFICATION_RECOVERY","PHASE3_PROCESS_INTERRUPTED",
            authority.artifact,authority.checkpoint);
          authority=this.optionalHardeningCheckpointAuthority(runId,manifest.manifestHash,authority.artifact);
        }
        if(!authority.chain.resumed){
          this.transitionHardeningCheckpointMilestone(runId,"RESUMED","SECURITY_REVIEW","INDEPENDENT_VERIFICATION_CHECKPOINT_RESUMED",
            authority.artifact,authority.checkpoint);
        }
      }else{
        const current=this.options.supervisor.getRun(runId);
        if(current.state!=="VERIFICATION_RECOVERY")
          this.transition(runId,"VERIFICATION_RECOVERY","PHASE3_PROCESS_INTERRUPTED",[sandbox.record.sandboxId]);
        this.transition(runId,"SECURITY_REVIEW","INDEPENDENT_VERIFICATION_CHECKPOINT_RESUMED",[sandbox.record.sandboxId]);
      }
      return this.verifyPass(runId);
    }
    if (initial.state !== "VERIFICATION_RECOVERY") {
      this.transition(runId, "VERIFICATION_RECOVERY", "PHASE3_PROCESS_INTERRUPTED", [sandbox.record.sandboxId]);
    }
    this.transition(runId, "FAST_CHECKS", "PHASE3_RECOVERY_RESTARTED", [sandbox.record.sandboxId]);
    return this.verifyPass(runId);
  }

  private latestRepairCheckpoint(runId: string): RunStateEvent | undefined {
    const sequence = this.options.supervisor.latestEventSequence(runId);
    if (sequence === 0) return undefined;
    const events = this.options.supervisor.listEvents(runId, Math.max(0, sequence - 100), 100).reverse();
    return events.find((event) =>
      event.nextState !== "PAUSED_BUDGET" && event.reasonCode !== "BUDGET_RESUMED",
    );
  }

  private builderRepairInputHash(
    manifest: TaskManifest,
    repairContext: ReturnType<typeof RepairContextSchema.parse>,
    completionReason: "REVIEW_REPAIR_IMPLEMENTED" | "STABLE_REQUIRED_TEST_REPAIR_IMPLEMENTED",
    authorityEvidenceIds: string[],
  ): string {
    return sha256({
      namespace: "builder-repair-dispatch-v1",
      runId: manifest.runId,
      manifestHash: manifest.manifestHash,
      repairContextHash: sha256(repairContext),
      completionReason,
      authorityEvidenceIds: [...authorityEvidenceIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    });
  }

  private expectedBuilderRepairInputHash(runId: string): string | null {
    const checkpoint = this.latestRepairCheckpoint(runId);
    if (!checkpoint || !["REVIEW_REPAIR_STARTED", "STABLE_REQUIRED_TEST_REPAIR_STARTED"].includes(checkpoint.reasonCode)) return null;
    const manifest = this.options.supervisor.getManifest(runId);
    if (!manifest) return null;
    const expectedType = checkpoint.reasonCode === "REVIEW_REPAIR_STARTED"
      ? "CLASSIFIED_REVIEW_REPAIR_CONTEXT" : "STABLE_REQUIRED_TEST_REPAIR_CONTEXT";
    const records = new Map(this.options.supervisor.listArtifacts(runId).map((artifact) => [artifact.artifactId, artifact]));
    const artifact = checkpoint.evidenceIds.map((id) => records.get(id)).find((candidate) => candidate?.type === expectedType);
    if (!artifact || !artifact.trusted || artifact.producerType !== "SYSTEM" || artifact.producerId !== "engineer-verification") return null;
    try {
      const context = RepairContextSchema.parse(JSON.parse(this.options.artifactStore.read(artifact).toString("utf8")));
      if (context.runId !== runId || context.manifestHash !== manifest.manifestHash) return null;
      if (checkpoint.reasonCode === "REVIEW_REPAIR_STARTED") {
        const authority = this.options.supervisor.latestClassifiedReview(runId);
        if (!authority) return null;
        return this.builderRepairInputHash(manifest, context, "REVIEW_REPAIR_IMPLEMENTED",
          [authority.session.reviewerSessionId, authority.classification.classificationHash]);
      }
      return this.builderRepairInputHash(manifest, context, "STABLE_REQUIRED_TEST_REPAIR_IMPLEMENTED", []);
    } catch { return null; }
  }

  private async recoverInterruptedStableRequiredTestRepair(
    runId: string,
    sandbox: ProvisionedSandbox,
    checkpoint: RunStateEvent,
  ): Promise<VerificationResult> {
    const supervisor = this.options.supervisor;
    const manifest = supervisor.getManifest(runId);
    if (!manifest) throw new Error("frozen manifest is unavailable for stable required-test repair recovery");
    const artifacts = supervisor.listArtifacts(runId);
    const artifact = checkpoint.evidenceIds
      .map((artifactId) => artifacts.find((item) => item.artifactId === artifactId))
      .find((item) => item?.type === "STABLE_REQUIRED_TEST_REPAIR_CONTEXT");
    if (!artifact || !artifact.trusted || artifact.producerType !== "SYSTEM" || artifact.producerId !== "engineer-verification") {
      throw new Error("stable required-test repair recovery requires its trusted repair context artifact");
    }
    const repairContext = RepairContextSchema.parse(
      JSON.parse(this.options.artifactStore.read(artifact).toString("utf8")),
    );
    if (repairContext.runId !== runId || repairContext.manifestHash !== manifest.manifestHash ||
        repairContext.manifest.manifestHash !== manifest.manifestHash) {
      throw new Error("stable required-test repair recovery context is stale or belongs to another run");
    }
    const current = supervisor.getRun(runId);
    if (current.state !== "IMPLEMENTING") {
      throw new Error(`stable required-test repair recovery requires IMPLEMENTING, not ${current.state}`);
    }
    await this.repair(manifest, sandbox, repairContext, "STABLE_REQUIRED_TEST_REPAIR_IMPLEMENTED");
    return this.verifyPass(runId);
  }

  private isInterruptedPhase3Repair(runId: string): boolean {
    const latest = this.latestRepairCheckpoint(runId);
    return latest?.nextState === "IMPLEMENTING"
      && ["REVIEW_REPAIR_STARTED", "STABLE_REQUIRED_TEST_REPAIR_STARTED"].includes(latest.reasonCode);
  }

  private optionalHardeningCheckpointAuthority(runId:string,manifestHash:string,artifact?:ArtifactRecord){
    const raw=this.options.supervisor.listArtifacts(runId).filter((item)=>item.type==="INDEPENDENT_VERIFICATION_CHECKPOINT");
    if(raw.length!==1)throw new HardeningGenericOperationForbiddenError();
    const selected=artifact??raw[0]!;
    if(selected.artifactId!==raw[0]!.artifactId||selected.sha256!==raw[0]!.sha256||!selected.trusted||
      selected.producerType!=="SYSTEM"||selected.producerId!=="engineer-verification")
      throw new HardeningGenericOperationForbiddenError();
    try{
      const bytes=this.options.artifactStore.readVerifiedExact(selected),text=new TextDecoder("utf-8",{fatal:true}).decode(bytes),
        checkpoint=OptionalHardeningIndependentCheckpointSchema.parse(JSON.parse(text));
      if(text!==canonicalJson(checkpoint))throw new Error("optional-hardening checkpoint is not canonical");
      resolveHardeningArtifactAuthority({authority:checkpoint.verified.securityReportArtifact,
        artifacts:this.options.supervisor.listArtifacts(runId),readArtifact:(candidate)=>
          this.options.artifactStore.readVerifiedExact(candidate)});
      const chain=validateOptionalHardeningCheckpointChain({checkpoint,artifact:selected,
        events:this.options.supervisor.listEvents(runId),manifestHash});
      return {checkpoint,artifact:selected,chain};
    }catch(error){if(error instanceof HardeningGenericOperationForbiddenError)throw error;
      throw new HardeningGenericOperationForbiddenError();}
  }

  private prepareOptionalHardeningReviewInputAuthority(input:{runId:string;manifestHash:string;diffHash:string;
    resultCommitSha:string;checkpointArtifact:ArtifactRecord;checkpointHash:string;
    reviewerInput:ReturnType<typeof ReviewerInputSchema.parse>;pendingArtifacts?:readonly ArtifactRecord[];
    pendingSemanticRows?:readonly HardeningPendingSemanticRow[];createdAt?:string;safetyIdentifier?:string}):ArtifactRecord{
    const artifacts=[...this.options.supervisor.listArtifacts(input.runId),...(input.pendingArtifacts??[])],
      runRecords=this.options.supervisor.exportRunRecords(input.runId),
      readArtifact=(artifact:ArtifactRecord)=>this.options.artifactStore.readVerifiedExact(artifact),
      evidenceAuthority=resolveHardeningReviewerEvidenceAuthority({reviewerInput:input.reviewerInput,artifacts,runRecords,
        readArtifact}),semanticAuthority=resolveHardeningReviewerSemanticAuthority({reviewerInput:input.reviewerInput,
        artifacts,runRecords,pendingRows:input.pendingSemanticRows,readArtifact}),requestAuthority=buildIsolatedReviewerRequestPlan(
        input.reviewerInput,{modelConfiguration:this.options.modelConfiguration,safetyIdentifier:input.safetyIdentifier,
          hardeningPromptCacheIdentity:{secret:this.options.hardeningPromptCacheSecret??(()=>{
            throw new HardeningPromptCacheAuthorityUnavailableError();})(),
          requesterUserId:this.options.supervisor.getRun(input.runId).userId,childRunId:input.runId}}).authority;
    const content={version:2 as const,policyVersion:"engineer-hardening-review-input-authority-v2" as const,
      runId:input.runId,manifestHash:input.manifestHash,diffHash:input.diffHash,resultCommitSha:input.resultCommitSha,
      checkpointArtifactId:input.checkpointArtifact.artifactId,checkpointArtifactHash:input.checkpointArtifact.sha256,
      checkpointHash:input.checkpointHash,reviewerInput:input.reviewerInput,evidenceAuthority,
      evidenceAuthorityHash:sha256(evidenceAuthority),semanticAuthority,requestAuthority};
    const payload=OptionalHardeningReviewInputAuthoritySchema.parse({...content,authorityHash:sha256(content)}),
      bytes=canonicalJson(payload),existing=this.options.supervisor.listArtifacts(input.runId)
        .filter((artifact)=>artifact.type==="HARDENING_REVIEW_INPUT_AUTHORITY");
    if(existing.length)throw new HardeningGenericOperationForbiddenError();
    const pending=this.options.artifactStore.put({runId:input.runId,type:"HARDENING_REVIEW_INPUT_AUTHORITY",bytes,
      producerType:"SYSTEM",producerId:"engineer-verification",trusted:true,
      ...(input.createdAt===undefined?{}:{createdAt:input.createdAt})});
    return ArtifactRecordSchema.parse({...pending,artifactId:hardeningReviewAuthorityArtifactId({runId:input.runId,
      checkpointHash:input.checkpointHash,authorityHash:payload.authorityHash})});
  }

  private loadOptionalHardeningReviewInputAuthority(input:{runId:string;manifestHash:string;diffHash:string;
    resultCommitSha:string;checkpointArtifact:ArtifactRecord;checkpointHash:string;completionEvidenceIds?:readonly string[];
    safetyIdentifier?:string}){
    const artifacts=this.options.supervisor.listArtifacts(input.runId),matches=artifacts.filter((artifact)=>
      artifact.type==="HARDENING_REVIEW_INPUT_AUTHORITY");
    if(matches.length!==1)throw new HardeningGenericOperationForbiddenError();const artifact=matches[0]!;
    if(!artifact.trusted||artifact.producerType!=="SYSTEM"||artifact.producerId!=="engineer-verification")
      throw new HardeningGenericOperationForbiddenError();
    let authority;try{authority=OptionalHardeningReviewInputAuthoritySchema.parse(
      JSON.parse(this.options.artifactStore.readVerifiedExact(artifact).toString("utf8")));}
    catch{throw new HardeningGenericOperationForbiddenError();}
    if(authority.runId!==input.runId||authority.manifestHash!==input.manifestHash||authority.diffHash!==input.diffHash||
      authority.resultCommitSha!==input.resultCommitSha||authority.checkpointArtifactId!==input.checkpointArtifact.artifactId||
      authority.checkpointArtifactHash!==input.checkpointArtifact.sha256||authority.checkpointHash!==input.checkpointHash||
      authority.reviewerInput.runId!==input.runId||authority.reviewerInput.manifestHash!==input.manifestHash||
      authority.reviewerInput.diffHash!==input.diffHash||authority.reviewerInput.resultCommitSha!==input.resultCommitSha||
      canonicalJson(this.options.supervisor.latestRiskAssessment(input.runId))!==canonicalJson(authority.reviewerInput.riskAssessment))
      throw new HardeningGenericOperationForbiddenError();
    let resolvedEvidence,resolvedSemanticAuthority,requestAuthority;try{
      resolvedEvidence=resolveHardeningReviewerEvidenceAuthority({reviewerInput:authority.reviewerInput,artifacts,
        runRecords:this.options.supervisor.exportRunRecords(input.runId),readArtifact:(candidate)=>
          this.options.artifactStore.readVerifiedExact(candidate)});
      resolvedSemanticAuthority=resolveHardeningReviewerSemanticAuthority({reviewerInput:authority.reviewerInput,artifacts,
        runRecords:this.options.supervisor.exportRunRecords(input.runId),readArtifact:(candidate)=>
          this.options.artifactStore.readVerifiedExact(candidate)});
      requestAuthority=buildIsolatedReviewerRequestPlan(authority.reviewerInput,{modelConfiguration:this.options.modelConfiguration,
        safetyIdentifier:input.safetyIdentifier,hardeningPromptCacheIdentity:{secret:this.options.hardeningPromptCacheSecret??(()=>{
          throw new HardeningPromptCacheAuthorityUnavailableError();})(),requesterUserId:this.options.supervisor.getRun(input.runId).userId,
        childRunId:input.runId}}).authority;
    }catch{throw new HardeningGenericOperationForbiddenError();}
    if(canonicalJson(resolvedEvidence)!==canonicalJson(authority.evidenceAuthority))
      throw new HardeningGenericOperationForbiddenError();
    if(canonicalJson(resolvedSemanticAuthority)!==canonicalJson(authority.semanticAuthority))
      throw new HardeningGenericOperationForbiddenError();
    if(canonicalJson(requestAuthority)!==canonicalJson(authority.requestAuthority))
      throw new HardeningGenericOperationForbiddenError();
    try{this.options.supervisor.preflightDurableReviewerEvidence(authority.reviewerInput);}
    catch{throw new HardeningGenericOperationForbiddenError();}
    const suffix=[artifact.artifactId,artifact.sha256,...authority.reviewerInput.trustedEvidence.map((item)=>item.evidenceId)].sort();
    if(input.completionEvidenceIds&&canonicalJson(input.completionEvidenceIds.slice(3))!==canonicalJson(suffix))
      throw new HardeningGenericOperationForbiddenError();
    for(const evidence of authority.reviewerInput.trustedEvidence){
      const candidate=artifacts.find((item)=>item.artifactId===evidence.evidenceId);
      if(candidate)this.options.artifactStore.readVerifiedExact(candidate);
      const stack:unknown[]=[evidence.payload];while(stack.length){const value=stack.pop();
        if(Array.isArray(value)){stack.push(...value);continue;}if(!value||typeof value!=="object")continue;
        const row=value as Record<string,unknown>;if(typeof row.artifactId==="string"){
          const nested=artifacts.filter((item)=>item.artifactId===row.artifactId&&
            (typeof row.sha256!=="string"||item.sha256===row.sha256));
          if(nested.length!==1)throw new HardeningGenericOperationForbiddenError();this.options.artifactStore.readVerifiedExact(nested[0]!);
        }stack.push(...Object.values(row));}
    }
    return {authority,artifact};
  }

  private transitionHardeningCheckpointMilestone(runId:string,kind:"OPENED"|"RESUMED",
    nextState:Parameters<EngineerSupervisor["transition"]>[0]["nextState"],reasonCode:string,artifact:ArtifactRecord,
    checkpoint:ReturnType<typeof OptionalHardeningIndependentCheckpointSchema.parse>,extraEvidence:string[]=[]):void{
    this.assertLeaseAuthority(runId);
    const expected=kind==="OPENED"?{nextState:"VERIFICATION_RECOVERY",reasonCode:"PHASE3_PROCESS_INTERRUPTED"}:
      {nextState:"SECURITY_REVIEW",reasonCode:"INDEPENDENT_VERIFICATION_CHECKPOINT_RESUMED"};
    if(nextState!==expected.nextState||reasonCode!==expected.reasonCode||extraEvidence.length)
      throw new HardeningGenericOperationForbiddenError();
    this.options.supervisor.transitionOptionalHardeningCheckpointMilestone({kind,artifact,checkpoint,
      workerLease:this.requiredWorkerLeaseProof(runId)});
  }

  private hasIndependentVerificationCheckpoint(runId: string): boolean {
    return this.options.supervisor.listArtifacts(runId).some((artifact) =>
      artifact.type === "INDEPENDENT_VERIFICATION_CHECKPOINT" && artifact.trusted &&
      artifact.producerType === "SYSTEM" && artifact.producerId === "engineer-verification");
  }

  private storeIndependentVerificationCheckpoint(
    runId: string,
    manifestHash: string,
    diffHash: string,
    resultCommitSha: string,
    verified: IndependentVerificationOutput,
    finalDiffArtifact:ArtifactRecord,
  ): ArtifactRecord {
    this.assertLeaseAuthority(runId);
    const hardening=this.options.supervisor.isOptionalHardeningChild(runId);
    const selectedEvent=hardening?this.options.supervisor.listEvents(runId).at(-1):undefined;
    if(hardening&&(!selectedEvent||selectedEvent.runId!==runId))throw new Error("optional-hardening checkpoint event authority is unavailable");
    const portableVerified=hardening?{...verified,
      securityReportArtifact:projectHardeningArtifactAuthority(verified.securityReportArtifact)}:verified;
    const hardeningContent=hardening?{version:2 as const,runId,manifestHash,diffHash,resultCommitSha,
      diffArtifactId:finalDiffArtifact.artifactId,diffArtifactHash:finalDiffArtifact.sha256,
      selectedEventId:selectedEvent!.eventId,selectedEventSequence:selectedEvent!.sequence,
      selectedEventStateVersion:selectedEvent!.stateVersion,selectedEventState:selectedEvent!.nextState,
      selectedEventReasonCode:selectedEvent!.reasonCode,selectedEventEvidenceHash:sha256(selectedEvent!.evidenceIds),
      selectedEventHash:sha256(selectedEvent!),verified:portableVerified}:
      null;
    const payload=hardening?{...hardeningContent!,checkpointHash:sha256(hardeningContent)}:
      {version:1,runId,manifestHash,diffHash,resultCommitSha,verified};
    return this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId,
      type: "INDEPENDENT_VERIFICATION_CHECKPOINT",
      bytes: hardening?canonicalJson(payload):JSON.stringify(payload),
      producerType: "SYSTEM",
      producerId: "engineer-verification",
      trusted: true,
    }));
  }

  private loadIndependentVerificationCheckpoint(
    runId: string,
    manifestHash: string,
    diffHash: string,
    resultCommitSha: string,
  ): IndependentVerificationOutput | null {
    const hardening=this.options.supervisor.isOptionalHardeningChild(runId);
    const raw=this.options.supervisor.listArtifacts(runId).filter((artifact)=>artifact.type==="INDEPENDENT_VERIFICATION_CHECKPOINT");
    if(hardening&&raw.length>1)throw new Error("optional-hardening independent checkpoint authority is ambiguous");
    const artifacts = raw.filter((artifact) => artifact.trusted && artifact.producerType === "SYSTEM" &&
      artifact.producerId === "engineer-verification").reverse();
    if(hardening&&raw.length===1&&artifacts.length!==1)throw new Error("optional-hardening independent checkpoint authority is invalid");
    for (const artifact of artifacts) {
      try {
        const bytes=hardening?this.options.artifactStore.readVerifiedExact(artifact):this.options.artifactStore.read(artifact),
          text=new TextDecoder("utf-8",{fatal:hardening}).decode(bytes),parsed=JSON.parse(text);
        if(hardening){
          const value=OptionalHardeningIndependentCheckpointSchema.parse(parsed);
          if(text!==canonicalJson(value))throw new Error("optional-hardening checkpoint is not canonical");
          if(value.runId!==runId||value.manifestHash!==manifestHash||value.diffHash!==diffHash||
            value.resultCommitSha!==resultCommitSha)continue;
          validateOptionalHardeningCheckpointChain({checkpoint:value,artifact,
            events:this.options.supervisor.listEvents(runId),manifestHash});
          const matches=this.options.supervisor.listArtifacts(runId).filter((candidate)=>candidate.artifactId===value.diffArtifactId&&
            candidate.sha256===value.diffArtifactHash&&candidate.type==="FINAL_DIFF"&&candidate.trusted&&
            candidate.producerType==="SYSTEM"&&candidate.producerId==="engineer-verification");
          if(matches.length!==1||sha256(this.options.artifactStore.readVerifiedExact(matches[0]!).toString("utf8"))!==diffHash)
            throw new Error("optional-hardening checkpoint diff authority is invalid");
          const securityReportArtifact=resolveHardeningArtifactAuthority({authority:value.verified.securityReportArtifact,
            artifacts:this.options.supervisor.listArtifacts(runId),readArtifact:(candidate)=>
              this.options.artifactStore.readVerifiedExact(candidate)});
          return {...value.verified,securityReportArtifact};
        }
        const value=parsed as Record<string,unknown>;
        if(value.version!==1||value.runId!==runId||value.manifestHash!==manifestHash||value.diffHash!==diffHash||
          value.resultCommitSha!==resultCommitSha||!value.verified||typeof value.verified!=="object"||Array.isArray(value.verified))continue;
        const verified = value.verified as Record<string, unknown>;
        return {
          executions: VerificationExecutionRecordSchema.array().parse(verified.executions),
          securityFindings: SecurityFindingRecordSchema.array().parse(verified.securityFindings),
          trustedEvidence: TrustedEvidenceSchema.array().parse(verified.trustedEvidence),
          securityReportArtifact: ArtifactRecordSchema.parse(verified.securityReportArtifact),
        };
      } catch(error) { if(hardening)throw error; /* ignore malformed or stale ordinary checkpoints */ }
    }
    if(hardening&&raw.length===1)throw new Error("optional-hardening independent checkpoint v2 is invalid");
    return null;
  }

  private startAgent(runId: string, role: ModelRole, inputHash: string): AgentContext {
    this.assertLeaseAuthority(runId);
    const route = resolveEngineerModel(role, this.options.modelConfiguration);
    const context = { id: this.id(), routingDecisionId: this.id(), role, startedAt: this.timestamp(), inputHash, route };
    this.options.supervisor.recordAgentExecution({
      agentExecutionId: context.id, runId, role, modelTier: route.logicalTier,
      status: "RUNNING", inputHash, outputArtifactId: null, startedAt: context.startedAt, completedAt: null,
    });
    this.recordAgentRouting(runId, context);
    return context;
  }

  private recordAgentRouting(runId: string, context: AgentContext): void {
    this.options.supervisor.recordModelRouting({
      routingDecisionId: context.routingDecisionId, runId, agentExecutionId: context.id, agentRole: context.role, logicalTier: context.route.logicalTier,
      resolvedModel: context.route.model, routingPolicyVersion: context.route.policyVersion,
      fallbackUsed: false, fallbackReason: null, cacheKey: null, timestamp: context.startedAt,
    });
  }

  private claimBuilderAgent(runId: string, inputHash: string): { won: boolean; agent: AgentContext; agentRecord: AgentExecutionRecord } {
    this.assertLeaseAuthority(runId);
    const route = resolveEngineerModel("BUILDER", this.options.modelConfiguration);
    const candidate: AgentContext = { id: this.id(), routingDecisionId: this.id(), role: "BUILDER", startedAt: this.timestamp(), inputHash, route };
    const lease = this.activeLeases.get(runId);
    const claim = this.options.supervisor.claimBuilderDispatch({
      agentExecutionId: candidate.id, runId, role: "BUILDER", modelTier: route.logicalTier,
      status: "RUNNING", inputHash, outputArtifactId: null, startedAt: candidate.startedAt, completedAt: null,
    }, lease ? {
      ownerId: this.options.workerOwnerId ?? "engineer-verification-worker",
      fencingToken: lease.lease.fencingToken,
    } : null);
    if (!claim.won) {
      return {
        won: false,
        agent: {
          id: claim.execution.agentExecutionId, routingDecisionId: candidate.routingDecisionId,
          role: "BUILDER", startedAt: claim.execution.startedAt,
          inputHash: claim.execution.inputHash, route,
        },
        agentRecord: claim.execution,
      };
    }
    return { won: true, agent: candidate, agentRecord: claim.execution };
  }

  private recoverSucceededBuilderRepair(
    manifest: TaskManifest,
    testIntegrity: TestIntegrityGuard,
    recovered: AgentExecutionRecord,
    completionReason: "REVIEW_REPAIR_IMPLEMENTED" | "STABLE_REQUIRED_TEST_REPAIR_IMPLEMENTED",
    authorityEvidenceIds: string[],
  ): void {
    const runId = manifest.runId;
    if (!recovered.outputArtifactId) throw new Error("succeeded Builder repair is missing its durable result artifact");
    const artifact = this.options.supervisor.listArtifacts(runId)
      .find((candidate) => candidate.artifactId === recovered.outputArtifactId);
    if (!artifact || artifact.type !== "BUILDER_REPAIR_RESULT" || artifact.producerType !== "SYSTEM" ||
        artifact.producerId !== recovered.agentExecutionId) {
      throw new Error("succeeded Builder repair result authority is invalid");
    }
    const result = BuilderResultSchema.parse(JSON.parse(this.options.artifactStore.read(artifact).toString("utf8")));
    if (result.runId !== runId || result.manifestHash !== manifest.manifestHash) {
      throw new Error("succeeded Builder repair result is stale or belongs to another run");
    }
    const integrity = testIntegrity.attest("POST_REPAIR");
    if (this.options.supervisor.getRun(runId).state === "IMPLEMENTING") {
      this.transition(runId, "FAST_CHECKS", completionReason,
        [...authorityEvidenceIds, artifact.artifactId, integrity.artifact.artifactId]);
    }
  }

  private storeAgentOutput(runId: string, agent: AgentContext, type: string, output: unknown): ArtifactRecord {
    this.assertLeaseAuthority(runId);
    const artifact = this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId, type, bytes: JSON.stringify(output), producerType: "SYSTEM", producerId: agent.id, trusted: false,
      ...(type === "BUILDER_REPAIR_RESULT" ? { createdAt: BuilderResultSchema.parse(output).completedAt } : {}),
    }));
    const completedAt = type === "BUILDER_REPAIR_RESULT"
      ? BuilderResultSchema.parse(output).completedAt
      : this.timestamp();
    const record: AgentExecutionRecord = {
      agentExecutionId: agent.id, runId, role: agent.role, modelTier: agent.route.logicalTier,
      status: "SUCCEEDED", inputHash: agent.inputHash, outputArtifactId: artifact.artifactId,
      startedAt: agent.startedAt, completedAt,
    };
    this.options.supervisor.recordAgentExecution(record);
    return artifact;
  }

  private testIntegrityEvidence(artifact: ArtifactRecord, comparison: TestIntegrityComparison): TrustedEvidence {
    return TrustedEvidenceSchema.parse({
      evidenceId: artifact.artifactId,
      runId: comparison.runId,
      eventType: "TEST_INTEGRITY_ATTESTATION",
      producerType: "SYSTEM",
      producerId: artifact.producerId,
      sha256: artifact.sha256,
      payload: comparison,
      createdAt: artifact.createdAt,
    });
  }

  private finalChangeScopeEvidence(
    manifest: TaskManifest,
    diff: string,
    resultCommitSha: string,
  ): TrustedEvidence {
    const payload = buildFinalChangeScopeAttestation({
      manifest,
      diff,
      resultCommitSha,
      credentialedGitOperationCount: this.options.supervisor.listGitOperations(manifest.runId).length,
    });
    const artifact = this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId: manifest.runId,
      type: "FINAL_CHANGE_SCOPE_ATTESTATION",
      bytes: canonicalJson(payload),
      producerType: "SYSTEM",
      producerId: "final-change-scope-policy",
      trusted: true,
    }));
    return TrustedEvidenceSchema.parse({
      evidenceId: artifact.artifactId,
      runId: manifest.runId,
      eventType: "FINAL_CHANGE_SCOPE_ATTESTATION",
      producerType: "SYSTEM",
      producerId: "final-change-scope-policy",
      sha256: artifact.sha256,
      payload,
      createdAt: artifact.createdAt,
    });
  }

  private failAgent(runId: string, agent: AgentContext): void {
    const paused = this.options.supervisor.getRun(runId).state === "PAUSED_BUDGET";
    this.options.supervisor.recordAgentExecution({
      agentExecutionId: agent.id, runId, role: agent.role, modelTier: agent.route.logicalTier,
      status: paused ? "PAUSED" : "FAILED", inputHash: agent.inputHash, outputArtifactId: null,
      startedAt: agent.startedAt, completedAt: this.timestamp(),
    });
  }

  private authorizeTransientModelRetry(runId: string, role: ModelRole, error: unknown, attempt: number): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.options.supervisor.getRun(runId);
    if (!this.options.supervisor.isOptionalHardeningChild(runId)&&isProviderModelTimeout(error) && canTransition(current.state, "MODEL_PROVIDER_RETRY_PENDING")) {
      // A completed deterministic verification must not be held hostage by an
      // unavailable reviewer. One retry is useful for a transient provider
      // blip; repeating it merely spends budget while producing no new code or
      // evidence. Escalate the second ambiguous Reviewer outcome to a durable
      // human gate instead. This is deliberately Reviewer-only: Tester and
      // Security calls still need their normal retry semantics because their
      // evidence is not otherwise complete.
      const priorReviewerTimeout = role === "REVIEWER" && this.options.supervisor.listFailures(runId)
        .some((failure) => failure.reasonCode === "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS");
      if (priorReviewerTimeout && canTransition(current.state, "HUMAN_REVIEW_REQUIRED")) {
        this.options.supervisor.recordFailure(FailureRecordSchema.parse({
          failureId: this.id(), runId, failureClass: "MODEL_FAILURE",
          reasonCode: "VERIFICATION_PROVIDER_TIMEOUT_REQUIRES_HUMAN_REVIEW",
          fingerprint: sha256({ role, message, reasonCode: "VERIFICATION_PROVIDER_TIMEOUT_REQUIRES_HUMAN_REVIEW" }),
          evidenceIds: [], retryable: false, createdAt: this.timestamp(),
        }));
        this.transition(runId, "HUMAN_REVIEW_REQUIRED", "VERIFICATION_PROVIDER_TIMEOUT_REQUIRES_HUMAN_REVIEW");
        return false;
      }
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: this.id(), runId, failureClass: "MODEL_FAILURE",
        reasonCode: "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS",
        fingerprint: sha256({ role, message, reasonCode: "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS" }),
        evidenceIds: [], retryable: true, createdAt: this.timestamp(),
      }));
      this.transition(runId, "MODEL_PROVIDER_RETRY_PENDING", "VERIFICATION_PROVIDER_OUTCOME_AMBIGUOUS");
      return false;
    }
    const retry = this.options.supervisor.authorizeRetry({
      runId, expectedStateVersion: current.stateVersion, kind: "TRANSIENT_MODEL",
      failureFingerprint: sha256({ role, message }), patchHash: null, progressMetric: attempt,
    });
    if (!retry.allowed && canTransition(current.state, "RETRY_BUDGET_EXHAUSTED")) {
      this.transition(runId, "RETRY_BUDGET_EXHAUSTED", retry.reasonCode);
    }
    return retry.allowed;
  }

  private mapClaims(
    manifest: TaskManifest,
    review: ReviewerOutput,
    trustedEvidence: TrustedEvidence[],
    attempt: number,
    createdAt = this.timestamp(),
  ): ClaimEvidenceRecord[] {
    const knownEvidence = new Set(trustedEvidence.map((item) => item.evidenceId));
    const now = createdAt;
    const claims = manifest.acceptanceCriteria.map((criterion) => {
      const coverage = review.requirementCoverage.find((item) => item.criterionId === criterion.criterionId);
      const evidenceIds = coverage?.evidenceIds.filter((id) => knownEvidence.has(id)) ?? [];
      const criterionEvidenceIds = evidenceIds.filter((id) => {
        const evidence = trustedEvidence.find((item) => item.evidenceId === id);
        return evidence ? trustedEvidenceSupportsCriterion(evidence, criterion.criterionId) : false;
      });
      const status = coverage?.status === "SATISFIED" && criterionEvidenceIds.length > 0
        ? "VERIFIED"
        : coverage?.status === "PARTIAL" && criterionEvidenceIds.length > 0
          ? "PARTIALLY_VERIFIED"
          : coverage?.status === "FAILED"
            ? "FAILED"
            : "UNVERIFIED";
      return ClaimEvidenceRecordSchema.parse({
        claimId: reviewerClaimEvidenceId({
          runId: manifest.runId, attempt, kind: "CRITERION", key: criterion.criterionId,
        }),
        runId: manifest.runId,
        criterionId: criterion.criterionId,
        claim: criterion.statement,
        status,
        evidenceIds: criterionEvidenceIds,
        notes: coverage?.explanation ?? "Reviewer supplied no coverage record.",
        createdAt: now,
      });
    });
    for (const [index, unsupported] of review.unsupportedClaims.entries()) {
      claims.push(ClaimEvidenceRecordSchema.parse({
        claimId: reviewerClaimEvidenceId({
          runId: manifest.runId, attempt, kind: "UNSUPPORTED", key: String(index + 1),
        }), runId: manifest.runId, criterionId: null,
        claim: unsupported, status: "UNVERIFIED", evidenceIds: [], notes: "Explicitly unsupported by the isolated Reviewer.", createdAt: now,
      }));
    }
    return claims;
  }

  private bundle(
    manifest: TaskManifest,
    sandbox: SandboxRecord,
    resultCommitSha: string,
    claims: ClaimEvidenceRecord[],
    reviewerSessionId: string,
    classificationHash: string,
    classificationResult: "REPAIR_REQUIRED" | "BLOCKED" | "HUMAN_REVIEW_REQUIRED" | "READY_WITH_ADVISORIES" | "READY",
    classificationCreatedAt: string,
    finalDecision: string,
    artifacts: ArtifactRecord[],
  ) {
    const bundle = EvidenceBundleSchema.parse({
      bundleVersion: 2,
      runId: manifest.runId,
      reviewerSessionId,
      classificationHash,
      classificationResult,
      manifestHash: manifest.manifestHash,
      baseCommitSha: manifest.repository.baseCommitSha,
      resultCommitSha,
      environmentDigest: sandbox.environmentDigest,
      artifacts: artifacts.map((artifact) => ({
        artifactId: artifact.artifactId, type: artifact.type, sha256: artifact.sha256,
        createdAt: artifact.createdAt, producer: artifact.producerId, sizeBytes: artifact.sizeBytes,
      })),
      claims: claims.map(({ runId: _runId, criterionId: _criterionId, createdAt: _createdAt, ...claim }) => claim),
      finalDecision,
      // Classification completion is the durable authority timestamp. Reusing it
      // makes a crash replay produce byte-identical bundle content.
      createdAt: classificationCreatedAt,
    });
    return EvidenceBundleRecordSchema.parse({
      evidenceBundleId: sha256({
        namespace: "classified-evidence-bundle-v2", runId: manifest.runId,
        reviewerSessionId, classificationHash,
      }),
      bundle,
      bundleHash: sha256(bundle),
    });
  }

  private recordOrVerifyClassifiedBundle(expected: EvidenceBundleRecord): EvidenceBundleRecord {
    const bound = this.options.supervisor.listEvidenceBundles(expected.bundle.runId).filter((candidate) =>
      candidate.bundle.reviewerSessionId === expected.bundle.reviewerSessionId &&
      candidate.bundle.classificationHash === expected.bundle.classificationHash);
    if (bound.length > 1) {
      throw new Error("classified review recovery found ambiguous Evidence Bundle authority");
    }
    if (bound.length === 1) {
      if (canonicalJson(bound[0]) !== canonicalJson(expected)) {
        throw new Error("classified review recovery Evidence Bundle conflicts with rehydrated authority");
      }
      return bound[0]!;
    }
    const recorded = this.options.supervisor.recordEvidenceBundle(expected);
    if (canonicalJson(recorded) !== canonicalJson(expected)) {
      throw new Error("classified review recovery failed to persist the exact Evidence Bundle");
    }
    return recorded;
  }

  private classificationArtifacts(
    reviewerInput: ReturnType<typeof ReviewerInputSchema.parse>,
    rawOutputArtifactId: string,
  ): ArtifactRecord[] {
    const ids = new Set<string>([rawOutputArtifactId]);
    for (const evidence of reviewerInput.trustedEvidence) {
      ids.add(evidence.evidenceId);
      for (const key of ["stdoutArtifact", "stderrArtifact"]) {
        const reference = evidence.payload[key];
        if (reference && typeof reference === "object" && "artifactId" in reference &&
            typeof reference.artifactId === "string") ids.add(reference.artifactId);
      }
    }
    const records = new Map(this.options.supervisor.listArtifacts(reviewerInput.runId)
      .map((artifact) => [artifact.artifactId, artifact]));
    return [...ids].sort((left, right) => left < right ? -1 : left > right ? 1 : 0).flatMap((artifactId) => {
      const artifact = records.get(artifactId);
      // Verification execution ids are ledger evidence rather than artifact
      // ids. Their nested stdout/stderr artifacts above carry the byte graph.
      if (!artifact) {
        if (reviewerInput.trustedEvidence.some((evidence) => evidence.evidenceId === artifactId &&
            evidence.eventType === "INDEPENDENT_VERIFICATION")) return [];
        throw new Error(`classified evidence artifact ${artifactId} is missing`);
      }
      if (!artifact.trusted) throw new Error(`classified evidence artifact ${artifactId} is not trusted`);
      if(this.options.supervisor.isOptionalHardeningChild(reviewerInput.runId))
        this.options.artifactStore.readVerifiedExact(artifact);
      else this.options.artifactStore.read(artifact);
      return [artifact];
    });
  }

  private transition(
    runId: string,
    nextState: Parameters<EngineerSupervisor["transition"]>[0]["nextState"],
    reasonCode: string,
    evidenceIds: string[] = [],
    facts?: Parameters<EngineerSupervisor["transition"]>[0]["facts"],
  ): void {
    this.assertLeaseAuthority(runId);
    const run = this.options.supervisor.getRun(runId);
    this.options.supervisor.transition({
      runId, expectedStateVersion: run.stateVersion, nextState, reasonCode, evidenceIds,
      manifestHash: run.manifestHash, idempotencyKey: `phase3:${nextState.toLowerCase()}:${run.stateVersion + 1}`,
      ...(facts ? { facts } : {}),
    });
  }

  private assertLeaseAuthority(runId: string): void {
    const lease = this.activeLeases.get(runId);
    if (lease && this.options.leaseManager) {
      this.options.leaseManager.assertActive({
        leaseId: lease.lease.leaseId,
        ownerId: this.options.workerOwnerId ?? "engineer-verification-worker",
        fencingToken: lease.lease.fencingToken,
        leaseToken: lease.leaseToken,
      });
    }
    const signal = this.abortControllers.get(runId)?.signal;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("verification worker authority was revoked");
  }

  private requiredWorkerLeaseProof(runId:string):RecoveryWorkerLeaseProof{
    const lease=this.activeLeases.get(runId);
    if(!lease||!this.options.leaseManager)throw new HardeningWorkspaceRecoveryAuthorityInvalidError(runId);
    return {leaseId:lease.lease.leaseId,ownerId:lease.lease.ownerId,fencingToken:lease.lease.fencingToken,
      leaseToken:lease.leaseToken};
  }

  private failClosed(runId: string, error: unknown): void {
    const run = this.options.supervisor.getRun(runId);
    if (isTerminalState(run.state) || run.state === "REVIEW_APPROVED") return;
    if (error instanceof BuilderModelCallLimitError) {
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: this.id(), runId, failureClass: "WORKFLOW_FAILURE",
        reasonCode: "BUILDER_MODEL_CALL_LIMIT_REACHED",
        fingerprint: sha256({ reasonCode: "BUILDER_MODEL_CALL_LIMIT_REACHED", limit: error.limit }),
        evidenceIds: [], retryable: false, createdAt: this.timestamp(),
      }));
      if (canTransition(run.state, "RETRY_BUDGET_EXHAUSTED")) {
        this.transition(runId, "RETRY_BUDGET_EXHAUSTED", "BUILDER_MODEL_CALL_LIMIT_REACHED");
      }
      return;
    }
    if (error instanceof RuntimeBudgetExhaustedError) {
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: this.id(), runId, failureClass: "WORKFLOW_FAILURE",
        reasonCode: "RUNTIME_BUDGET_EXHAUSTED",
        fingerprint: sha256({ reasonCode: "RUNTIME_BUDGET_EXHAUSTED", reasons: error.decision.hardLimitReasons }),
        evidenceIds: [], retryable: false, createdAt: this.timestamp(),
      }));
      if (canTransition(run.state, "RETRY_BUDGET_EXHAUSTED")) {
        this.transition(runId, "RETRY_BUDGET_EXHAUSTED", "RUNTIME_BUDGET_EXHAUSTED");
      }
      return;
    }
    if (error instanceof TestIntegrityViolationError) {
      const nextState = canTransition(run.state, "SECURITY_ESCALATION") ? "SECURITY_ESCALATION" : "VERIFICATION_INCOMPLETE";
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: this.id(),
        runId,
        failureClass: "SECURITY_FAILURE",
        reasonCode: error.reasonCode,
        fingerprint: sha256({ reasonCode: error.reasonCode, state: run.state, message: error.message }),
        evidenceIds: error.evidenceId ? [error.evidenceId] : [],
        retryable: false,
        createdAt: this.timestamp(),
      }));
      if (canTransition(run.state, nextState)) {
        this.transition(runId, nextState, error.reasonCode, error.evidenceId ? [error.evidenceId] : []);
      }
      return;
    }
    if (error instanceof BuilderNoProgressError) {
      const nextState = canTransition(run.state, "VERIFICATION_INCOMPLETE") ? "VERIFICATION_INCOMPLETE" : "FAILED";
      this.options.supervisor.recordFailure(FailureRecordSchema.parse({
        failureId: this.id(),
        runId,
        failureClass: "DEPENDENCY_FAILURE",
        reasonCode: "BUILDER_NO_PROGRESS",
        fingerprint: sha256({ reasonCode: "BUILDER_NO_PROGRESS", command: error.command, state: run.state }),
        evidenceIds: [...error.commandExecutionIds],
        retryable: false,
        createdAt: this.timestamp(),
      }));
      if (canTransition(run.state, nextState)) this.transition(runId, nextState, "BUILDER_NO_PROGRESS", [...error.commandExecutionIds]);
      return;
    }
    const preferred = ["FAST_CHECKS", "UNIT_TESTING", "INTEGRATION_TESTING", "E2E_TESTING", "VERIFICATION_RECOVERY", "REVERIFYING"].includes(run.state)
      ? "VERIFICATION_INCOMPLETE"
      : run.state === "FLAKE_QUARANTINE"
        ? "HUMAN_REVIEW_REQUIRED"
      : run.state === "SECURITY_REVIEW"
        ? "SECURITY_ESCALATION"
        : ["REVIEWING", "REVIEW_CHANGES_REQUESTED"].includes(run.state)
          ? "HUMAN_REVIEW_REQUIRED"
          : ["IMPLEMENTING", "EVIDENCE_SYNTHESIS"].includes(run.state)
            ? "FAILED"
            : "RETRY_BUDGET_EXHAUSTED";
    if (!canTransition(run.state, preferred)) return;
    const message = error instanceof Error ? error.message : String(error);
    // P7 (Day 3 pair 2): deterministically type the underlying cause BEFORE the
    // raw message is erased into the fingerprint. The generic reasonCode and
    // transition reason are unchanged (a Phase-3 failure is still non-recoverable
    // by default); the typed cause is carried in the additive `underlyingCause`
    // slot so the reverify law can honestly unlock only the closed transient
    // allowlist. Untypeable messages leave it absent (still PHASE3_CAUSE_UNTYPED).
    const underlyingCause = classifyPhase3UnderlyingCause(message);
    this.options.supervisor.recordFailure(FailureRecordSchema.parse({
      failureId: this.id(),
      runId,
      failureClass: "WORKFLOW_FAILURE",
      reasonCode: "PHASE3_UNEXPECTED_FAILURE",
      fingerprint: sha256({ failureClass: "WORKFLOW_FAILURE", reasonCode: "PHASE3_UNEXPECTED_FAILURE", state: run.state, message }),
      evidenceIds: [],
      retryable: false,
      ...(underlyingCause ? { underlyingCause } : {}),
      createdAt: this.timestamp(),
    }));
    this.transition(runId, preferred, "PHASE3_UNEXPECTED_FAILURE");
  }

  private id(): string { return (this.options.idFactory ?? randomUUID)(); }
  private timestamp(): string { return (this.options.now ?? (() => new Date()))().toISOString(); }
}
