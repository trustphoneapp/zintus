import { randomUUID } from "node:crypto";
import type { BuilderResult, SandboxRecord } from "./execution-contracts.js";
import type { LocalArtifactStore } from "./artifact-store.js";
import type { CodexBuilderOptions, ResponsesTransport } from "./codex-builder.js";
import { CODEX_BUILDER_PROMPT_VERSION, CodexBuilder } from "./codex-builder.js";
import type { DockerSandboxManager, ProvisionedSandbox } from "./sandbox-manager.js";
import type { EngineerSupervisor } from "./supervisor.js";
import { TrustedCommandExecutor } from "./trusted-executor.js";
import { resolveEngineerModel } from "./model-routing.js";
import { sha256 } from "./hash.js";

export interface EngineerExecutionManagerOptions {
  supervisor: EngineerSupervisor;
  sandboxManager: DockerSandboxManager;
  artifactStore: LocalArtifactStore;
  repositoryRootFor: (repositoryId: string) => string;
  transportForRun: (runId: string) => ResponsesTransport | Promise<ResponsesTransport>;
  now?: () => Date;
  idFactory?: () => string;
  builderOptions?: Pick<CodexBuilderOptions, "modelConfiguration" | "maxRounds">;
}

/** Phase-2 worker: one Builder per run, deterministic state promotions, durable evidence records. */
export class EngineerExecutionManager {
  private readonly options: EngineerExecutionManagerOptions;
  private readonly active = new Map<string, Promise<BuilderResult>>();
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
    const promise = this.executeOnce(runId).finally(() => this.active.delete(runId));
    this.active.set(runId, promise);
    return promise;
  }

  recoverQueued(): Array<{ runId: string; promise: Promise<BuilderResult> }> {
    return this.options.supervisor.listRuns(["QUEUED"]).map((run) => ({
      runId: run.runId,
      promise: this.runQueued(run.runId),
    }));
  }

  getSandbox(runId: string): ProvisionedSandbox | null {
    return this.sandboxes.get(runId) ?? null;
  }

  destroy(runId: string): SandboxRecord | null {
    const sandbox = this.sandboxes.get(runId);
    if (!sandbox) return null;
    const destroyed = this.options.sandboxManager.destroy(sandbox);
    this.options.supervisor.recordSandbox(destroyed);
    this.sandboxes.delete(runId);
    return destroyed;
  }

  private async executeOnce(runId: string): Promise<BuilderResult> {
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
    try {
      if (this.options.sandboxManager.warmEnabled()) {
        transition("SANDBOX_WARM_CLAIMING", "WARM_SANDBOX_CLAIM_STARTED");
      } else {
        transition("SANDBOX_COLD_PROVISIONING", "COLD_SANDBOX_SELECTED");
      }
      const repositoryRoot = this.options.repositoryRootFor(initial.repository.repositoryId);
      if (this.options.sandboxManager.warmEnabled()) {
        const warmClaim = this.options.sandboxManager.claimWarm({
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
        provisioned = this.options.sandboxManager.provisionCold({
          runId,
          repositoryRoot,
          baseCommitSha: initial.repository.baseCommitSha,
        });
        transition("SANDBOX_PREFLIGHT", "SANDBOX_PROVISIONED");
        supervisor.recordSandbox(provisioned.record);
        transition("SANDBOX_READY", "SANDBOX_PREFLIGHT_PASSED", [provisioned.record.sandboxId]);
      }
      this.sandboxes.set(runId, provisioned);
      transition("CONTEXT_BUILDING", "BUILDER_CONTEXT_BUILDING");
      const manifest = supervisor.getManifest(runId);
      if (!manifest) throw new Error("frozen manifest is unavailable");
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
        currentCommit: () => this.options.sandboxManager.currentCommit(provisioned!.workspace),
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
            cacheHit: null,
            latencyMs: observation.latencyMs,
            inputTokens: observation.inputTokens,
            outputTokens: observation.outputTokens,
            retryCount: 0,
            status: "SUCCEEDED",
            createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
          });
        },
      });
      const result = await builder.run();
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
      transition("FAST_CHECKS", "BUILDER_IMPLEMENTATION_FINISHED", [artifact.artifactId]);
      return result;
    } catch (error) {
      const run = supervisor.getRun(runId);
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
      const next = sandboxStates.has(run.state) || run.state === "CONTEXT_BUILDING"
        ? "BLOCKED_BY_ENVIRONMENT"
        : run.state === "IMPLEMENTING"
          ? "FAILED"
          : null;
      if (next) {
        supervisor.transition({
          runId,
          expectedStateVersion: run.stateVersion,
          nextState: next,
          reasonCode: next === "FAILED" ? "CODEX_BUILDER_FAILED" : "SANDBOX_OR_CONTEXT_FAILED",
          manifestHash: run.manifestHash,
          idempotencyKey: `phase2:failure:${run.stateVersion + 1}`,
        });
      }
      if (provisioned && next === "BLOCKED_BY_ENVIRONMENT") {
        try {
          supervisor.recordSandbox(this.options.sandboxManager.destroy(provisioned));
        } catch { /* preserve original failure */ }
      }
      throw error;
    }
  }
}
