import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { MemoryStore } from "./memory-store.js";
import { consolidateFactsWithLlm } from "./llm-memory.js";
import { rmSync } from "node:fs";

const TEST_DB_PATH = `${import.meta.dirname}/test_memory.db`;

describe("Memory checkpoints and consolidation", () => {
  let store: MemoryStore;

  beforeAll(() => {
    try {
      rmSync(TEST_DB_PATH);
    } catch {}
    store = new MemoryStore(TEST_DB_PATH);
    store.init();
  });

  afterAll(() => {
    try {
      rmSync(TEST_DB_PATH);
    } catch {}
  });

  test("saving and restoring thread checkpoints", () => {
    const threadId = "thread-123";
    const checkpointId = "ckpt-1";
    const state = { messageCount: 5, active: true };

    store.saveCheckpoint(threadId, checkpointId, null, state);

    const restored = store.getCheckpoint(threadId, checkpointId);
    expect(restored).not.toBeNull();
    expect(restored?.messageCount).toBe(5);
    expect(restored?.active).toBe(true);

    const list = store.listCheckpoints(threadId);
    expect(list).toHaveLength(1);
    expect(list[0]?.checkpointId).toBe(checkpointId);
    expect(list[0]?.parentCheckpointId).toBeNull();
  });

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
