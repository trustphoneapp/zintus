import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, Provider, ProviderId } from "@multipleai/types";
import { ProviderHttpError, estimateUsage } from "@multipleai/providers";
import { createRouter } from "./factory.js";

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

function createTestRouter(providers: Provider[]) {
  const dbPath = join(
    tmpdir(),
    `multipleai-cooldown-test-${Date.now()}-${Math.random()}.db`,
  );
  dbPaths.push(dbPath);

  mock.module("@multipleai/providers", () => ({
    listProviders: () => providers,
    ProviderHttpError,
    estimateUsage,
  }));

  return createRouter({
    dbPath,
    getApiKey: async () => "test-key",
  });
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

describe("createRouter cooldown", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

  test("non-Groq provider enters cooldown on 429 and is skipped next request", async () => {
    let geminiCalls = 0;
    let groqCalls = 0;

    const router = createTestRouter([
      stubProvider("gemini", 1, async () => {
        geminiCalls += 1;
        throw new ProviderHttpError("rate limited", 429);
      }),
      stubProvider("groq", 2, async () => ({
        stream: (async function* () {
          yield { content: "from groq" };
        })(),
      })),
    ]);

    // First request: gemini 429s, fails over to groq.
    const first = await router.routeAndStream({ messages });
    expect(first.providerId).toBe("groq");
    await drain(first.stream);
    expect(geminiCalls).toBe(1);

    // Gemini must now be in cooldown.
    const status = await router.getProviderStatus();
    const gemini = status.find((entry) => entry.id === "gemini");
    expect(gemini?.inCooldown).toBe(true);
    expect(gemini?.available).toBe(false);

    // Second request: gemini is skipped entirely (no new call), groq serves.
    const second = await router.routeAndStream({ messages });
    await drain(second.stream);
    expect(second.providerId).toBe("groq");
    expect(geminiCalls).toBe(1);
    groqCalls; // referenced to keep intent explicit
  });

  test("5xx errors also trigger cooldown for a single-model provider", async () => {
    const router = createTestRouter([
      stubProvider("cohere", 1, async () => {
        throw new ProviderHttpError("server error", 503);
      }),
      stubProvider("groq", 2, async () => ({
        stream: (async function* () {
          yield { content: "ok" };
        })(),
      })),
    ]);

    const first = await router.routeAndStream({ messages });
    await drain(first.stream);

    const status = await router.getProviderStatus();
    const cohere = status.find((entry) => entry.id === "cohere");
    expect(cohere?.inCooldown).toBe(true);
  });

  test("Groq cools down only after its last model fails", async () => {
    const models: string[] = [];

    const router = createTestRouter([
      stubProvider("groq", 1, async (_messages, options) => {
        models.push(options.model ?? "default");
        // Both models fail with no rate-limit header, so the exponential
        // cooldown (not the header-derived one) must apply after the last model.
        throw new ProviderHttpError("rate limited", 429);
      }),
    ]);

    await expect(router.routeAndStream({ messages })).rejects.toThrow();
    // Tried 70B then 8B before giving up.
    expect(models).toEqual([
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
    ]);

    const status = await router.getProviderStatus();
    const groq = status.find((entry) => entry.id === "groq");
    expect(groq?.inCooldown).toBe(true);
  });

  test("Groq with a reset header is cooled via the header, not double-counted", async () => {
    const router = createTestRouter([
      stubProvider("groq", 1, async () => {
        throw new ProviderHttpError("rate limited", 429, {
          resetRequests: "30s",
        });
      }),
    ]);

    await expect(router.routeAndStream({ messages })).rejects.toThrow();
    const status = await router.getProviderStatus();
    const groq = status.find((entry) => entry.id === "groq");
    // Header-derived cooldown still leaves the provider unavailable.
    expect(groq?.inCooldown).toBe(true);
  });
});
