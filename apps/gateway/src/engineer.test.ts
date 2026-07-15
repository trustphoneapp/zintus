import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineerSupervisor } from "@zintus/engineer";
import { EngineerRunManager } from "./engineer.js";
import { deriveEngineerPrincipal, loadOrCreateEngineerPrincipal } from "./engineer-identity.js";
import { createLocalEngineerCapabilityProbe, EngineerCapabilityPreflight, type EngineerCapabilityProbe } from "./engineer-preflight.js";

const repository = {
  repositoryId: "repo-1", provider: "local" as const, owner: "local", name: "fixture",
  baseBranch: "main", baseCommitSha: "1".repeat(40),
};
const canonicalRepository = { ...repository, originUrl: "file:///fixture" };

function probe(overrides: Partial<EngineerCapabilityProbe> = {}): EngineerCapabilityProbe {
  return {
    model: async () => ({ available: true, responsesApi: true, strictStructuredOutputs: true }),
    docker: async () => ({ available: true }),
    image: async () => ({ exactDigest: true }),
    repository: async () => ({ readable: true, exactBaseCommit: true }),
    publication: async () => ({ available: true, pullRequestsWritable: true }),
    ...overrides,
  };
}

function preflight(customProbe = probe(), publicationEnabled = false): EngineerCapabilityPreflight {
  return new EngineerCapabilityPreflight({
    models: ["gpt-sol", "gpt-terra", "gpt-luna"], publicationEnabled,
    repository: canonicalRepository, probe: customProbe,
  });
}

