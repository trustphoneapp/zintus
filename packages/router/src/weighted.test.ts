import { describe, expect, mock, test, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Captured before any mock.module() runs, so we can restore the real module in
// teardown. Bun's mock.restore() does NOT undo mock.module(), so without this the
// "@zintus/providers" mock leaks process-globally into later test files and
// shadows their imports (e.g. token-estimate.test.ts saw this stub's estimateUsage).
import * as realProviders from "@zintus/providers";
import type { ChatMessage, Provider, ProviderId } from "@zintus/types";
import { createRouter } from "./factory.js";
import { QuotaLedger } from "./quota-ledger.js";

const dbPaths: string[] = [];

function stubProvider(
  id: ProviderId,
  priority: number,
  streamChat: Provider["streamChat"],
): Provider {
  return {
    id,
    name: id,
    color: "#000000",
    priority,
    keyRegex: /^test$/,
    defaultModel: "test-model",
    streamChat,
    async validateKey() {
      return true;
    },
  };
}

function createTestRouterWithLedger(providers: Provider[]) {
  const dbPath = join(
    tmpdir(),
    `zintus-router-weighted-test-${Date.now()}-${Math.random()}.db`,
  );
  dbPaths.push(dbPath);

  mock.module("@zintus/providers", () => ({
    listProviders: () => providers,
    ProviderHttpError: class ProviderHttpError extends Error {
      status: number;
      constructor(msg: string, status: number) {
        super(msg);
        this.status = status;
      }
    },
    estimateUsage: () => ({ inputTokens: 5, outputTokens: 10, totalTokens: 15, source: "estimate" }),
  }));

  const ledger = new QuotaLedger(dbPath);

  const router = createRouter({
    dbPath,
    getApiKey: async () => "test-key",
  });

  return { router, ledger };
}

afterEach(() => {
  // Re-register the real module to undo the mock.module() leak (mock.restore()
  // alone does not), so no later test file inherits this stub.
  mock.module("@zintus/providers", () => realProviders);
  mock.restore();
  for (const path of dbPaths.splice(0)) {
    try {
      unlinkSync(path);
    } catch {}
  }
});

describe("weighted routing", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "weighted test" }];

  test("probabilistic routing based on weights", async () => {
    const counts = { groq: 0, cerebras: 0 };
    const { router } = createTestRouterWithLedger([
      stubProvider("groq", 1, async () => ({
        stream: (async function* () {
          yield { content: "groq" };
        })(),
      })),
      stubProvider("cerebras", 2, async () => ({
        stream: (async function* () {
          yield { content: "cerebras" };
        })(),
      })),
    ]);

    for (let i = 0; i < 20; i++) {
      const result = await router.routeAndStream({
        messages,
        strategy: "weighted",
        providerWeights: { groq: 9, cerebras: 1 }, // 90% Groq, 10% Cerebras
      });
      counts[result.providerId as "groq" | "cerebras"]++;
    }

    // Checking that it is probabilistic: Groq should win the vast majority
    expect(counts.groq).toBeGreaterThan(0);
    expect(counts.groq).toBeGreaterThan(counts.cerebras);
  });
});

describe("virtual API keys quota limits", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "virtual key test" }];

  test("rejects when virtual key is exhausted", async () => {
    const { router, ledger } = createTestRouterWithLedger([
      stubProvider("groq", 1, async () => ({
        stream: (async function* () {
          yield { content: "hello" };
        })(),
      })),
    ]);

    ledger.createVirtualKey("vkey-123", "Test Client", 1, 100); // 1 request limit

    // First request should pass
    const res1 = await router.routeAndStream({ messages, virtualKey: "vkey-123" });
    for await (const _ of res1.stream) {}

    // Second request should fail early
    expect(
      router.routeAndStream({ messages, virtualKey: "vkey-123" })
    ).rejects.toThrow("Virtual key quota or rate limit exceeded");
  });
});
