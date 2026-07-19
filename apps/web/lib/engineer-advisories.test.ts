import { afterEach, describe, expect, test } from "bun:test";
import {
  deferEngineerAdvisory,
  dismissEngineerAdvisory,
  listEngineerAdvisories,
  reopenEngineerAdvisory,
  type EngineerAdvisoryBacklogView,
} from "./engineer";

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });

const advisory: EngineerAdvisoryBacklogView = {
  advisoryId: `sha256:${"a".repeat(64)}`, severity: "MEDIUM", category: "hardening",
  description: "Optional edge case", recommendedChange: "Add a bounded check",
  file: null, lineStart: null, lineEnd: null, actionability: "AUDIT_ONLY",
  status: "OPEN", revision: 1, createdAt: "2026-07-18T10:00:00.000Z", updatedAt: "2026-07-18T10:00:00.000Z",
};

describe("Engineer advisory web client", () => {
  test("encodes typed list filters and returns the durable page", async () => {
    let captured = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = String(input);
      expect(init?.cache).toBe("no-store");
      return new Response(JSON.stringify({ schemaVersion: 1, materializationStatus: "COMPLETE", items: [advisory], nextCursor: "cursor-2" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    await expect(listEngineerAdvisories("run / 1", { limit: 2, cursor: "cursor one", status: "OPEN", actionability: "AUDIT_ONLY" }))
      .resolves.toEqual({ schemaVersion: 1, materializationStatus: "COMPLETE", items: [advisory], nextCursor: "cursor-2" });
    expect(captured).toContain("/runs/run%20%2F%201/advisories?");
    expect(captured).toContain("limit=2");
    expect(captured).toContain("cursor=cursor+one");
    expect(captured).toContain("status=OPEN");
    expect(captured).toContain("actionability=AUDIT_ONLY");
  });

  test("sends the exact lifecycle command to each advisory action", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ advisory }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const command = { expectedRevision: 1, idempotencyKey: "web-operation-1", rationale: null };
    await deferEngineerAdvisory("run-1", "advisory/1", command);
    await dismissEngineerAdvisory("run-1", "advisory/1", command);
    await reopenEngineerAdvisory("run-1", "advisory/1", command);
    expect(requests.map(({ url, body }) => ({ action: url.split("/").at(-1), encoded: url.includes("advisory%2F1"), body }))).toEqual([
      { action: "defer", encoded: true, body: command },
      { action: "dismiss", encoded: true, body: command },
      { action: "reopen", encoded: true, body: command },
    ]);
  });
});
