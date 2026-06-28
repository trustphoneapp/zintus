import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "@zintus/memory";
import { ResponseCache } from "@zintus/cache";
import type { ChatMessage } from "@zintus/types";
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
      memoryPath: join(dir, "memory.db"),
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

  // Fix 1: the memory store must be injectable so separate engines/processes
  // don't collide on one hidden global DB. Proven by isolation, not mocks.
  test("memory store path/instance is injectable and isolated per engine", () => {
    const memA = new MemoryStore(join(dir, "memory-a.db"));
    memA.init();
    memA.upsertThreadState("thread-1", {
      threadId: "thread-1",
      workingSummary: "from A",
    });

    // An engine handed memory A sees A's state.
    const engineA = createEngine({
      conversationsPath: join(dir, "conv-a.db"),
      dbPath: join(dir, "quota-a.db"),
      cachePath: join(dir, "cache-a.db"),
      getApiKey: NO_KEYS,
      memory: memA,
    });
    expect(engineA.getThreadState("thread-1")).toMatchObject({
      workingSummary: "from A",
    });

    // A second engine on its OWN memory path does not see A's state — no
    // shared hidden global DB.
    const engineB = createEngine({
      conversationsPath: join(dir, "conv-b.db"),
      dbPath: join(dir, "quota-b.db"),
      cachePath: join(dir, "cache-b.db"),
      memoryPath: join(dir, "memory-b.db"),
      getApiKey: NO_KEYS,
    });
    expect(engineB.getThreadState("thread-1")).toBeNull();
  });

  // Fix 1: close() releases engine-owned handles and is idempotent; an INJECTED
  // memory store is left open for its owner (still usable after engine.close()).
  test("close() is idempotent and does not close an injected memory store", () => {
    const injected = new MemoryStore(join(dir, "memory-injected.db"));
    injected.init();
    const engine = createEngine({
      conversationsPath: join(dir, "conv-c.db"),
      dbPath: join(dir, "quota-c.db"),
      cachePath: join(dir, "cache-c.db"),
      getApiKey: NO_KEYS,
      memory: injected,
    });

    // createEngine always provides close(); the interface marks it optional only
    // so lightweight fakes can omit it.
    expect(() => engine.close!()).not.toThrow();
    // Idempotent: a second close must not throw.
    expect(() => engine.close!()).not.toThrow();
    // The caller still owns the injected store — it remains usable.
    injected.upsertThreadState("t-after", {
      threadId: "t-after",
      workingSummary: "still open",
    });
    expect(injected.getThreadState("t-after")?.state).toMatchObject({
      workingSummary: "still open",
    });
  });

  // Cache guard (blue-tool-calling #4): a CONTINUATION turn replaying tool_result
  // blocks carries no new `tools` field, so `requiresTools` is false and the
  // read guard would otherwise serve it from the text cache (and its lastUser is
  // a pure tool_result whose textOf is "" — an empty-string L2 lookup). The
  // `hasToolTurns(effectiveMessages)` guard must keep it OUT of the cache.
  test("a tool_result continuation turn is not served from cache", async () => {
    const cachePath = join(dir, "cache-guard.db");

    // Control turn: a plain-text turn whose answer we pre-seed into the cache.
    const plainMessages: ChatMessage[] = [{ role: "user", content: "what is 2+2" }];
    // Continuation turn: assistant tool_call + user tool_result, NO `tools` field.
    const continuationMessages: ChatMessage[] = [
      { role: "user", content: "what is the weather in paris" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_abc",
            name: "get_weather",
            arguments: { city: "paris" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "call_abc", content: "sunny, 21C" }],
      },
    ];

    // Pre-seed BOTH turns so a (buggy) read would find a matching entry. Keyed the
    // SAME way the engine reads an unforced request: model/provider "auto".
    const seed = new ResponseCache(cachePath);
    await seed.set(plainMessages, "CACHED PLAIN ANSWER", {
      model: "auto",
      providerId: "auto",
    });
    await seed.set(continuationMessages, "CACHED TOOL ANSWER", {
      model: "auto",
      providerId: "auto",
    });

    const engine = engineForTest({
      cachePath,
      persistConversations: false,
      persistTraces: false,
    });

    // Control: the plain-text turn IS served from L1 — proves the seed key matches
    // the engine's read key, so the negative result below is not vacuous.
    const plain = await engine.routeAndStream({ messages: plainMessages });
    expect(plain.cacheHit).toBe("L1");
    let plainText = "";
    for await (const chunk of plain.stream) plainText += chunk;
    expect(plainText).toBe("CACHED PLAIN ANSWER");

    // Guard: the tool_result continuation is NOT served from cache — the engine
    // falls through to routing, which throws (no provider keys in tests). If the
    // guard were missing it would instead return "CACHED TOOL ANSWER".
    await expect(
      engine.routeAndStream({ messages: continuationMessages }),
    ).rejects.toThrow();
  });
});
