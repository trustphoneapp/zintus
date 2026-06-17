import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@multipleai/types";
import { extractFactsWithLlm, summarizeWithLlm } from "./llm-memory.js";

const turns: ChatMessage[] = [
  { role: "user", content: "I prefer TypeScript and concise answers." },
  { role: "assistant", content: "Understood." },
];

describe("llm-memory", () => {
  test("summarizeWithLlm can use mocked router", async () => {
    const summary = await summarizeWithLlm("old", turns, {
      router: {
        async getProviderStatus() {
          return [];
        },
        getSavings() {
          return { byProvider: {}, total: 0 };
        },
        updatePolicy() {},
        async probeProviders() {
          return [];
        },
        async routeAndStream() {
          return {
            providerId: "ollama",
            model: "tiny",
            stream: (async function* () {
              yield "Router summary";
            })(),
          };
        },
      },
    });
    expect(summary).toBe("Router summary");
  });

  test("summarizeWithLlm uses streamText when provided", async () => {
    const summary = await summarizeWithLlm("Previous summary", turns, {
      streamText: async () => "Updated summary line",
    });
    expect(summary).toBe("Updated summary line");
  });

  test("extractFactsWithLlm parses structured JSON", async () => {
    const facts = await extractFactsWithLlm(turns, {
      streamText: async () =>
        JSON.stringify({
          facts: [
            {
              id: "preference.language.typescript",
              content: "prefers TypeScript",
              relevance: 0.93,
              source: "llm",
            },
          ],
        }),
    });

    expect(facts).toHaveLength(1);
    expect(facts[0]?.id).toBe("preference.language.typescript");
    expect(facts[0]?.content).toBe("prefers TypeScript");
  });

  test("extractFactsWithLlm falls back on invalid JSON", async () => {
    const facts = await extractFactsWithLlm(turns, {
      streamText: async () => "not-json",
    });
    expect(facts.length).toBeGreaterThan(0);
  });

  test("summarizeWithLlm falls back on streaming error", async () => {
    const summary = await summarizeWithLlm("", turns, {
      streamText: async () => {
        throw new Error("boom");
      },
    });
    expect(summary.length).toBeGreaterThan(0);
  });
});
