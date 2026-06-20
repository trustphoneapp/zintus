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

  it("sorts by remaining quota for economy strategy", () => {
    const sorted = sortProviders(providers, "economy", {
      remainingRatio: (id) => (id === "groq" ? 0.9 : 0.1),
    });
    expect(sorted[0]?.id).toBe("groq");
  });

  it("sorts by capability rank", () => {
    const sorted = sortProviders(providers, "capability", {
      remainingRatio: () => 1,
    });
    expect(sorted.map((p) => p.id)).toEqual(["gemini", "cerebras", "groq"]);
  });
});
