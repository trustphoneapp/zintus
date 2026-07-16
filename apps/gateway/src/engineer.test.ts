import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineerPlanningCancelledError, EngineerPlanningTimeoutError, EngineerSupervisor, LocalArtifactStore } from "@zintus/engineer";
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
  test("keeps owned cancellation available when repository admission becomes stale", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-stale-cancel-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    supervisor.receiveRequest({ runId: "stale-cancel", userId: principal.ownerId, repository, request: "Stop safely" });
    const manager = new EngineerRunManager({
      supervisor,
      principal,
      preflight: preflight(probe({ repository: async () => ({ readable: true, exactBaseCommit: false }) })),
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
    });
    await manager.cancel(principal, "stale-cancel", "User requested cancellation after the base advanced.");
    expect(supervisor.getRun("stale-cancel").state).toBe("CANCELLED");
    expect(supervisor.listEvents("stale-cancel").map((event) => event.nextState)).toEqual(["CANCELLATION_PENDING", "CANCELLED"]);
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("resumes cleanup idempotently after restart strands cancellation pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-resume-cancel-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    let run = supervisor.receiveRequest({ runId: "pending-cancel", userId: principal.ownerId, repository, request: "Stop safely" });
    run = supervisor.transition({
      runId: run.runId, expectedStateVersion: run.stateVersion, nextState: "CANCELLATION_PENDING",
      reasonCode: "USER_CANCELLATION_REQUESTED", idempotencyKey: "interrupted-cancel",
    }).run;
    expect(run.state).toBe("CANCELLATION_PENDING");
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
    });
    await manager.cancel(principal, run.runId, "Resume interrupted cleanup.");
    expect(supervisor.getRun(run.runId).state).toBe("CANCELLED");
    expect(supervisor.listEvents(run.runId).at(-1)).toMatchObject({ nextState: "CANCELLED", reasonCode: "RUN_CLEANUP_COMPLETE" });
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("cancels an active planning request instead of disabling the stop path", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-active-plan-cancel-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    supervisor.receiveRequest({ runId: "active-plan-cancel", userId: principal.ownerId, repository, request: "Plan then stop" });
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => { signalReady = resolve; });
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      artifactStore: new LocalArtifactStore({ root: join(root, "artifacts") }),
      context: { build: async () => ({}) } as never,
      planning: { plan: (_runId: string, signal?: AbortSignal) => {
        signalReady();
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } } as never,
    });
    const planning = manager.plan(principal, "active-plan-cancel");
    await ready;
    await manager.cancel(principal, "active-plan-cancel", "Stop during planning");
    await expect(planning).rejects.toBeInstanceOf(EngineerPlanningCancelledError);
    expect(manager.get("active-plan-cancel")).toMatchObject({ run: { state: "CANCELLED" }, lastError: null });
    expect(supervisor.listFailures("active-plan-cancel")).toEqual([]);
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("durably enters planning and persists a retryable pipeline failure across manager restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-durable-planning-error-"));
    const dbPath = join(root, "engineer.db");
    const supervisor = new EngineerSupervisor({ dbPath });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    supervisor.receiveRequest({ runId: "durable-plan", userId: principal.ownerId, repository, request: "Plan work" });
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      context: { build: async () => ({}) } as never,
      planning: { plan: async () => { throw new Error("planner response was malformed"); } } as never,
    });
    await expect(manager.plan(principal, "durable-plan")).rejects.toThrow("planner response was malformed");
    expect(supervisor.getRun("durable-plan").state).toBe("REPLANNING");
    expect(supervisor.listEvents("durable-plan").map((event) => event.nextState)).toEqual(["REQUEST_NORMALIZED", "PLANNING", "REPLANNING"]);
    expect(manager.snapshot(principal, "durable-plan").data.errors).toEqual([]);
    supervisor.close();

    const reopened = new EngineerSupervisor({ dbPath });
    const restarted = new EngineerRunManager({ supervisor: reopened, principal, preflight: preflight() });
    expect(restarted.get("durable-plan").lastError).toBe("planner response was malformed");
    reopened.close(); rmSync(root, { recursive: true, force: true });
  });

  test("terminates a timed-out planning attempt with an exact durable event", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-planning-timeout-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    supervisor.receiveRequest({ runId: "timed-plan", userId: principal.ownerId, repository, request: "Plan work" });
    const manager = new EngineerRunManager({
      supervisor, principal, preflight: preflight(),
      context: { build: async () => ({}) } as never,
      planning: { plan: async () => { throw new EngineerPlanningTimeoutError(120_000); } } as never,
    });
    await expect(manager.plan(principal, "timed-plan")).rejects.toBeInstanceOf(EngineerPlanningTimeoutError);
    expect(manager.get("timed-plan")).toMatchObject({ run: { state: "FAILED" }, lastError: "Evidence planning exceeded the 120000ms execution limit" });
    expect(supervisor.listEvents("timed-plan").at(-1)).toMatchObject({ nextState: "FAILED", reasonCode: "PLANNING_STEP_TIMED_OUT" });
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("keeps the legacy run list complete while exposing explicit bounded pages", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-run-list-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    for (let index = 0; index < 105; index += 1) {
      supervisor.receiveRequest({
        runId: `run-${String(index).padStart(3, "0")}`, userId: principal.ownerId,
        repository, request: `work ${index}`,
      });
    }
    supervisor.receiveRequest({
      runId: "other-owner-run", userId: "other-owner",
      repository: { ...repository, repositoryId: "repo-other", name: "other-fixture" }, request: "other",
    });
    const manager = new EngineerRunManager({ supervisor, principal, preflight: preflight() });
    const legacy = manager.list(principal);
    expect(legacy).toHaveLength(105);
    expect(legacy[0]?.runId).toBe("run-104");
    const page = manager.listPage(principal, { limit: 20 });
    expect(page.runs).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });

  test("retries a mixed read and returns status, events, and fence from one run version", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-engineer-snapshot-fence-"));
    const supervisor = new EngineerSupervisor({ dbPath: join(root, "engineer.db") });
    const principal = deriveEngineerPrincipal({ gatewayIdentitySecret: "owner-secret" });
    supervisor.receiveRequest({ runId: "snapshot-run", userId: principal.ownerId, repository, request: "work" });
    const manager = new EngineerRunManager({ supervisor, principal, preflight: preflight() });
    const listEvents = supervisor.listEvents.bind(supervisor);
    let injected = false;
    let eventReads = 0;
    supervisor.listEvents = ((runId, afterSequence, limit) => {
      eventReads += 1;
      if (!injected) {
        injected = true;
        supervisor.transition({
          runId, expectedStateVersion: 0, nextState: "REQUEST_NORMALIZED",
          reasonCode: "REQUEST_NORMALIZED", idempotencyKey: "snapshot-race",
        });
      }
      return listEvents(runId, afterSequence, limit);
    }) as typeof supervisor.listEvents;
    const snapshot = manager.snapshot(principal, "snapshot-run");
    expect(eventReads).toBe(2);
    expect(snapshot.status.run).toMatchObject({ state: "REQUEST_NORMALIZED", stateVersion: 1 });
    expect(snapshot.latestEventSequence).toBe(1);
    expect(snapshot.events.at(-1)).toMatchObject({ sequence: 1, nextState: "REQUEST_NORMALIZED", stateVersion: 1 });
    expect(snapshot.snapshotFence).toEqual({ stateVersion: 1, eventSequence: 1 });
    supervisor.close(); rmSync(root, { recursive: true, force: true });
  });


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

  test("caches successful readiness briefly and revalidates local execution boundaries after TTL", async () => {
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
    let nowMs = 10_000;
    const runtimeGate = new EngineerCapabilityPreflight({
      models: ["exact-model"], publicationEnabled: false, repository: canonicalRepository,
      execution: { imageReference: `registry.example/zintus/engineer@sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` },
      probe: probe({ image: async () => ({ exactDigest: exactImage }) }),
      successTtlMs: 1_000, now: () => nowMs,
    });
    await runtimeGate.assertRunAdmission(repository);
    exactImage = false;
    await expect(runtimeGate.assertRunAdmission(repository)).resolves.toBeUndefined();
    nowMs += 1_001;
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
    let nowMs = 20_000;
    const changingPublication = new EngineerCapabilityPreflight({
      models: ["gpt-sol", "gpt-terra", "gpt-luna"], publicationEnabled: true,
      repository: canonicalRepository,
      probe: probe({ publication: async () => ({ available: publicationReady, pullRequestsWritable: publicationReady }) }),
      successTtlMs: 1_000, now: () => nowMs,
    });
    await changingPublication.assertStartup();
    publicationReady = false;
    await expect(changingPublication.assertStartup()).resolves.toBeUndefined();
    nowMs += 1_001;
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
