import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Provider, ProviderId, StreamChunk } from "@zintus/types";
import { ProviderHttpError, estimateUsage } from "@zintus/providers";
// Snapshot the REAL module BY VALUE at load so teardown can un-leak the module
// mock (bun's mock.restore() does NOT undo mock.module(); a live `import *`
// namespace would reflect the current mock, not the real module).
import * as providersModuleLive from "@zintus/providers";
const realProvidersModule = { ...providersModuleLive };
import { MemoryStore } from "@zintus/memory";

/**
 * The incognito invariant: a request with `persist: false` must write NO durable
 * state — no conversation rows, no memory facts, no thread summary, and no
 * response-cache entry — even though the engine is configured to persist by
 * default. Proven against a stubbed provider (a real, successful turn), with
 * controls showing a normal turn DOES write. See docs: request-level no-persist.
 */

// Module-level so the stub can count real provider invocations (cache proof).
let providerCalls = 0;

function stubProvider(id: ProviderId): Provider {
  return {
    id,
    name: id,
    color: "#000000",
    priority: 1,
    keyRegex: /^test$/,
    defaultModel: "stub-model",
    async streamChat() {
      providerCalls += 1;
      async function* gen(): AsyncGenerator<StreamChunk> {
        yield { content: "Hello world" };
        yield {
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            totalTokens: 10,
            source: "provider" as const,
          },
        };
      }
      return { stream: gen() };
    },
    async validateKey() {
      return true;
    },
  };
}

