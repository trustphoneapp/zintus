import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEngine, type EngineConfig } from "./engine.js";

// Always inject a key resolver so tests never touch the real OS keychain
// (which is slow/blocking and non-deterministic in CI).
const NO_KEYS: EngineConfig["getApiKey"] = async () => null;

describe("createEngine", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zintus-engine-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function engineForTest(overrides: Partial<EngineConfig> = {}) {
    return createEngine({
      conversationsPath: join(dir, "conversations.db"),
      dbPath: join(dir, "quota.db"),
      cachePath: join(dir, "cache.db"),
      getApiKey: NO_KEYS,
      ...overrides,
    });
  }

  test("creates a thread and records a trace even when routing fails", async () => {
    const engine = engineForTest({
      persistConversations: true,
      persistTraces: true,
    });

    expect(engine.listThreads().length).toBe(0);

    await expect(
      engine.routeAndStream({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow();

    const threads = engine.listThreads();
    expect(threads.length).toBe(1);
    expect(threads[0]?.title).toBe("hello");

    const messages = engine.getThreadMessages(threads[0]!.id);
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");

    const trace = engine.getLastTrace();
    expect(trace).not.toBeNull();
  });

  test("does not duplicate user messages on a continued thread", async () => {
    const engine = engineForTest({
      persistConversations: true,
      persistTraces: false,
    });

    const thread = engine.createThread("test");
    await expect(
      engine.routeAndStream({
        threadId: thread.id,
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    ).rejects.toThrow();

    const messages = engine.getThreadMessages(thread.id);
    expect(messages.filter((message) => message.role === "user").length).toBe(1);
    expect(messages.at(-1)?.content).toBe("second");
  });

  test("reports provider status offline: keyed providers lack keys, local ones do not need them", async () => {
    const engine = engineForTest({ persistConversations: false });
    const statuses = await engine.getProviderStatus();

    const groq = statuses.find((status) => status.id === "groq");
    expect(groq?.hasKey).toBe(false);
    expect(groq?.available).toBe(false);

    // Ollama and LM Studio require no API key, so they always report hasKey.
    const ollama = statuses.find((status) => status.id === "ollama");
    expect(ollama?.hasKey).toBe(true);
  });
});
