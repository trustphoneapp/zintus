import {
  RepositoryReferenceSchema,
  TaskManifestContentSchema,
  type EngineerExecutionManager,
  type EngineerPublicationManager,
  type EngineerPlanningManager,
  type EngineerVerificationManager,
  type EngineerRun,
  type EngineerSupervisor,
  type RepositoryReference,
  type TaskManifestContent,
  engineerObservabilitySnapshot,
} from "@zintus/engineer";

export interface EngineerRunManagerOptions {
  supervisor: EngineerSupervisor;
  execution?: EngineerExecutionManager;
  verification?: EngineerVerificationManager;
  publication?: EngineerPublicationManager;
  diffForRun?: (runId: string) => string;
  planning?: EngineerPlanningManager;
}

/** Gateway facade. It exposes no generic state-transition endpoint. */
export class EngineerRunManager {
  private readonly options: EngineerRunManagerOptions;
  private readonly errors = new Map<string, string>();

  constructor(options: EngineerRunManagerOptions) {
    this.options = options;
  }

  create(input: {
    runId?: string;
    userId: string;
    userEmail?: string;
    repository: RepositoryReference;
    request: string;
  }): EngineerRun {
    return this.options.supervisor.receiveRequest({
      ...input,
      repository: RepositoryReferenceSchema.parse(input.repository),
    });
  }

  get(runId: string): { run: EngineerRun; lastError: string | null } {
    return { run: this.options.supervisor.getRun(runId), lastError: this.errors.get(runId) ?? null };
  }

  observability() { return engineerObservabilitySnapshot(this.options.supervisor); }

  freeze(runId: string, input: {
    expectedStateVersion: number;
    manifest: TaskManifestContent;
    actorId: string;
    idempotencyKey: string;
  }): EngineerRun {
    return this.options.supervisor.freezePlan({
      runId,
      expectedStateVersion: input.expectedStateVersion,
      manifest: TaskManifestContentSchema.parse(input.manifest),
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
    }).run;
  }

  plan(runId: string) {
    if (!this.options.planning) throw new Error("Engineer planning is not configured on this gateway");
    return this.options.planning.plan(runId);
  }

  planProposal(runId: string) {
    return this.options.supervisor.latestPlanProposal(runId);
  }

  start(runId: string): EngineerRun {
    if (!this.options.execution) throw new Error("Engineer execution is not configured on this gateway");
    const run = this.options.execution.enqueue(runId);
    this.errors.delete(runId);
    setTimeout(() => {
      this.options.execution!.runQueued(runId).then(async () => {
        if (this.options.verification) await this.options.verification.verify(runId);
        if (this.options.publication && this.options.supervisor.getRun(runId).state === "REVIEW_APPROVED") {
          await this.options.publication.start(runId);
        }
      }).catch((error) => {
        this.errors.set(runId, error instanceof Error ? error.message : String(error));
      });
    }, 0);
    return run;
  }

  events(runId: string) {
    return this.options.supervisor.listEvents(runId);
  }

  artifacts(runId: string) {
    return this.options.supervisor.listArtifacts(runId);
  }

  claims(runId: string) {
    return this.options.supervisor.listClaimEvidence(runId);
  }

  evidenceBundles(runId: string) {
    return this.options.supervisor.listEvidenceBundles(runId);
  }

  tests(runId: string) { return this.options.supervisor.listTestExecutions(runId); }

  security(runId: string) { return this.options.supervisor.listSecurityFindings(runId); }

  failures(runId: string) { return this.options.supervisor.listFailures(runId); }

  diff(runId: string) {
    if (!this.options.diffForRun) throw new Error("Engineer diff is not available on this gateway");
    return this.options.diffForRun(runId);
  }

  approval(runId: string) {
    return this.options.supervisor.latestApprovalRequest(runId);
  }

  approve(runId: string, actorId: string, reason: string) {
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    return this.options.publication.approve(runId, actorId, reason);
  }

  requestChanges(runId: string, actorId: string, reason: string): void {
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    this.options.publication.requestChanges(runId, actorId, reason);
  }

  reject(runId: string, actorId: string, reason: string): void {
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    this.options.publication.reject(runId, actorId, reason);
  }

  extendApproval(runId: string, actorId: string, reason: string, extensionSeconds: number) {
    if (!this.options.publication) throw new Error("Engineer publication is not configured on this gateway");
    return this.options.publication.extend(runId, actorId, reason, extensionSeconds);
  }

  cancel(runId: string, actorId: string, reason: string): Promise<void> {
    if (!this.options.publication) throw new Error("Engineer control is not configured on this gateway");
    return this.options.publication.cancel(runId, actorId, reason);
  }

  subscribe(runId: string): ReadableStream<Uint8Array> {
    this.options.supervisor.getRun(runId);
    const encoder = new TextEncoder();
    let nextSequence = 1;
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    const pump = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (closed) return;
      const events = this.options.supervisor.listEvents(runId).filter((event) => event.sequence >= nextSequence);
      for (const event of events) {
        controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`));
        nextSequence = event.sequence + 1;
      }
      const state = this.options.supervisor.getRun(runId).state;
      if ([
        ...(!this.options.publication ? ["REVIEW_APPROVED"] : []),
        "COMPLETED", "REJECTED", "CANCELLED", "TIMED_OUT", "RETRY_BUDGET_EXHAUSTED",
        "BLOCKED_BY_ENVIRONMENT", "BLOCKED_BY_EXTERNAL_DEPENDENCY", "SECURITY_ESCALATION",
        "HUMAN_REVIEW_REQUIRED", "VERIFICATION_INCOMPLETE", "ROLLED_BACK", "FAILED",
      ].includes(state)) {
        if (timer) clearInterval(timer);
        closed = true;
        controller.close();
      }
    };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        pump(controller);
        if (!closed) {
          timer = setInterval(() => pump(controller), 250);
          timer.unref?.();
        }
      },
      cancel: () => { if (timer) clearInterval(timer); },
    });
  }
}
