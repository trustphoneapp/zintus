import { describe, expect, test } from "bun:test";
import { EngineerSupervisor } from "./supervisor.js";
import { sha256 } from "./hash.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = {
  repositoryId: "repo-1", provider: "github" as const, owner: "acme", name: "payments",
  url: "https://github.com/acme/payments.git", baseBranch: "main", baseCommitSha: "1".repeat(40),
};

describe("durable repository admissions", () => {
  test("a run-created connection is never an admission", () => {
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:" });
    supervisor.receiveRequest({ userId: "user-1", repository, request: "inspect only" });
    expect(supervisor.repositoryAdmission("user-1", repository.repositoryId)).toBeNull();
    expect(supervisor.listRepositoryAdmissions("user-1")).toEqual([]);
    supervisor.close();
  });

  test("server admission is owner scoped, durable, idempotent, and immutable", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-admission-"));
    const dbPath = join(root, "engineer.db");
    const supervisor = new EngineerSupervisor({ dbPath, now: () => new Date("2026-07-15T00:00:00.000Z") });
    const input = {
      admissionId: "configured:repo-1", ownerUserId: "user-1", repository,
      source: "CONFIGURED_CANONICAL" as const, authorizationSubject: "gateway-environment",
      authorizationEvidenceHash: sha256({ repository }),
    };
    const admitted = supervisor.registerRepositoryAdmission(input);
    expect(admitted.status).toBe("ACTIVE");
    expect(supervisor.registerRepositoryAdmission(input)).toEqual(admitted);
    expect(supervisor.repositoryAdmission("user-2", repository.repositoryId)).toBeNull();
    expect(() => supervisor.registerRepositoryAdmission({ ...input, repository: { ...repository, owner: "attacker" } }))
      .toThrow("identity conflicts");
    expect(() => supervisor.registerRepositoryAdmission({ ...input, authorizationEvidenceHash: `sha256:${"a".repeat(64)}` }))
      .toThrow("conflicts with existing trusted record");
    supervisor.close();
    const restarted = new EngineerSupervisor({ dbPath });
    expect(restarted.repositoryAdmission("user-1", repository.repositoryId)).toEqual(admitted);
    restarted.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("base advance is compare-and-swap and revoked records stay closed", () => {
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:" });
    supervisor.registerRepositoryAdmission({
      admissionId: "configured:repo-1", ownerUserId: "user-1", repository,
      source: "CONFIGURED_CANONICAL", authorizationSubject: "gateway-environment",
      authorizationEvidenceHash: sha256({ repository }),
    });
    const advanced = supervisor.advanceRepositoryAdmissionBase({
      ownerUserId: "user-1", repositoryId: repository.repositoryId,
      previousBaseCommitSha: repository.baseCommitSha, nextBaseCommitSha: "2".repeat(40),
    });
    expect(advanced.repository.baseCommitSha).toBe("2".repeat(40));
    expect(() => supervisor.advanceRepositoryAdmissionBase({
      ownerUserId: "user-1", repositoryId: repository.repositoryId,
      previousBaseCommitSha: repository.baseCommitSha, nextBaseCommitSha: "3".repeat(40),
    })).toThrow("advanced concurrently");
    expect(supervisor.revokeRepositoryAdmission("user-1", repository.repositoryId).status).toBe("REVOKED");
    expect(() => supervisor.registerRepositoryAdmission({
      admissionId: "configured:repo-1", ownerUserId: "user-1", repository: { ...repository, baseCommitSha: "2".repeat(40) },
      source: "CONFIGURED_CANONICAL", authorizationSubject: "gateway-environment",
      authorizationEvidenceHash: sha256({ repository }),
    })).toThrow("cannot be reactivated");
    supervisor.close();
  });

  test("run intake rejects repository-id identity substitution", () => {
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:" });
    supervisor.receiveRequest({ userId: "user-1", repository, request: "first" });
    expect(() => supervisor.receiveRequest({
      userId: "user-1", repository: { ...repository, owner: "attacker" }, request: "second",
    })).toThrow("identity does not match");
    supervisor.close();
  });

  test("connector expiry and generation persist across explicit revoke and reauthorization", () => {
    let now = new Date("2026-07-15T00:00:00.000Z");
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:", now: () => now });
    const admitted = supervisor.registerRepositoryAdmission({
      admissionId: "connector:grant-1", ownerUserId: "user-1", repository,
      source: "CONNECTOR_AUTHORIZED", authorizationSubject: "github:installation-1",
      authorizationEvidenceHash: sha256("grant-1"), authorizationGeneration: 4,
      authorizationExpiresAt: "2026-07-15T00:10:00.000Z",
    });
    expect(admitted.authorizationGeneration).toBe(4);
    expect(admitted.authorizationExpiresAt).toBe("2026-07-15T00:10:00.000Z");
    expect(supervisor.revokeRepositoryAdmission("user-1", repository.repositoryId).status).toBe("REVOKED");
    now = new Date("2026-07-15T00:01:00.000Z");
    const renewed = supervisor.reauthorizeConnectorRepositoryAdmission({
      ownerUserId: "user-1", repositoryId: repository.repositoryId,
      previousGeneration: 4, nextGeneration: 5, authorizationSubject: "github:installation-2",
      authorizationEvidenceHash: sha256("grant-2"), authorizationExpiresAt: "2026-07-15T01:00:00.000Z",
    });
    expect(renewed.status).toBe("ACTIVE");
    expect(renewed.authorizationGeneration).toBe(5);
    expect(renewed.authorizationSubject).toBe("github:installation-2");
    expect(() => supervisor.reauthorizeConnectorRepositoryAdmission({
      ownerUserId: "user-1", repositoryId: repository.repositoryId,
      previousGeneration: 4, nextGeneration: 6, authorizationSubject: "github:installation-3",
      authorizationEvidenceHash: sha256("grant-3"), authorizationExpiresAt: "2026-07-15T02:00:00.000Z",
    })).toThrow("stale");
    supervisor.close();
  });
});