describe("persist:false — incognito writes no durable state", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zintus-persist-"));
    providerCalls = 0;
  });

  afterEach(() => {
    mock.restore();
    // Un-leak the module mock so a sibling file sees the real provider list.
    mock.module("@zintus/providers", () => realProvidersModule);
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeEngine(memory: MemoryStore) {
    mock.module("@zintus/providers", () => ({
      listProviders: () => [stubProvider("gemini")],
      ProviderHttpError,
      estimateUsage,
    }));
    const { createEngine } = await import("./engine.js");
    return createEngine({
      conversationsPath: join(dir, "conversations.db"),
      dbPath: join(dir, "quota.db"),
      cachePath: join(dir, "cache.db"),
      getApiKey: async () => "test-key",
      memory,
      persistConversations: true,
      persistTraces: true,
    });
  }

  async function drain(result: { stream: AsyncIterable<string> }): Promise<string> {
    let text = "";
    for await (const chunk of result.stream) text += chunk;
    // Let updateMemoryAfterTurn's fire-and-forget microtask settle so a leaked
    // write would actually show up in the assertions below.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return text;
  }

  test("no conversation, facts, or summary on a persist:false turn — but a normal turn writes", async () => {
    const memory = new MemoryStore(join(dir, "memory.db"));
    memory.init();
    const engine = await makeEngine(memory);
    const thread = engine.createThread("incognito");

    // Incognito turn: streams normally, persists nothing.
    const incognito = await engine.routeAndStream({
      threadId: thread.id,
      messages: [{ role: "user", content: "remember my name is Alice" }],
      persist: false,
    });
    expect(await drain(incognito)).toBe("Hello world");

    // Zero durable state despite persistConversations/persistTraces = true.
    expect(engine.getThreadMessages(thread.id).length).toBe(0);
    expect(memory.listFacts(thread.id).length).toBe(0);
    expect(memory.getThreadState(thread.id)).toBeNull();

    // Control: the SAME turn with persistence (default) writes the conversation.
    const normal = await engine.routeAndStream({
      threadId: thread.id,
      messages: [{ role: "user", content: "remember my name is Alice" }],
    });
    expect(await drain(normal)).toBe("Hello world");
    expect(engine.getThreadMessages(thread.id).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("no response-cache write on a persist:false turn (cache still works normally)", async () => {
    const memory = new MemoryStore(join(dir, "memory.db"));
    memory.init();
    const engine = await makeEngine(memory);

    // Incognito turn for prompt X.
    await drain(
      await engine.routeAndStream({
        messages: [{ role: "user", content: "cache probe" }],
        persist: false,
      }),
    );
    expect(providerCalls).toBe(1);

    // A NORMAL turn for the same prompt X must MISS — if the incognito turn had
    // written to the cache, this would be served from it and skip the provider.
    await drain(
      await engine.routeAndStream({
        messages: [{ role: "user", content: "cache probe" }],
      }),
    );
    expect(providerCalls).toBe(2); // proves the incognito turn wrote no cache

    // A second NORMAL turn for X now HITS the cache the previous normal turn
    // wrote — the provider is NOT invoked again. (Proves caching is otherwise on.)
    await drain(
      await engine.routeAndStream({
        messages: [{ role: "user", content: "cache probe" }],
      }),
    );
    expect(providerCalls).toBe(2);
  });

  test("memory used: included facts surface on the result and stamp lastUsedAt", async () => {
    const memory = new MemoryStore(join(dir, "memory.db"));
    memory.init();
    const engine = await makeEngine(memory);
    const thread = engine.createThread("t");
    const fact = memory.upsertFact({
      scope: "thread",
      threadId: thread.id,
      key: "name",
      value: "Alice",
    });

    const result = await engine.routeAndStream({
      threadId: thread.id,
      messages: [{ role: "user", content: "what is my name" }],
    });
    // Surfaced to the client ("memory used this turn").
    expect(result.memoryUsed?.some((m) => m.id === fact.id)).toBe(true);
    await drain(result);
    // Curation: the included fact's lastUsedAt is stamped.
    expect(memory.listFacts(thread.id)[0]?.lastUsedAt).toBeGreaterThan(0);
  });

  test("incognito still READS memory (surfaced) but never stamps lastUsedAt", async () => {
    const memory = new MemoryStore(join(dir, "memory.db"));
    memory.init();
    const engine = await makeEngine(memory);
    const thread = engine.createThread("t");
    const fact = memory.upsertFact({
      scope: "thread",
      threadId: thread.id,
      key: "pet",
      value: "cat",
    });

    const result = await engine.routeAndStream({
      threadId: thread.id,
      messages: [{ role: "user", content: "what pet do I have" }],
      persist: false,
    });
    // The fact still influenced the answer and is surfaced honestly...
    expect(result.memoryUsed?.some((m) => m.id === fact.id)).toBe(true);
    await drain(result);
    // ...but incognito writes nothing durable, including the lastUsedAt stamp.
    expect(memory.listFacts(thread.id)[0]?.lastUsedAt).toBeUndefined();
  });

  test("global memory reaches the compiler on a THREADED turn (adapter delegates to getTopFacts)", async () => {
    const memory = new MemoryStore(join(dir, "memory.db"));
    memory.init();
    const engine = await makeEngine(memory);
    const thread = engine.createThread("t");
    memory.upsertFact({ scope: "global", key: "name", value: "Alice" });

    // Threaded → compileContext → memory adapter → memory.getTopFacts (merges
    // global). Previously the adapter used listFacts and dropped global facts.
    const result = await engine.routeAndStream({
      threadId: thread.id,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.memoryUsed?.some((m) => m.content.includes("Alice"))).toBe(
      true,
    );
    await drain(result);
  });

  test("project memory reaches the compiler on a threaded turn when projectId is set", async () => {
    const memory = new MemoryStore(join(dir, "memory.db"));
    memory.init();
    const engine = await makeEngine(memory);
    const thread = engine.createThread("t");
    memory.upsertFact({
      scope: "project",
      projectId: "p1",
      key: "stack",
      value: "bun",
    });

    const result = await engine.routeAndStream({
      threadId: thread.id,
      messages: [{ role: "user", content: "hi" }],
      projectId: "p1",
    });
    expect(result.memoryUsed?.some((m) => m.content.includes("bun"))).toBe(true);
    await drain(result);
  });

  test("global memory applies to a thread-LESS turn (first turn / stateless)", async () => {
    const memory = new MemoryStore(join(dir, "memory.db"));
    memory.init();
    const engine = await makeEngine(memory);
    memory.upsertFact({ scope: "global", key: "name", value: "Alice" });

    // No threadId → the compiler's fact path doesn't run, but the injected
    // global-memory system message must still surface the fact.
    const result = await engine.routeAndStream({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.memoryUsed?.some((m) => m.content.includes("Alice"))).toBe(
      true,
    );
    await drain(result);
  });

  test("provenance: extracted facts record the source user message id", async () => {
    const memory = new MemoryStore(join(dir, "memory.db"));
    memory.init();
    const engine = await makeEngine(memory);
    const thread = engine.createThread("t");

    const result = await engine.routeAndStream({
      threadId: thread.id,
      messages: [
        { role: "user", content: "we decided to use bun for the backend" },
      ],
    });
    await drain(result); // let the fire-and-forget memory microtask settle

    const userMsg = engine
      .getThreadMessages(thread.id)
      .find((m) => m.role === "user");
    expect(userMsg?.id).toBeTruthy();

    const facts = memory.listFacts(thread.id);
    expect(facts.length).toBeGreaterThan(0);
    // Every extracted fact is attributed to the user message it came from.
    expect(facts.every((f) => f.sourceMessageId === userMsg!.id)).toBe(true);
  });
});
