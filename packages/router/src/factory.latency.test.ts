import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, Provider, ProviderId } from "@multipleai/types";
import { ProviderHttpError, estimateUsage } from "@multipleai/providers";
import { createRouter } from "./factory.js";

const dbPaths: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stubProvider(
  id: ProviderId,
  priority: number,
  delayMs: number,
): Provider {
  return {
    id,
    name: id,
    color: "#000000",
    priority,
    keyRegex: /^test$/,
    defaultModel: "test-model",
    async streamChat() {
      return {
        stream: (async function* () {
          if (delayMs > 0) {
            await sleep(delayMs);
          }
          yield { content: "ok" };
        })(),
      };
    },
    async validateKey() {
      return true;
    },
  };
}

function createTestRouter(providers: Provider[]) {
  const dbPath = join(
    tmpdir(),
    `multipleai-latency-test-${Date.now()}-${Math.random()}.db`,
  );
  dbPaths.push(dbPath);
  mock.module("@multipleai/providers", () => ({
    listProviders: () => providers,
    ProviderHttpError,
    estimateUsage,
  }));
  return createRouter({ dbPath, strategy: "fastest", getApiKey: async () => "test-key" });
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) {
    out += chunk;
  }
  return out;
}

afterEach(() => {
  mock.restore();
  for (const path of dbPaths.splice(0)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
});

describe("createRouter fastest = real latency", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

  test("prefers the provider with lower measured p95 latency", async () => {
    // gemini sorts first by configured priority but is the slow one; once enough
    // latency samples exist, fastest must switch to the genuinely faster groq.
    const router = createTestRouter([
      stubProvider("gemini", 1, 60), // slow
      stubProvider("groq", 2, 0), // fast
    ]);

    // Seed latency samples for both providers by forcing each (minSamples = 3).
    for (let i = 0; i < 3; i++) {
      const slow = await router.routeAndStream({ messages, provider: "gemini" });
      await drain(slow.stream);
      const fast = await router.routeAndStream({ messages, provider: "groq" });
      await drain(fast.stream);
    }

    // Now an unforced request under the fastest strategy should pick groq, even
    // though gemini has higher configured priority.
    const chosen = await router.routeAndStream({ messages });
    await drain(chosen.stream);
    expect(chosen.providerId).toBe("groq");
  });
});
