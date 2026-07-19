import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "./artifact-store.js";
import { EngineerSupervisor } from "./supervisor.js";

describe("Engineer run pagination", () => {
  test("pages newest-first within one owner without scanning another owner", () => {
    let tick = 0;
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:", now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
    const repository = { repositoryId: "repo", provider: "local" as const, owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "a".repeat(40) };
    for (const runId of ["run-1", "run-2", "run-3", "run-4"]) supervisor.receiveRequest({ runId, userId: "owner", repository, request: runId });
    supervisor.receiveRequest({ runId: "other-run", userId: "other-owner", repository: { ...repository, repositoryId: "other-repo" }, request: "other" });
    const first = supervisor.listRunsForUser("owner", 2);
    expect(first.map((run) => run.runId)).toEqual(["run-4", "run-3"]);
    const second = supervisor.listRunsForUser("owner", 2, { createdAt: first[1]!.createdAt, runId: first[1]!.runId });
    expect(second.map((run) => run.runId)).toEqual(["run-2", "run-1"]);
    supervisor.close();
  });

  test("pages whitelisted durable run records without changing their order or contents", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-run-record-page-"));
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:" });
    try {
      const repository = { repositoryId: "repo", provider: "local" as const, owner: "local", name: "fixture", baseBranch: "main", baseCommitSha: "a".repeat(40) };
      supervisor.receiveRequest({ runId: "run-1", userId: "owner", repository, request: "export records" });
      const store = new LocalArtifactStore({ root, idFactory: (() => { let id = 0; return () => `artifact-${++id}`; })() });
      for (const content of ["first", "second", "third"]) {
        supervisor.recordArtifact(store.put({
          runId: "run-1", type: "COMMAND_STDOUT", bytes: content,
          producerType: "EXECUTOR", producerId: "executor", trusted: true,
        }));
      }

      const first = supervisor.exportRunRecordPage("run-1", "artifacts", 0, 2);
      const second = supervisor.exportRunRecordPage("run-1", "artifacts", 2, 2);
      expect([...first, ...second]).toEqual(supervisor.exportRunRecords("run-1").artifacts ?? []);
      expect(supervisor.exportRunRecordTables("run-1")).toContain("approval_decisions");
      for (const table of ["advisory_backlog_items", "hardening_quotes", "hardening_consents", "engineer_run_lineage", "advisory_backlog_events", "publication_candidate_selections"] as const) {
        expect(supervisor.exportRunRecordTables("run-1")).toContain(table);
        expect(supervisor.exportRunRecordPage("run-1", table, 0, 10)).toEqual([]);
      }
      expect(supervisor.exportRunRecordTables("run-1")).not.toContain("candidate_lineage_attestations");
      expect(() => supervisor.exportRunRecordPage("run-1", "not_a_table" as "artifacts", 0, 1)).toThrow("unknown run export table");
    } finally {
      supervisor.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
