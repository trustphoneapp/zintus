import { afterEach, describe, expect, test } from "bun:test";
import { engineerDecision, extendEngineerApproval } from "./engineer";

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });

const authority = {
  expectedVerifiedCheckpointId: `sha256:${"a".repeat(64)}`,
  expectedVerifiedCheckpointHash: `sha256:${"b".repeat(64)}`,
  expectedApprovalRevision: 4,
};

describe("Engineer browser approval compare-and-swap", () => {
  test("sends the displayed checkpoint pair and revision on decisions and extensions", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    await engineerDecision("run-1", "approve", "Reviewed exact candidate", authority);
    await extendEngineerApproval("run-1", "Need more review time", authority, 60);
    expect(requests).toEqual([
      { url: expect.stringContaining("/v1/engineer/runs/run-1/approve"), body: { reason: "Reviewed exact candidate", ...authority } },
      { url: expect.stringContaining("/v1/engineer/runs/run-1/extend-approval"), body: { reason: "Need more review time", extensionSeconds: 60, ...authority } },
    ]);
  });

  test("blocks a decision locally when no displayed authority is available", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response("{}"); }) as unknown as typeof fetch;
    await expect(engineerDecision("run-1", "reject", "Reject stale view"))
      .rejects.toThrow("Refresh the approval before deciding");
    expect(calls).toBe(0);
  });

  test("surfaces the actionable server conflict instead of a generic failure", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: {
        code: "ENGINEER_CANDIDATE_CHANGED",
        message: "Candidate changed since this approval was displayed. Refresh the approval and review the current checkpoint before deciding.",
        action: "REFRESH_APPROVAL",
      },
    }), { status: 409, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    await expect(engineerDecision("run-1", "request-changes", "Change", authority))
      .rejects.toThrow("Candidate changed since this approval was displayed");
  });
});
