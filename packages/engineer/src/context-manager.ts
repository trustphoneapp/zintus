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
  private readonly inFlight = new Map<string, Promise<StoredContextSnapshot>>();
  constructor(private readonly options: EngineerContextManagerOptions) {}

  async build(runId: string): Promise<StoredContextSnapshot> {
    const replay = this.options.supervisor.latestContextSnapshot(runId);
    if (replay) return replay;
    const active = this.inFlight.get(runId);
    if (active) return active;
    const operation = this.buildOnce(runId).finally(() => {
      if (this.inFlight.get(runId) === operation) this.inFlight.delete(runId);
    });
    this.inFlight.set(runId, operation);
    return operation;
  }

  private async buildOnce(runId: string): Promise<StoredContextSnapshot> {
    const replay = this.options.supervisor.latestContextSnapshot(runId);
    if (replay) return replay;
    const run = this.options.supervisor.getRun(runId);
    if (run.state !== "REQUEST_RECEIVED") throw new Error(`context build requires REQUEST_RECEIVED, not ${run.state}`);
    const manifest = await this.options.contextEngine.build({
      runId,
      repositoryId: run.repository.repositoryId,
      repositoryRoot: this.options.repositoryRootFor(run.repository.repositoryId),
      baseCommitSha: run.repository.baseCommitSha,
      request: run.requestOriginal,
    });
    const completedWhileScanning = this.options.supervisor.latestContextSnapshot(runId);
    if (completedWhileScanning) return completedWhileScanning;
    const artifactCandidate = this.options.artifactStore.put({
      runId,
      type: "CONTEXT_MANIFEST",
      bytes: JSON.stringify(manifest),
      producerType: "SYSTEM",
      producerId: "engineer-context",
      trusted: false,
    });
    let artifact = artifactCandidate;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        artifact = this.options.supervisor.recordArtifact(artifactCandidate);
        break;
      } catch (error) {
        const winner = this.options.supervisor.listArtifacts(runId)
          .find((item) => item.type === artifactCandidate.type && item.sha256 === artifactCandidate.sha256);
        if (winner) { artifact = winner; break; }
        if (!this.isConcurrentPersistenceError(error) || attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, 2 ** attempt)));
      }
    }
    const candidate = StoredContextSnapshotSchema.parse({
      manifest,
      artifactId: artifact.artifactId,
      // The deduplicated artifact is the durable convergence point across
      // Supervisor/process instances, so its timestamp must also win.
      createdAt: artifact.createdAt,
    });
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return this.options.supervisor.recordContextSnapshot(candidate);
      } catch (error) {
        lastError = error;
        const winner = this.options.supervisor.latestContextSnapshot(runId);
        if (winner) {
          if (winner.manifest.manifestHash === candidate.manifest.manifestHash) return winner;
          throw error;
        }
        if (!this.isConcurrentPersistenceError(error) || attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, 2 ** attempt)));
      }
    }
    throw lastError;
  }

  private isConcurrentPersistenceError(error: unknown): boolean {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    const message = error instanceof Error ? error.message : String(error);
    return /SQLITE_BUSY|SQLITE_LOCKED|SQLITE_CONSTRAINT/.test(code) ||
      /database is (?:locked|busy)|unique constraint failed/i.test(message);
  }
}
