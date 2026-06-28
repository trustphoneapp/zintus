import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Provider, ProviderId, StreamChunk } from "@zintus/types";
import { ProviderHttpError, estimateUsage } from "@zintus/providers";

/**
 * End-to-end integration test: drives the real engine → router → quota ledger →
 * conversation store pipeline against a stubbed provider (no network). Proves
 * the full happy path streams, persists, traces, and records REAL token usage.
 */

function stubProvider(
  id: ProviderId,
  stream: () => AsyncGenerator<StreamChunk>,
): Provider {
  return {
    id,
    name: id,
    color: "#000000",
    priority: 1,
    keyRegex: /^test$/,
    defaultModel: "stub-model",
    async streamChat() {
      return { stream: stream() };
    },
    async validateKey() {
      return true;
    },
  };
}

describe("engine integration (stubbed provider)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zintus-engine-int-"));
  });

  afterEach(() => {
    mock.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeEngine(provider: Provider) {
    mock.module("@zintus/providers", () => ({
      listProviders: () => [provider],
      ProviderHttpError,
      estimateUsage,
    }));
    const { createEngine } = await import("./engine.js");
    return createEngine({
      conversationsPath: join(dir, "conversations.db"),
      dbPath: join(dir, "quota.db"),
      cachePath: join(dir, "cache.db"),
      memoryPath: join(dir, "memory.db"),
      getApiKey: async () => "test-key",
      persistConversations: true,
      persistTraces: true,
    });
  }

  test("streams, persists messages, traces, and records provider-reported tokens", async () => {
    const provider = stubProvider("gemini", async function* () {
      yield { content: "Hello" };
      yield { content: " world" };
      yield {
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          source: "provider" as const,
        },
      };
    });
    const engine = await makeEngine(provider);

    const result = await engine.routeAndStream({
      messages: [{ role: "user", content: "hi there" }],
    });

    let text = "";
    for await (const chunk of result.stream) {
      text += chunk;
    }

    // Streamed the full response.
    expect(text).toBe("Hello world");
    expect(result.providerId).toBe("gemini");

    // A human route-reason is always present (the consistency rule) and names the
    // winning provider/model.
    expect(result.routeReason).toBeDefined();
    expect(result.routeReason).toContain("gemini");
    expect(result.routeReason).toContain("strategy");

    // Persisted both turns on the thread.
    const messages = engine.getThreadMessages(result.threadId!);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages.at(-1)?.content).toBe("Hello world");

    // Recorded a completed trace.
    const trace = engine.getTrace(result.traceId);
    expect(trace?.winner?.providerId).toBe("gemini");

    // Recorded REAL provider-reported token usage (not a char count).
    const status = await engine.getProviderStatus();
    const gemini = status.find((s) => s.id === "gemini");
    expect(gemini?.tokensToday).toBe(20);
  });

  test("falls back to estimated tokens when the provider reports none", async () => {
    const provider = stubProvider("gemini", async function* () {
      yield { content: "some answer" };
    });
    const engine = await makeEngine(provider);

    const result = await engine.routeAndStream({
      messages: [{ role: "user", content: "question" }],
    });
    let text = "";
    for await (const chunk of result.stream) {
      text += chunk;
    }

    const expected = estimateUsage(
      [{ role: "user", content: "question" }],
      "some answer",
    );
    const status = await engine.getProviderStatus();
    const gemini = status.find((s) => s.id === "gemini");
    // The engine compiles context (adds a system message), so the recorded
    // input estimate is at least the bare user-message estimate.
    expect(gemini?.tokensToday).toBeGreaterThanOrEqual(expected.outputTokens);
    expect(gemini?.tokensToday).toBeGreaterThan(0);
  });

  // Fix 2: a cache HIT must record a complete trace (winner, latency,
  // completedAt) — not silently bail out leaving the trace half-written. The
  // pre-fix code returned on a hit without ever completing the trace.
  test("a cache hit records a completed trace tagged as a hit", async () => {
    let providerCalls = 0;
    const provider = stubProvider("gemini", async function* () {
      providerCalls += 1;
      yield { content: "cached answer" };
    });
    const engine = await makeEngine(provider);

    const messages = [{ role: "user" as const, content: "repeat me exactly" }];

    // First request: cache MISS — hits the provider and writes the cache.
    const miss = await engine.routeAndStream({ messages });
    let firstText = "";
    for await (const chunk of miss.stream) firstText += chunk;
    expect(firstText).toBe("cached answer");
    expect(miss.cacheHit).toBe("miss");
    expect(providerCalls).toBe(1);

    // Second identical request: cache HIT — provider must NOT be called again.
    const hit = await engine.routeAndStream({ messages });
    let secondText = "";
    for await (const chunk of hit.stream) secondText += chunk;
    expect(secondText).toBe("cached answer");
    expect(hit.cacheHit).toBe("L1");
    expect(providerCalls).toBe(1);

    // The crux of Fix 2: the cache-hit trace is COMPLETE, not abandoned.
    const trace = engine.getTrace(hit.traceId);
    expect(trace).not.toBeNull();
    expect(trace?.completedAt).toBeInstanceOf(Date);
    expect(trace?.winner).toBeDefined();
    expect(typeof trace?.totalLatencyMs).toBe("number");
  });
});