describe("Engineer trusted identity and admission", () => {
  test("derives stable pseudonymous authority without exposing the subject", () => {
    const first = deriveEngineerPrincipal({ gatewayIdentitySecret: "server-secret", authenticatedSubject: "person@example.com" });
    const replay = deriveEngineerPrincipal({ gatewayIdentitySecret: "server-secret", authenticatedSubject: "person@example.com" });
    const other = deriveEngineerPrincipal({ gatewayIdentitySecret: "server-secret", authenticatedSubject: "other@example.com" });
    expect(first).toEqual(replay);
    expect(first).not.toEqual(other);
    expect(JSON.stringify(first)).not.toContain("person@example.com");
    expect(first.safetyIdentifier).toMatch(/^[a-f0-9]{64}$/);
  });

  test("persists install identity across restarts and separates installs", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-identity-"));
    const first = loadOrCreateEngineerPrincipal(join(root, "one", "identity.json"));
    const restarted = loadOrCreateEngineerPrincipal(join(root, "one", "identity.json"));
    const separate = loadOrCreateEngineerPrincipal(join(root, "two", "identity.json"));
    expect(restarted).toEqual(first);
    expect(separate).not.toEqual(first);
    rmSync(root, { recursive: true, force: true });
  });

  test("failed capability admission leaves the run ledger untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-preflight-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const gate = preflight(probe({ repository: async () => ({ readable: true, exactBaseCommit: false }) }));
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "server-secret" });
    const manager = new EngineerRunManager({ supervisor, preflight: gate, principal });
    await expect(manager.create(principal, { runId: "must-not-exist", repository, request: "Do work" }))
      .rejects.toThrow("exact base commit");
    expect(supervisor.listRuns()).toEqual([]);
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("requires exact model features and immutable execution image", async () => {
    const incapable = new EngineerCapabilityPreflight({
      models: ["exact-model"], publicationEnabled: false,
      repository: canonicalRepository,
      execution: { imageReference: "zintus/engineer", imageDigest: `sha256:${"a".repeat(64)}` },
      probe: probe({ model: async () => ({ available: true, responsesApi: true, strictStructuredOutputs: false }) }),
    });
    await expect(incapable.assertStartup()).rejects.toThrow("structured-output");

    const mutable = new EngineerCapabilityPreflight({
      models: ["exact-model"], publicationEnabled: false,
      repository: canonicalRepository, execution: { imageReference: "zintus/engineer", imageDigest: "latest" }, probe: probe(),
    });
    await expect(mutable.assertStartup()).rejects.toThrow("immutable sha256");
  });

  test("caches successful model readiness while revalidating local execution boundaries", async () => {
    let modelReady = true;
    const gate = preflight(probe({
      model: async () => ({ available: modelReady, responsesApi: modelReady, strictStructuredOutputs: modelReady }),
    }));
    await gate.assertStartup();
    expect(gate.readiness()).toEqual({ state: "READY", error: null });
    modelReady = false;
    await expect(gate.assertStartup()).resolves.toBeUndefined();
    expect(gate.readiness()).toEqual({ state: "READY", error: null });

    const canonical = preflight();
    await expect(canonical.assertRunAdmission({ ...repository, owner: "spoofed-owner" }))
      .rejects.toThrow("canonical fixture");

    let exactImage = true;
    const runtimeGate = new EngineerCapabilityPreflight({
      models: ["exact-model"], publicationEnabled: false, repository: canonicalRepository,
      execution: { imageReference: `registry.example/zintus/engineer@sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` },
      probe: probe({ image: async () => ({ exactDigest: exactImage }) }),
    });
    await runtimeGate.assertRunAdmission(repository);
    exactImage = false;
    await expect(runtimeGate.assertRunAdmission(repository)).rejects.toThrow("image digest");
    await expect(canonical.assertRunAdmission({ ...repository, baseCommitSha: "2".repeat(40) }))
      .rejects.toThrow("canonical fixture");
  });

  test("advances only the canonical base after a credentialed stale-base recovery", async () => {
    const gate = preflight();
    await gate.assertRunAdmission(repository);
    const advanced = { ...repository, baseCommitSha: "2".repeat(40) };
    gate.acceptAdvancedBase(repository.baseCommitSha, advanced);
    expect(gate.repository().baseCommitSha).toBe(advanced.baseCommitSha);
    await expect(gate.assertRunAdmission(advanced)).resolves.toBeUndefined();
    expect(() => gate.acceptAdvancedBase(advanced.baseCommitSha, { ...advanced, owner: "attacker" }))
      .toThrow("canonical repository identity");
    expect(() => gate.acceptAdvancedBase("3".repeat(40), { ...advanced, baseCommitSha: "4".repeat(40) }))
      .toThrow("advanced concurrently");
  });

  test("strict capability proof rejects extras, duplicates, wrong types, and model mismatch", async () => {
    const capability = (output: unknown[], responseModel = "exact-model") => createLocalEngineerCapabilityProbe({
      repositoryId: repository.repositoryId, repositoryRoot: tmpdir(), expectedOriginUrl: "file:///fixture",
      transport: async () => ({
        async create() { return { id: "probe", model: responseModel, output } as never; },
      }),
    }).model("exact-model");
    expect(await capability([{ type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: true }) }]))
      .toEqual({ available: true, responsesApi: true, strictStructuredOutputs: true });
    for (const invalid of [
      [{ type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: true, extra: true }) }],
      [{ type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: "true" }) }],
      [{ type: "function_call", name: "capability_ready", arguments: "{" }],
      [
        { type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: true }) },
        { type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: true }) },
      ],
    ]) {
      expect((await capability(invalid)).strictStructuredOutputs).toBe(false);
    }
    expect((await capability([{ type: "function_call", name: "capability_ready", arguments: JSON.stringify({ ready: true }) }], "different-model")).strictStructuredOutputs).toBe(false);
  });

  test("rechecks publication authority and rejects every forged principal mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-authority-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    const forged = deriveEngineerPrincipal({ gatewayIdentitySecret: "attacker-secret" });
    const deniedPublication = preflight(probe({ publication: async () => ({ available: true, pullRequestsWritable: false }) }), true);
    const deniedManager = new EngineerRunManager({ supervisor, principal, preflight: deniedPublication });
    await expect(deniedManager.create(principal, { runId: "no-publication", repository, request: "work" }))
      .rejects.toThrow("publication capability");
    expect(supervisor.listRuns()).toEqual([]);

    let publicationReady = true;
    const changingPublication = preflight(probe({ publication: async () => ({ available: publicationReady, pullRequestsWritable: publicationReady }) }), true);
    await changingPublication.assertStartup();
    publicationReady = false;
    await expect(changingPublication.assertStartup()).rejects.toThrow("publication capability");
    expect(changingPublication.readiness().state).toBe("FAILED");

    const manager = new EngineerRunManager({ supervisor, principal, preflight: preflight() });
    await manager.create(principal, { runId: "owned", repository, request: "work" });
    await expect(manager.create(forged, { runId: "forged", repository, request: "work" })).rejects.toThrow("untrusted");
    await expect(manager.plan(forged, "owned")).rejects.toThrow("untrusted");
    await expect(manager.start(forged, "owned")).rejects.toThrow("untrusted");
    await expect(manager.freeze(forged, "owned", { expectedStateVersion: 0, manifest: {} as never, idempotencyKey: "forged-freeze" })).rejects.toThrow("untrusted");
    await expect(manager.approve(forged, "owned", "forged")).rejects.toThrow("untrusted");
    await expect(manager.requestChanges(forged, "owned", "forged")).rejects.toThrow("untrusted");
    await expect(manager.reject(forged, "owned", "forged")).rejects.toThrow("untrusted");
    await expect(manager.extendApproval(forged, "owned", "forged", 60)).rejects.toThrow("untrusted");
    await expect(manager.cancel(forged, "owned", "forged")).rejects.toThrow("untrusted");
    expect(supervisor.getRun("owned").state).toBe("REQUEST_RECEIVED");
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("failed re-admission blocks plan and start before workflow mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-readmission-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    let ready = true;
    const gate = preflight(probe({
      repository: async () => ({ readable: ready, exactBaseCommit: ready }),
    }));
    const manager = new EngineerRunManager({ supervisor, principal, preflight: gate });
    await manager.create(principal, { runId: "admission-run", repository, request: "work" });
    const before = supervisor.getRun("admission-run");
    ready = false;
    await expect(manager.plan(principal, "admission-run")).rejects.toThrow("exact base commit");
    await expect(manager.start(principal, "admission-run")).rejects.toThrow("exact base commit");
    expect(supervisor.getRun("admission-run")).toEqual(before);
    expect(supervisor.listEvents("admission-run")).toEqual([]);
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });
});
