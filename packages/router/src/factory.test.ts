import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, Provider, ProviderId } from "@zintus/types";
import { ProviderHttpError, estimateUsage } from "@zintus/providers";
import { createRouter, type RouteAttemptEvent } from "./factory.js";

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
    `zintus-router-test-${Date.now()}-${Math.random()}.db`,
  );
  dbPaths.push(dbPath);

  mock.module("@zintus/providers", () => ({
    listProviders: () => providers,
    ProviderHttpError,
    estimateUsage,
    // Match the real trainers used by the privacy filter (see data-policies.ts).
    trainsOnUserData: (id: ProviderId) => id === "gemini" || id === "cohere",
  }));

  return createRouter({
    dbPath,
    getApiKey: async () => "test-key",
  });
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

describe("createRouter failover", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

  test("failsover from 429 to the next provider", async () => {
    let cerebrasCalls = 0;

    const router = createTestRouter([
      stubProvider("cerebras", 1, async () => {
        cerebrasCalls += 1;
        throw new ProviderHttpError("rate limited", 429);
      }),
      stubProvider("groq", 2, async () => ({
        stream: (async function* () {
          yield { content: "from groq" };
        })(),
      })),
    ]);

    const result = await router.routeAndStream({ messages });
    expect(cerebrasCalls).toBe(1);
    expect(result.providerId).toBe("groq");

    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe("from groq");
  });

  test("blockTrainingProviders drops training providers from candidates", async () => {
    const calls: string[] = [];
    const router = createTestRouter([
      stubProvider("gemini", 1, async () => {
        calls.push("gemini");
        return { stream: (async function* () { yield { content: "g" }; })() };
      }),
      stubProvider("groq", 2, async () => {
        calls.push("groq");
        return { stream: (async function* () { yield { content: "ok" }; })() };
      }),
    ]);

    const result = await router.routeAndStream({
      messages,
      blockTrainingProviders: true,
    });
    for await (const _chunk of result.stream) {
      // drain
    }
    expect(result.providerId).toBe("groq");
    expect(calls).not.toContain("gemini");
  });

  test("allowTrainingProviders re-admits a blocked provider", async () => {
    const router = createTestRouter([
      stubProvider("gemini", 1, async () => ({
        stream: (async function* () { yield { content: "g" }; })(),
      })),
    ]);

    const result = await router.routeAndStream({
      messages,
      blockTrainingProviders: true,
      allowTrainingProviders: ["gemini"],
    });
    for await (const _chunk of result.stream) {
      // drain
    }
    // Only gemini exists; the allow-list keeps it, so the request still routes.
    expect(result.providerId).toBe("gemini");
  });

  test("BYOK: a per-request key makes a key-less provider eligible and is used", async () => {
    const dbPath = join(tmpdir(), `zintus-byok-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    let receivedKey: string | undefined;
    mock.module("@zintus/providers", () => ({
      listProviders: () => [
        stubProvider("groq", 1, async (_messages, options) => {
          receivedKey = options?.apiKey;
          return { stream: (async function* () { yield { content: "ok" }; })() };
        }),
      ],
      ProviderHttpError,
      estimateUsage,
      trainsOnUserData: () => false,
    }));

    // No server-side key configured for any provider.
    const router = createRouter({ dbPath, getApiKey: async () => null });
    const result = await router.routeAndStream({
      messages,
      keys: { groq: "byok-key" },
    });
    for await (const _chunk of result.stream) {
      // drain
    }
    expect(result.providerId).toBe("groq");
    expect(receivedKey).toBe("byok-key");
  });

  test("no key anywhere → request has no candidates", async () => {
    const dbPath = join(tmpdir(), `zintus-nokey-${Date.now()}-${Math.random()}.db`);
    dbPaths.push(dbPath);
    mock.module("@zintus/providers", () => ({
      listProviders: () => [
        stubProvider("groq", 1, async () => ({
          stream: (async function* () { yield { content: "ok" }; })(),
        })),
      ],
      ProviderHttpError,
      estimateUsage,
      trainsOnUserData: () => false,
    }));
    const router = createRouter({ dbPath, getApiKey: async () => null });
    await expect(router.routeAndStream({ messages })).rejects.toThrow(
      /No providers available/,
    );
  });

  test("forwards temperature and maxTokens to the provider", async () => {
    let temperature: number | undefined;
    let maxTokens: number | undefined;
    const router = createTestRouter([
      stubProvider("groq", 1, async (_messages, options) => {
        temperature = options?.temperature;
        maxTokens = options?.maxTokens;
        return { stream: (async function* () { yield { content: "ok" }; })() };
      }),
    ]);
    const result = await router.routeAndStream({
      messages,
      temperature: 0.2,
      maxTokens: 256,
    });
    for await (const _chunk of result.stream) {
      // drain
    }
    expect(temperature).toBe(0.2);
    expect(maxTokens).toBe(256);
  });

  test("retries groq 8B model before failing over", async () => {
    const models: string[] = [];

    const router = createTestRouter([
      stubProvider("groq", 2, async (_messages, options) => {
        models.push(options.model ?? "default");
        if (options.model === "llama-3.3-70b-versatile") {
          throw new ProviderHttpError("rate limited", 429, {
            resetRequests: "30s",
          });
        }
        return {
          stream: (async function* () {
            yield { content: "8b ok" };
          })(),
        };
      }),
    ]);

    const result = await router.routeAndStream({ messages });
    expect(models).toEqual(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]);
    expect(result.model).toBe("llama-3.1-8b-instant");
    expect(result.providerId).toBe("groq");
  });

  // Fix 3: the success attempt must be recorded only once the stream COMPLETES,
  // not when the provider connection is established.
  test("emits the success attempt only after the stream fully drains", async () => {
    const events: RouteAttemptEvent[] = [];
    const router = createTestRouter([
      stubProvider("groq", 1, async () => ({
        stream: (async function* () {
          yield { content: "ok" };
        })(),
      })),
    ]);

    const result = await router.routeAndStream({
      messages,
      onAttempt: (event) => events.push(event),
    });
    // Connecting is not success — nothing is recorded before the drain.
    expect(events).toHaveLength(0);

    for await (const _chunk of result.stream) {
      // drain
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("success");
  });

  // Fix 3: a stream that dies mid-drain must be recorded as FAIL, never as a
  // success the pre-fix code would have already emitted before consumption.
  test("records a stream that dies mid-drain as a failure, not a success", async () => {
    const events: RouteAttemptEvent[] = [];
    const router = createTestRouter([
      stubProvider("groq", 1, async () => ({
        stream: (async function* () {
          yield { content: "partial" };
          throw new Error("stream died");
        })(),
      })),
    ]);

    const result = await router.routeAndStream({
      messages,
      onAttempt: (event) => events.push(event),
    });
    expect(events).toHaveLength(0);

    let drained = "";
    await expect(
      (async () => {
        for await (const chunk of result.stream) {
          drained += chunk;
        }
      })(),
    ).rejects.toThrow("stream died");

    // The partial output streamed, but the recorded outcome is honest: a fail,
    // and never a success.
    expect(drained).toBe("partial");
    expect(events.some((event) => event.status === "success")).toBe(false);
    const fail = events.find((event) => event.status === "fail");
    expect(fail).toBeDefined();
    expect(fail?.providerId).toBe("groq");
  });
});

describe("createRouter token accounting", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

  test("records provider-reported usage in the quota ledger", async () => {
    const router = createTestRouter([
      stubProvider("gemini", 1, async () => ({
        stream: (async function* () {
          yield { content: "hello world" };
          yield {
            usage: {
              inputTokens: 42,
              outputTokens: 7,
              totalTokens: 49,
              source: "provider" as const,
            },
          };
        })(),
      })),
    ]);

    const result = await router.routeAndStream({ messages });
    for await (const _chunk of result.stream) {
      // drain
    }

    const status = await router.getProviderStatus();
    const gemini = status.find((entry) => entry.id === "gemini");
    // tokensToday must equal the provider-reported total, not a char count.
    expect(gemini?.tokensToday).toBe(49);
  });

  test("falls back to a local estimate when the provider reports no usage", async () => {
    const router = createTestRouter([
      stubProvider("gemini", 1, async () => ({
        stream: (async function* () {
          yield { content: "some output text" };
        })(),
      })),
    ]);

    const result = await router.routeAndStream({ messages });
    let output = "";
    for await (const chunk of result.stream) {
      output += chunk;
    }

    const expected = estimateUsage(messages, output);
    const status = await router.getProviderStatus();
    const gemini = status.find((entry) => entry.id === "gemini");
    expect(gemini?.tokensToday).toBe(expected.totalTokens);
    expect(gemini?.tokensToday).toBeGreaterThan(0);
  });
});
