import { describe, expect, test } from "bun:test";
import { consolidateFactsWithLlm } from "./llm-memory.js";

describe("Memory consolidation", () => {
  test("consolidateFactsWithLlm parses actions", async () => {
    const existingFacts = [
      { id: "preference.occupation", content: "User works as a teacher", source: "llm" },
    ];
    const turns = [
      { role: "user" as const, content: "I quit my teacher job and now work as a software engineer." },
    ];

    const result = await consolidateFactsWithLlm(existingFacts, turns, {
      streamText: async () =>
        JSON.stringify({
          deletions: ["preference.occupation"],
          additions: ["User works as a software engineer"],
          updates: [],
        }),
    });

    expect(result.deletions).toContain("preference.occupation");
    expect(result.additions).toContain("User works as a software engineer");
    expect(result.updates).toHaveLength(0);
  });
});
