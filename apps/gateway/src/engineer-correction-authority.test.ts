import { describe, expect, test } from "bun:test";
import type { Engine } from "@zintus/engine";
import type { GatewayConfig } from "./auth.js";
import { createGatewayHandler, type GatewayHandlerDeps } from "./handler.js";
import type { EngineerRunManager } from "./engineer.js";

// R8-3 — Resolution Desk is the SINGLE correction authority. Two audit findings:
//   P1 #2 — stale-base recovery must NOT create/plan/freeze/execute a replacement
//           run outside a Resolution Desk case/directive/budget authorization.
//   P1 #3 — the legacy human-gate approval WRITE routes (approve/request-changes/
//           reject/extend-approval/expire-approval) are dead 410-only surfaces and
//           are removed; only cancel + historical reads remain.

function fakeEngine(): Engine {
  return {
    async routeAndStream() {
      return { providerId: "groq", model: "m", traceId: "t", threadId: "th", compileTraceId: undefined,
        stream: (async function* () { yield "x"; })() };
    },
    async getProviderStatus() { return []; },
    getSavings: () => ({ byProvider: {}, total: 0 }),
    getQuotaRemaining: () => 1,
    getProviderStats: () => null,
    updatePolicy: () => {},
    probeProviders: async () => [],
    listThreads: () => [],
    getThreadMessages: () => [],
    createThread: () => ({ id: "t", title: "t", createdAt: new Date(), updatedAt: new Date() }),
    getTrace: () => null,
    getLastTrace: () => null,
    listTraces: () => [],
    getThreadState: () => null,
    getCompileTrace: () => null,
    listMemory: () => [],
    upsertMemory: (input) => ({ id: "m", threadId: input.threadId ?? null, key: input.key, value: input.value,
      source: input.source, scope: input.scope ?? "thread", projectId: input.projectId, pinned: input.pinned ?? false,
      createdAt: new Date(), updatedAt: new Date() }),
    updateMemory: () => null,
    deleteMemory: () => false,
    async compileThreadContext() { return { traceId: "0", messages: [] }; },
  };
}

function makeHandler(extraDeps: Partial<GatewayHandlerDeps>) {
  const config: GatewayConfig = { port: 8788, host: "127.0.0.1", token: "secret", corsOrigins: "*" };
  return createGatewayHandler({ engine: fakeEngine(), config, ...extraDeps });
}

const authHeaders = { Authorization: "Bearer secret", "Content-Type": "application/json" };

describe("R8-3 single correction authority", () => {
  test("P1 #2: POST recover-stale-base no longer creates a replacement run; it directs to the Resolution Desk (410 GONE)", async () => {
    let recoverStaleBaseCalled = false;
    const engineerRuns = {
      readiness: () => ({ state: "READY", error: null }),
      principal: () => ({ ownerId: "owner", reviewerId: "reviewer" }),
      recoverStaleBase: async () => {
        recoverStaleBaseCalled = true;
        return { supersededRun: {}, replacementRun: { runId: "recovery-should-never-exist" } };
      },
    } as unknown as EngineerRunManager;
    const handler = makeHandler({ engineerRuns });

    const response = await handler(new Request("http://x/v1/engineer/runs/stale-run/recover-stale-base", {
      method: "POST",
      headers: authHeaders,
    }));

    // The bypass must be closed: no replacement run may be created outside a desk case.
    expect(recoverStaleBaseCalled).toBe(false);
    expect(response.status).toBe(410);
    const body = await response.json() as { error?: { code?: string }; successor?: string };
    expect(body.error?.code).toBe("GONE");
    expect(body.successor).toBe("resolution-cases");
  });

  test("P1 #3: the legacy approval WRITE routes are removed (not routed to any approval authority)", async () => {
    const called: string[] = [];
    const engineerRuns = {
      readiness: () => ({ state: "READY", error: null }),
      principal: () => ({ ownerId: "owner", reviewerId: "reviewer" }),
      get: () => ({ run: { state: "HUMAN_APPROVAL_PENDING" } }),
      approve: async () => { called.push("approve"); return { status: "PUBLISHED" }; },
      requestChanges: async () => { called.push("requestChanges"); },
      reject: async () => { called.push("reject"); },
      extendApproval: async () => { called.push("extendApproval"); return { status: "PENDING" }; },
      expireApproval: async () => { called.push("expireApproval"); },
    } as unknown as EngineerRunManager;
    const handler = makeHandler({ engineerRuns });

    for (const action of ["approve", "request-changes", "reject", "extend-approval", "expire-approval"]) {
      const response = await handler(new Request(`http://x/v1/engineer/runs/stranded/${action}`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          reason: "legacy attempt", extensionSeconds: 60,
          expectedVerifiedCheckpointId: "c", expectedVerifiedCheckpointHash: "h", expectedApprovalRevision: 0,
        }),
      }));
      // The dead legacy authority route is gone: it neither succeeds (200) nor
      // tombstones (410) — it is not a route at all.
      expect(response.status).toBe(404);
    }
    // No legacy approval authority method was ever invoked.
    expect(called).toEqual([]);
  });

  test("P1 #3: cancel remains routed (the run's stop authority is preserved)", async () => {
    const cancelled: { reason: string | null } = { reason: null };
    const engineerRuns = {
      readiness: () => ({ state: "READY", error: null }),
      principal: () => ({ ownerId: "owner", reviewerId: "reviewer" }),
      get: () => ({ run: { state: "IMPLEMENTING" } }),
      cancel: async (_principal: unknown, _runId: string, reason: string) => { cancelled.reason = reason; },
    } as unknown as EngineerRunManager;
    const handler = makeHandler({ engineerRuns });

    const response = await handler(new Request("http://x/v1/engineer/runs/live/cancel", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ reason: "stop it" }),
    }));
    expect(response.status).toBe(200);
    expect(cancelled.reason).toBe("stop it");
  });
});
