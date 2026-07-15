import { randomUUID } from "node:crypto";
import {
  SandboxWorkspaceCheckpointSchema,
  type BuilderResult,
  type SandboxRecord,
} from "./execution-contracts.js";
import type { LocalArtifactStore } from "./artifact-store.js";
import type { CodexBuilderOptions, ResponsesTransport } from "./codex-builder.js";
import { CODEX_BUILDER_PROMPT_VERSION, CodexBuilder } from "./codex-builder.js";
import type { DockerSandboxManager, ProvisionedSandbox } from "./sandbox-manager.js";
import type { EngineerSupervisor } from "./supervisor.js";
import { TrustedCommandExecutor } from "./trusted-executor.js";
import { resolveEngineerModel } from "./model-routing.js";
import { sha256 } from "./hash.js";
import { FailureRecordSchema } from "./control-contracts.js";
import { executionFailureDomain, operationalFailurePolicy } from "./failure-policy.js";
import type { EngineerWorkerLeaseManager, WorkerLeaseGrant } from "./worker-lease.js";
import { RuntimeBudgetExhaustedError } from "./runtime-budget.js";
import { canTransition } from "./state-machine.js";
import { TestIntegrityGuard, TestIntegrityViolationError } from "./test-integrity.js";

const PHASE2_RECOVERABLE_STATES = new Set([
  "SANDBOX_WARM_CLAIMING", "SANDBOX_WARM_VALIDATING", "SANDBOX_WARM_CLAIMED",
  "SANDBOX_COLD_PROVISIONING", "SANDBOX_PREWARM_INVALID", "SANDBOX_PROVISIONING",
  "SANDBOX_PREFLIGHT", "SANDBOX_READY", "CONTEXT_BUILDING", "IMPLEMENTING",
]);

export interface EngineerExecutionManagerOptions {
  supervisor: EngineerSupervisor;
  sandboxManager: DockerSandboxManager;
  artifactStore: LocalArtifactStore;
  repositoryRootFor: (repositoryId: string) => string;
  transportForRun: (runId: string) => ResponsesTransport | Promise<ResponsesTransport>;
  now?: () => Date;
  idFactory?: () => string;
  builderOptions?: Pick<CodexBuilderOptions, "modelConfiguration" | "maxRounds">;
  leaseManager?: EngineerWorkerLeaseManager;
  workerOwnerId?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  safetyIdentifierForUser?: (userId: string) => string;
}

/** Phase-2 worker: one Builder per run, deterministic state promotions, durable evidence records. */
export class EngineerExecutionManager {
  private readonly options: EngineerExecutionManagerOptions;
  private readonly active = new Map<string, Promise<BuilderResult>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly sandboxes = new Map<string, ProvisionedSandbox>();

  constructor(options: EngineerExecutionManagerOptions) {
    this.options = options;
  }

  execute(runId: string): Promise<BuilderResult> {
    this.enqueue(runId);
    return this.runQueued(runId);
  }

