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
});
