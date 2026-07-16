import { describe, expect, test } from "bun:test";
import { engineerObservabilitySnapshot } from "./observability.js";
import { EngineerSupervisor } from "./supervisor.js";

describe("Engineer observability scaling", () => {
  test("uses owner-scoped SQL projections and bounds detailed run health", () => {
    let tick = 0;
    const supervisor = new EngineerSupervisor({
      dbPath: ":memory:",
      now: () => new Date(Date.UTC(2026, 6, 15, 0, 0, tick++)),
    });
    const repository = {
      repositoryId: "repo", provider: "local" as const, owner: "local", name: "fixture",
      baseBranch: "main", baseCommitSha: "a".repeat(40),
    };
    try {
      for (let index = 0; index < 101; index += 1) {
        supervisor.receiveRequest({ runId: `owner-run-${index}`, userId: "owner", repository, request: `request ${index}` });
      }
      supervisor.receiveRequest({
        runId: "other-owner-run", userId: "other-owner",
        repository: { ...repository, repositoryId: "other-repo" }, request: "private other-owner run",
      });

      // The scalable path must not regress to N-runs × full-record/failure reads.
      supervisor.exportRunRecords = (() => { throw new Error("legacy full export called"); }) as typeof supervisor.exportRunRecords;
      supervisor.listFailures = (() => { throw new Error("per-run failure query called"); }) as typeof supervisor.listFailures;

      const snapshot = engineerObservabilitySnapshot(supervisor, new Date(Date.UTC(2026, 6, 15, 1)), "owner");
      expect(snapshot.totalRuns).toBe(101);
      expect(snapshot.runHealthTotal).toBe(101);
      expect(snapshot.runHealthTruncated).toBe(true);
      expect(snapshot.runHealth).toHaveLength(100);
      expect(snapshot.runHealth.some((run) => run.runId === "other-owner-run")).toBe(false);
    } finally {
      supervisor.close();
    }
  });
});
