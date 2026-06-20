import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  Provider,
  ProviderId,
  StreamChatOptions,
  StreamChatResult,
} from "@zintus/types";
import { ProviderHttpError, estimateUsage } from "@zintus/providers";

/**
 * End-to-end FAILOVER integration test (criterion A1): real engine → router →
 * quota ledger, with a provider that 429s and one that streams. Proves failover
 * works, is counted, is traced, and cools the failed provider down — no network.
 */

function stubProvider(
  id: ProviderId,
  priority: number,
  streamChat: (
    messages: never,
    options: StreamChatOptions,
  ) => Promise<StreamChatResult>,
): Provider {
  return {
    id,
    name: id,
    color: "#000000",
    priority,
    keyRegex: /^test$/,
    defaultModel: "stub-model",
    streamChat: streamChat as Provider["streamChat"],
    async validateKey() {
      return true;
    },
  };
}

describe("engine failover integration (stubbed providers)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zintus-failover-int-"));
  });

  afterEach(() => {
    mock.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeEngine(providers: Provider[]) {
    mock.module("@zintus/providers", () => ({
      listProviders: () => providers,
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

  test("429 on the first provider fails over to the next, counts + traces it, and cools the first down", async () => {
    let geminiCalls = 0;
    const engine = await makeEngine([
      // gemini (priority 1) is tried first and rate-limits.
      stubProvider("gemini", 1, async () => {
        geminiCalls += 1;
        throw new ProviderHttpError("rate limited", 429);
      }),
      // cerebras (priority 2) serves the response.
      stubProvider("cerebras", 2, async () => ({
        stream: (async function* () {
          yield { content: "ok from cerebras" };
        })(),
      })),
    ]);

    const result = await engine.routeAndStream({
      messages: [{ role: "user", content: "hi" }],
    });
    let text = "";
    for await (const chunk of result.stream) {
      text += chunk;
    }

    // Failed over to the second provider and streamed its response.
    expect(result.providerId).toBe("cerebras");
    expect(text).toBe("ok from cerebras");
    // The failed attempt is counted.
    expect(result.failoverCount).toBeGreaterThanOrEqual(1);
    expect(geminiCalls).toBe(1);

    // The trace records both attempts, winner = cerebras.
    const trace = engine.getTrace(result.traceId);
    expect(trace?.attempts.length).toBe(2);
    expect(trace?.attempts[0]?.status).toBe("fail");
    expect(trace?.attempts[0]?.providerId).toBe("gemini");
    expect(trace?.winner?.providerId).toBe("cerebras");

    // gemini is now in cooldown.
    const status = await engine.getProviderStatus();
    expect(status.find((s) => s.id === "gemini")?.inCooldown).toBe(true);

    // Second request skips the cooled-down gemini entirely (no new call).
    const second = await engine.routeAndStream({
      messages: [{ role: "user", content: "again" }],
    });
    for await (const _ of second.stream) {
      // drain
    }
    expect(second.providerId).toBe("cerebras");
    expect(geminiCalls).toBe(1);
  });
});
