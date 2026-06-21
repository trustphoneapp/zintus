import { describe, it, expect } from "bun:test";
import { runEvals } from "../src/evals/runner";

describe("Eval harness", () => {
  it("tier 1 runs quickly and returns results", async () => {
    const passed = await runEvals({ tier: 1 });
    expect(typeof passed).toBe("boolean");
  }, 30_000);

  it("all tier 1 benchmarks pass thresholds", async () => {
    const passed = await runEvals({ tier: 1 });
    expect(passed).toBe(true);
  }, 30_000);
});
