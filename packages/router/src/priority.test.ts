import { describe, expect, it } from "vitest";
import type { Provider, ProviderId } from "@multipleai/types";
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
  it("sorts by priority for fastest strategy", () => {
    const sorted = sortProviders(providers, "fastest", () => 1);
    expect(sorted.map((p) => p.id)).toEqual(["cerebras", "groq", "gemini"]);
  });

  it("sorts by remaining quota for economy strategy", () => {
    const sorted = sortProviders(providers, "economy", (id) =>
      id === "groq" ? 0.9 : 0.1,
    );
    expect(sorted[0]?.id).toBe("groq");
  });

  it("sorts by capability rank", () => {
    const sorted = sortProviders(providers, "capability", () => 1);
    expect(sorted.map((p) => p.id)).toEqual(["gemini", "cerebras", "groq"]);
  });
});
