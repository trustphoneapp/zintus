import type { LocalArtifactStore } from "./artifact-store.js";
import { StoredContextSnapshotSchema, type StoredContextSnapshot } from "./context-contracts.js";
import type { ContextEngine } from "./context-engine.js";
import type { EngineerSupervisor } from "./supervisor.js";

export interface EngineerContextManagerOptions {
  supervisor: EngineerSupervisor;
  contextEngine: ContextEngine;
  artifactStore: LocalArtifactStore;
  repositoryRootFor: (repositoryId: string) => string;
  now?: () => Date;
}

/** Builds, stores, and ledger-binds the only repository context accepted by planning. */
export class EngineerContextManager {
  constructor(private readonly options: EngineerContextManagerOptions) {}

  build(runId: string): StoredContextSnapshot {
    const replay = this.options.supervisor.latestContextSnapshot(runId);
    if (replay) return replay;
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "REQUEST_RECEIVED") throw new Error(`context build requires REQUEST_RECEIVED, not ${run.state}`);
    const manifest = this.options.contextEngine.build({
      runId,
      repositoryId: run.repository.repositoryId,
      repositoryRoot: this.options.repositoryRootFor(run.repository.repositoryId),
      baseCommitSha: run.repository.baseCommitSha,
      request: run.requestOriginal,
    });
    const artifact = this.options.supervisor.recordArtifact(this.options.artifactStore.put({
      runId,
      type: "CONTEXT_MANIFEST",
      bytes: JSON.stringify(manifest),
      producerType: "SYSTEM",
      producerId: "engineer-context",
      trusted: false,
    }));
    return this.options.supervisor.recordContextSnapshot(StoredContextSnapshotSchema.parse({
      manifest,
      artifactId: artifact.artifactId,
      createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
    }));
  }
}
