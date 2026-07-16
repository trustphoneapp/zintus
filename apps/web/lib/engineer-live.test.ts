import { afterEach, describe, expect, it } from "bun:test";
import { getEngineerLiveSummary } from "./engineer.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Engineer lightweight live summary", () => {
  it("loads only run status and budget, never the full snapshot or heavy evidence sections", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/budget")) return Response.json({ budget: { runId: "run-1", revision: 7 } });
      return Response.json({ run: { runId: "run-1", state: "IMPLEMENTING", stateVersion: 12 }, lastError: null });
    }) as typeof fetch;

    const result = await getEngineerLiveSummary("run-1");
    expect(result.status.run.state).toBe("IMPLEMENTING");
    expect(result.budget?.revision).toBe(7);
    expect(paths).toEqual([
      "/v1/engineer/runs/run-1",
      "/v1/engineer/runs/run-1/budget",
    ]);
    expect(paths.join(" ")).not.toMatch(/snapshot|diff|evidence|artifacts|claims|tests|security/);
  });

  it("keeps status available when the optional budget projection fails", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith("/budget")
        ? Response.json({ error: "budget unavailable" }, { status: 503 })
        : Response.json({ run: { runId: "run-1", state: "PAUSED_BUDGET", stateVersion: 13 }, lastError: null });
    }) as typeof fetch;

    const result = await getEngineerLiveSummary("run-1");
    expect(result.status.run.state).toBe("PAUSED_BUDGET");
    expect(result.budget).toBeNull();
  });
});
