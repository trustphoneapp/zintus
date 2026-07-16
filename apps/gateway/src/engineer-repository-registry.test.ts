import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineerSupervisor, sha256 } from "@zintus/engineer";
import { DurableEngineerRepositoryAdmissionRegistry, resolveLocalRepositoryHead } from "./engineer-repository-registry.js";

const canonical = {
  repositoryId: "repo-1", provider: "local" as const, owner: "local", name: "fixture",
  baseBranch: "main", baseCommitSha: "1".repeat(40), originUrl: "file:///fixture",
};

describe("Engineer repository admission registry", () => {
  test("resolves local HEAD only on the configured attached branch", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-head-"));
    execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Zintus Test"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@zintus.local"]);
    writeFileSync(join(root, "README.md"), "fixture\n");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    expect(resolveLocalRepositoryHead(root, "main")).toBe(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    expect(resolveLocalRepositoryHead(root, "release")).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  test("restart preserves an advanced base with stale or updated configured SHA and never rolls back", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-registry-restart-"));
    const dbPath = join(root, "engineer.db");
    const repositoryRoot = join(root, "repository");
    execFileSync("mkdir", [repositoryRoot]);
    execFileSync("git", ["-C", repositoryRoot, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", repositoryRoot, "config", "user.name", "Zintus Test"]);
    execFileSync("git", ["-C", repositoryRoot, "config", "user.email", "test@zintus.local"]);
    writeFileSync(join(repositoryRoot, "value.txt"), "one\n");
    execFileSync("git", ["-C", repositoryRoot, "add", "value.txt"]);
    execFileSync("git", ["-C", repositoryRoot, "commit", "-qm", "one"]);
    const firstSha = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const firstCanonical = { ...canonical, baseCommitSha: firstSha };
    const firstSupervisor = new EngineerSupervisor({ dbPath });
    new DurableEngineerRepositoryAdmissionRegistry({
      supervisor: firstSupervisor, ownerUserId: "user-1", canonical: firstCanonical, canonicalRepositoryRoot: repositoryRoot,
    });
    const stableEvidence = firstSupervisor.repositoryAdmission("user-1", canonical.repositoryId)!.authorizationEvidenceHash;
    writeFileSync(join(repositoryRoot, "value.txt"), "two\n");
    execFileSync("git", ["-C", repositoryRoot, "commit", "-qam", "two"]);
    const secondSha = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    firstSupervisor.close();

    const updatedEnvironmentSupervisor = new EngineerSupervisor({ dbPath });
    const updatedEnvironmentRegistry = new DurableEngineerRepositoryAdmissionRegistry({
      supervisor: updatedEnvironmentSupervisor, ownerUserId: "user-1",
      canonical: { ...firstCanonical, baseCommitSha: secondSha }, canonicalRepositoryRoot: repositoryRoot,
    });
    expect(updatedEnvironmentRegistry.primary().baseCommitSha).toBe(secondSha);
    updatedEnvironmentSupervisor.close();

    const staleEnvironmentSupervisor = new EngineerSupervisor({ dbPath });
    const staleEnvironmentRegistry = new DurableEngineerRepositoryAdmissionRegistry({
      supervisor: staleEnvironmentSupervisor, ownerUserId: "user-1", canonical: firstCanonical, canonicalRepositoryRoot: repositoryRoot,
    });
    expect(staleEnvironmentRegistry.primary().baseCommitSha).toBe(secondSha);
    expect(staleEnvironmentSupervisor.repositoryAdmission("user-1", canonical.repositoryId)!.authorizationEvidenceHash).toBe(stableEvidence);
    staleEnvironmentSupervisor.close();

    execFileSync("git", ["-C", repositoryRoot, "reset", "--hard", "-q", firstSha]);
    const rollbackSupervisor = new EngineerSupervisor({ dbPath });
    expect(() => new DurableEngineerRepositoryAdmissionRegistry({
      supervisor: rollbackSupervisor, ownerUserId: "user-1", canonical: firstCanonical, canonicalRepositoryRoot: repositoryRoot,
    })).toThrow("roll back or diverge");
    expect(rollbackSupervisor.repositoryAdmission("user-1", canonical.repositoryId)!.repository.baseCommitSha).toBe(secondSha);
    rollbackSupervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("restart migrates only exact legacy configured evidence and rejects tampering", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-registry-evidence-"));
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:" });
    const repository = {
      repositoryId: canonical.repositoryId, provider: canonical.provider, owner: canonical.owner, name: canonical.name,
      url: canonical.originUrl, baseBranch: canonical.baseBranch, baseCommitSha: canonical.baseCommitSha,
    };
    const admissionId = `configured:${sha256({ ownerUserId: "user-1", repositoryId: canonical.repositoryId })}`;
    const legacy = sha256({ source: "gateway-environment", repository });
    const stable = sha256({
      source: "gateway-environment", ownerUserId: "user-1",
      repository: { repositoryId: repository.repositoryId, provider: repository.provider, owner: repository.owner,
        name: repository.name, url: repository.url, baseBranch: repository.baseBranch },
    });
    supervisor.registerRepositoryAdmission({
      admissionId, ownerUserId: "user-1", repository, source: "CONFIGURED_CANONICAL",
      authorizationSubject: "gateway-environment", authorizationEvidenceHash: legacy,
    });
    new DurableEngineerRepositoryAdmissionRegistry({
      supervisor, ownerUserId: "user-1", canonical, canonicalRepositoryRoot: root,
    });
    expect(supervisor.repositoryAdmission("user-1", canonical.repositoryId)!.authorizationEvidenceHash).toBe(stable);
    supervisor.close();

    const tamperedSupervisor = new EngineerSupervisor({ dbPath: ":memory:" });
    tamperedSupervisor.registerRepositoryAdmission({
      admissionId, ownerUserId: "user-1", repository, source: "CONFIGURED_CANONICAL",
      authorizationSubject: "gateway-environment", authorizationEvidenceHash: sha256("tampered"),
    });
    expect(() => new DurableEngineerRepositoryAdmissionRegistry({
      supervisor: tamperedSupervisor, ownerUserId: "user-1", canonical, canonicalRepositoryRoot: root,
    })).toThrow("does not match stable or exact legacy");
    tamperedSupervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("admits configured canonical repository and rejects unknown or substituted identities", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-registry-"));
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:" });
    const registry = new DurableEngineerRepositoryAdmissionRegistry({
      supervisor, ownerUserId: "user-1", canonical, canonicalRepositoryRoot: root,
    });
    expect(registry.list()).toEqual([registry.primary()]);
    expect(registry.require(registry.primary())).toEqual(registry.primary());
    expect(() => registry.require({ ...registry.primary(), repositoryId: "unknown" })).toThrow("not in");
    expect(() => registry.require({ ...registry.primary(), owner: "attacker" })).toThrow("does not match");
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("does not accept connector repositories without a server verifier", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-registry-"));
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:" });
    const registry = new DurableEngineerRepositoryAdmissionRegistry({
      supervisor, ownerUserId: "user-1", canonical, canonicalRepositoryRoot: root,
    });
    expect(() => registry.registerConnectorAuthorized({
      grantId: "grant-1", ownerUserId: "user-1", connectorId: "github:installation-1",
      repository: { ...registry.primary(), repositoryId: "repo-2", name: "other" }, repositoryRoot: root,
      evidenceHash: sha256("grant"), generation: 1, expiresAt: "2099-01-01T00:00:00.000Z",
    })).toThrow("unavailable or invalid");
    expect(supervisor.repositoryAdmission("user-1", "repo-2")).toBeNull();
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("accepts only owner-bound, unexpired, server-verified connector grants", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-registry-"));
    let now = new Date("2026-07-15T00:00:00.000Z");
    const supervisor = new EngineerSupervisor({ dbPath: ":memory:", now: () => now });
    const registry = new DurableEngineerRepositoryAdmissionRegistry({
      supervisor, ownerUserId: "user-1", canonical, canonicalRepositoryRoot: root,
      now: () => now,
      verifyConnectorAuthorization: (grant) => grant.grantId === "signed-grant",
    });
    const connectorRepository = {
      repositoryId: "repo-2", provider: "github" as const, owner: "acme", name: "other",
      url: "https://github.com/acme/other.git", baseBranch: "main", baseCommitSha: "2".repeat(40),
    };
    expect(() => registry.registerConnectorAuthorized({
      grantId: "signed-grant", ownerUserId: "user-1", connectorId: "github:installation-1",
      repository: connectorRepository, repositoryRoot: root, evidenceHash: sha256("signed"), generation: 1, expiresAt: "invalid",
    })).toThrow("invalid or expired");
    registry.registerConnectorAuthorized({
      grantId: "signed-grant", ownerUserId: "user-1", connectorId: "github:installation-1",
      repository: connectorRepository, repositoryRoot: root, evidenceHash: sha256("signed"), generation: 1,
      expiresAt: "2026-07-15T00:05:00.000Z",
    });
    expect(registry.require(connectorRepository)).toEqual(connectorRepository);
    expect(registry.list()).toHaveLength(2);
    now = new Date("2026-07-15T00:06:00.000Z");
    expect(registry.list()).toHaveLength(1);
    expect(() => registry.require(connectorRepository)).toThrow("not in");
    expect(registry.revokeConnector("repo-2").status).toBe("REVOKED");
    expect(() => registry.require(connectorRepository)).toThrow("not in");
    now = new Date("2026-07-15T00:07:00.000Z");
    expect(() => registry.reauthorizeConnectorAuthorized({
      grantId: "signed-grant", ownerUserId: "user-1", connectorId: "github:installation-1",
      repository: connectorRepository, repositoryRoot: root, evidenceHash: sha256("stale"), generation: 1,
      expiresAt: "2026-07-15T00:20:00.000Z",
    })).toThrow("generation");
    expect(registry.reauthorizeConnectorAuthorized({
      grantId: "signed-grant", ownerUserId: "user-1", connectorId: "github:installation-1",
      repository: connectorRepository, repositoryRoot: root, evidenceHash: sha256("renewed"), generation: 2,
      expiresAt: "2026-07-15T00:20:00.000Z",
    }).status).toBe("ACTIVE");
    expect(registry.require(connectorRepository)).toEqual(connectorRepository);
    const restartedRegistry = new DurableEngineerRepositoryAdmissionRegistry({
      supervisor, ownerUserId: "user-1", canonical, canonicalRepositoryRoot: root, now: () => now,
    });
    expect(restartedRegistry.list()).toHaveLength(1);
    expect(() => restartedRegistry.require(connectorRepository)).toThrow("not in");
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });
});