  enqueue(runId: string) {
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

  /** Abort detached model work and await cleanup before gateway-owned stores close. */
  async drain(cleanupSandboxes = true): Promise<void> {
    for (const controller of this.abortControllers.values()) controller.abort(new Error("Engineer gateway is draining"));
    await Promise.allSettled([...this.active.values()]);
    if (cleanupSandboxes) await this.destroyAllAsync();
  }

  destroyAll(): void { for (const runId of [...this.sandboxes.keys()]) this.destroy(runId); }

  async destroyAllAsync(): Promise<void> {
    await Promise.allSettled([...this.sandboxes.keys()].map((runId) => this.destroyAsync(runId)));
  }

  recoverQueued(): Array<{ runId: string; promise: Promise<BuilderResult> }> {
    return this.options.supervisor.listRuns(["QUEUED"]).map((run) => ({
      runId: run.runId,
      promise: this.runQueued(run.runId),
    }));
  }

  async recoverInterrupted(runId: string, leaseEvidenceId: string): Promise<"REQUEUED" | "EXHAUSTED" | "IGNORED"> {
    const supervisor = this.options.supervisor;
    const interrupted = supervisor.getRun(runId);
    if (!PHASE2_RECOVERABLE_STATES.has(interrupted.state)) return "IGNORED";
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
  async recoverSandbox(runId: string, resetToHead: boolean): Promise<ProvisionedSandbox> {
    const existing = this.sandboxes.get(runId);
    if (existing) return existing;
    const run = this.options.supervisor.getRun(runId);
    if (!run.manifestHash) throw new Error("sandbox recovery requires a frozen manifest");
    const checkpointArtifact = this.options.supervisor.listArtifacts(runId)
      .filter((artifact) => artifact.type === "SANDBOX_WORKSPACE_CHECKPOINT" && artifact.trusted)
      .at(-1);
    if (!checkpointArtifact) throw new Error("retained sandbox checkpoint is unavailable");
    const checkpoint = SandboxWorkspaceCheckpointSchema.parse(
      JSON.parse(this.options.artifactStore.read(checkpointArtifact).toString("utf8")),
    );
    if (checkpoint.runId !== runId || checkpoint.manifestHash !== run.manifestHash) {
      throw new Error("retained sandbox checkpoint does not match the active run manifest");
    }
    const recovered = await this.options.sandboxManager.recoverAsync({
      workspace: checkpoint.workspace,
      sandbox: checkpoint.sandbox,
      resetToHead,
    });
    this.sandboxes.set(runId, recovered);
    const recovery = this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId,
      type: "SANDBOX_RECOVERY_ATTESTATION",
      bytes: JSON.stringify({
        checkpointHash: checkpoint.checkpointHash,
        checkpointArtifactId: checkpointArtifact.artifactId,
        sandboxId: recovered.record.sandboxId,
        workspaceIdentity: recovered.workspace.workspaceIdentity,
        recoveredCommitSha: await this.options.sandboxManager.currentCommitAsync(recovered.workspace),
        resetToHead,
      }),
      producerType: "SYSTEM",
      producerId: "engineer-execution-manager",
      trusted: true,
    }));
    if (!recovery.trusted) throw new Error("sandbox recovery attestation must be trusted");
    return recovered;
  }

  destroy(runId: string): SandboxRecord | null {
    const sandbox = this.sandboxes.get(runId);
    if (!sandbox) return null;
    const destroyed = this.options.sandboxManager.destroy(sandbox);
    this.options.supervisor.recordSandbox(destroyed);
    this.sandboxes.delete(runId);
    return destroyed;
  }

  async destroyAsync(runId: string): Promise<SandboxRecord | null> {
    const sandbox = this.sandboxes.get(runId);
    if (!sandbox) return null;
    const destroyed = await this.options.sandboxManager.destroyAsync(sandbox);
    this.options.supervisor.recordSandbox(destroyed);
    this.sandboxes.delete(runId);
    return destroyed;
  }

  private async executeOnce(runId: string, signal: AbortSignal): Promise<BuilderResult> {
    const supervisor = this.options.supervisor;
    const initial = supervisor.getRun(runId);
    if (initial.state !== "QUEUED" || !initial.manifestHash) {
      throw new Error(`Phase 2 execution requires QUEUED, not ${initial.state}`);
    }
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

    let provisioned: ProvisionedSandbox | null = null;
    let agentExecutionId: string | null = null;
    let agentStartedAt: string | null = null;
    let lease: WorkerLeaseGrant | null = null;
    let testIntegrity: TestIntegrityGuard | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatSequence = 0;
    const leaseOwnerId = this.options.workerOwnerId ?? "engineer-execution-worker";
    const assertLease = () => {
      if (!lease || !this.options.leaseManager) return;
      this.options.leaseManager.assertActive({
        leaseId: lease.lease.leaseId,
        ownerId: leaseOwnerId,
        fencingToken: lease.lease.fencingToken,
        leaseToken: lease.leaseToken,
      });
    };
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
          } catch {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        }, this.options.heartbeatIntervalMs ?? 10_000);
        heartbeatTimer.unref?.();
      }
      assertLease();
      if (this.options.sandboxManager.warmEnabled()) {
        transition("SANDBOX_WARM_CLAIMING", "WARM_SANDBOX_CLAIM_STARTED");
      } else {
        transition("SANDBOX_COLD_PROVISIONING", "COLD_SANDBOX_SELECTED");
      }
      const repositoryRoot = this.options.repositoryRootFor(initial.repository.repositoryId);
      if (this.options.sandboxManager.warmEnabled()) {
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
      this.persistSandboxCheckpoint(initial.manifestHash, provisioned);
      transition("CONTEXT_BUILDING", "BUILDER_CONTEXT_BUILDING");
      const manifest = supervisor.getManifest(runId);
      if (!manifest) throw new Error("frozen manifest is unavailable");
      testIntegrity = TestIntegrityGuard.createAndRecord({
        supervisor,
        artifactStore: this.options.artifactStore,
        manifest,
        workspace: provisioned.workspace,
        now: this.options.now,
      });
      const route = resolveEngineerModel("BUILDER", this.options.builderOptions?.modelConfiguration);
      agentExecutionId = (this.options.idFactory ?? randomUUID)();
      agentStartedAt = (this.options.now ?? (() => new Date()))().toISOString();
      supervisor.recordAgentExecution({
        agentExecutionId,
        runId,
        role: "BUILDER",
        modelTier: "GPT-5.6_SOL",
        status: "RUNNING",
        inputHash: sha256(manifest),
        outputArtifactId: null,
        startedAt: agentStartedAt,
        completedAt: null,
      });
      supervisor.recordModelRouting({
        routingDecisionId: (this.options.idFactory ?? randomUUID)(),
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
      });
      const builder = new CodexBuilder({
        transport: await this.options.transportForRun(runId),
        manifest,
        workspace: provisioned.workspace,
        workspaceManager: this.options.sandboxManager.workspaceManager(),
        executor,
        ...this.options.builderOptions,
        now: this.options.now,
        signal,
        safetyIdentifier: this.options.safetyIdentifierForUser?.(supervisor.getRun(runId).userId),
        reserveModelCall: ({ model, inputTokenUpperBound, maxOutputTokens, round, attempt }) => supervisor.reserveModelBudget({
          runId, reservationId: sha256({ runId, agentExecutionId, round, attempt, purpose: "builder-model-call" }),
          agentExecutionId: agentExecutionId!,
          model, inputTokenUpperBound, maxOutputTokens,
        }),
        authorizeModelRetry: ({ error, attempt, failedAttempt, inputHash, cacheKey, reservationId, latencyMs }) => {
          if (signal.aborted) return false;
          const message = error instanceof Error ? error.message : String(error);
          const current = supervisor.getRun(runId);
          supervisor.recordModelCall({
            modelCallId: (this.options.idFactory ?? randomUUID)(), runId, agentExecutionId: agentExecutionId!,
            logicalTier: route.logicalTier, resolvedModel: route.model,
            promptTemplateVersion: CODEX_BUILDER_PROMPT_VERSION, inputContextRefs: [manifest.manifestHash, inputHash],
            outputSchemaVersion: null, cacheKey, cacheHit: null, latencyMs,
            inputTokens: null, outputTokens: null, retryCount: failedAttempt, status: "FAILED",
            createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
          }, reservationId);
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
          supervisor.recordModelCall({
            modelCallId: (this.options.idFactory ?? randomUUID)(),
            runId,
            agentExecutionId: agentExecutionId!,
            logicalTier: "GPT-5.6_SOL",
            resolvedModel: route.model,
            promptTemplateVersion: CODEX_BUILDER_PROMPT_VERSION,
            inputContextRefs: [manifest.manifestHash, observation.inputHash, observation.responseId],
            outputSchemaVersion: null,
            cacheKey: observation.cacheKey,
            cacheHit: observation.cachedInputTokens > 0,
            latencyMs: observation.latencyMs,
            inputTokens: observation.inputTokens,
            outputTokens: observation.outputTokens,
            cachedInputTokens: observation.cachedInputTokens,
            cacheWriteInputTokens: observation.cacheWriteInputTokens,
            retryCount: observation.retryCount,
            status: "SUCCEEDED",
            createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
          }, observation.reservationId);
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
      }));
      supervisor.recordAgentExecution({
        agentExecutionId,
        runId,
        role: "BUILDER",
        modelTier: "GPT-5.6_SOL",
        status: "SUCCEEDED",
        inputHash: sha256(manifest),
        outputArtifactId: artifact.artifactId,
        startedAt: agentStartedAt,
        completedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      });
      transition("FAST_CHECKS", "BUILDER_IMPLEMENTATION_FINISHED", [artifact.artifactId, integrity.artifact.artifactId]);
      return result;
    } catch (error) {
      const run = supervisor.getRun(runId);
      const budgetExhausted = error instanceof RuntimeBudgetExhaustedError;
      const testIntegrityFailure = error instanceof TestIntegrityViolationError;
      const domain = executionFailureDomain(run.state, error);
      const policy = testIntegrityFailure
        ? { failureClass: "SECURITY_FAILURE" as const, reasonCode: error.reasonCode, retryable: false }
        : budgetExhausted
        ? { failureClass: "WORKFLOW_FAILURE" as const, reasonCode: "RUNTIME_BUDGET_EXHAUSTED", retryable: false }
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
        ],
        createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
      }));
      if (agentExecutionId && agentStartedAt) {
        supervisor.recordAgentExecution({
          agentExecutionId,
          runId,
          role: "BUILDER",
          modelTier: "GPT-5.6_SOL",
          status: "FAILED",
          inputHash: sha256(supervisor.getManifest(runId)),
          outputArtifactId: null,
          startedAt: agentStartedAt,
          completedAt: (this.options.now ?? (() => new Date()))().toISOString(),
        });
      }
      const sandboxStates = new Set([
        "SANDBOX_WARM_CLAIMING", "SANDBOX_WARM_VALIDATING", "SANDBOX_WARM_CLAIMED",
        "SANDBOX_COLD_PROVISIONING", "SANDBOX_PROVISIONING", "SANDBOX_PREFLIGHT", "SANDBOX_PREWARM_INVALID",
      ]);
      const next = testIntegrityFailure && canTransition(run.state, "SECURITY_ESCALATION")
        ? "SECURITY_ESCALATION"
        : budgetExhausted && canTransition(run.state, "RETRY_BUDGET_EXHAUSTED")
        ? "RETRY_BUDGET_EXHAUSTED"
        : sandboxStates.has(run.state) || run.state === "CONTEXT_BUILDING"
        ? "BLOCKED_BY_ENVIRONMENT"
        : run.state === "IMPLEMENTING"
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
            ? "RUNTIME_BUDGET_EXHAUSTED"
            : next === "FAILED" ? "CODEX_BUILDER_FAILED" : "SANDBOX_OR_CONTEXT_FAILED",
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
      if (heartbeatTimer) clearInterval(heartbeatTimer);
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
    }
  }

  private persistSandboxCheckpoint(manifestHash: string, provisioned: ProvisionedSandbox): void {
    const content = {
      checkpointVersion: 1 as const,
      runId: provisioned.record.runId,
      manifestHash,
      workspace: provisioned.workspace,
      sandbox: provisioned.record,
      createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
    const checkpoint = SandboxWorkspaceCheckpointSchema.parse({ ...content, checkpointHash: sha256(content) });
    this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId: checkpoint.runId,
      type: "SANDBOX_WORKSPACE_CHECKPOINT",
      bytes: JSON.stringify(checkpoint),
      producerType: "SYSTEM",
      producerId: "engineer-execution-manager",
      trusted: true,
    }));
  }
}
