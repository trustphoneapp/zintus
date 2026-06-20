import { describe, expect, it } from "vitest";
import type { Provider, ProviderId } from "@zintus/types";
import { sortProviders } from "./priority.js";

function stub(id: ProviderId, priority: number): Provider {
  return {
    id,
    name: id,
    color: "#000000",
    priority,
    keyRegex: null,
    defaultModel: "test",
    async streamChat() {
      return { stream: (async function* () {})() };
    },
    async validateKey() {
      return true;
    },
  };
}

const providers: Provider[] = [
  stub("groq", 2),
  stub("cerebras", 1),
  stub("gemini", 3),
];

describe("sortProviders", () => {
  it("falls back to priority order for fastest when no latency samples", () => {
    const sorted = sortProviders(providers, "fastest", {
      remainingRatio: () => 1,
    });
    expect(sorted.map((p) => p.id)).toEqual(["cerebras", "groq", "gemini"]);
  });

  it("orders fastest by lowest measured p95 latency", () => {
    const latency: Record<string, number | null> = {
      cerebras: 800,
      groq: 120,
      gemini: 400,
    };
    const sorted = sortProviders(providers, "fastest", {
      remainingRatio: () => 1,
      latencyP95: (id) => latency[id] ?? null,
    });
    expect(sorted.map((p) => p.id)).toEqual(["groq", "gemini", "cerebras"]);
  });

  it("sorts by remaining quota for economy when no cost is provided", () => {
    const sorted = sortProviders(providers, "economy", {
      remainingRatio: (id) => (id === "groq" ? 0.9 : 0.1),
    });
    expect(sorted[0]?.id).toBe("groq");
  });

  it("economy prefers the cheapest paid-equivalent among healthy quota", () => {
    const cost: Record<string, number> = {
      groq: 0.6,
      cerebras: 0.6,
      gemini: 0.3,
    };
    const sorted = sortProviders(providers, "economy", {
      remainingRatio: () => 1,
      costPerMillion: (id) => cost[id] ?? 0,
    });
    // gemini is cheapest; groq/cerebras tie on cost, broken by priority.
    expect(sorted.map((p) => p.id)).toEqual(["gemini", "cerebras", "groq"]);
  });

  it("economy demotes a cheap provider that is running low on quota", () => {
    const cost: Record<string, number> = { gemini: 0.3, groq: 0.6, cerebras: 0.6 };
    const sorted = sortProviders(providers, "economy", {
      // gemini is cheapest but nearly exhausted; it must fall behind the
      // healthy (more expensive) providers instead of being routed into a wall.
      remainingRatio: (id) => (id === "gemini" ? 0.02 : 1),
      costPerMillion: (id) => cost[id] ?? 0,
    });
    expect(sorted[0]?.id).not.toBe("gemini");
    expect(sorted.at(-1)?.id).toBe("gemini");
  });

  it("sorts by capability rank", () => {
    const sorted = sortProviders(providers, "capability", {
      remainingRatio: () => 1,
    });
    expect(sorted.map((p) => p.id)).toEqual(["gemini", "cerebras", "groq"]);
  });
});
