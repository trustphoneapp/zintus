import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, Provider, ProviderId } from "@zintus/types";
import { ProviderHttpError, estimateUsage } from "@zintus/providers";
import { createRouter, type RouterConfig } from "./factory.js";

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

function createTestRouter(
  providers: Provider[],
  extraConfig: Partial<RouterConfig> = {},
) {
  const dbPath = join(
    tmpdir(),
    `zintus-router-keys-${Date.now()}-${Math.random()}.db`,
  );
  dbPaths.push(dbPath);

  mock.module("@zintus/providers", () => ({
    listProviders: () => providers,
    ProviderHttpError,
    estimateUsage,
    trainsOnUserData: () => false,
    mayTrainOnUserData: () => false,
    supportsVision: () => true,
    supportsTools: () => true,
  }));

  return createRouter({ dbPath, ...extraConfig });
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

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) {
    out += chunk;
  }
  return out;
}

describe("BYOK priority + fallback keys (key-level retry on auth failure)", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

  // (a) auth error (401) on key A → retries key B → SUCCESS on the SAME provider.
  test("401 on the primary key retries the next key and succeeds on the same provider", async () => {
    const keysSeen: Array<string | undefined> = [];
    const router = createTestRouter(
      [
        stubProvider("groq", 1, async (_messages, options) => {
          keysSeen.push(options.apiKey);
          if (options.apiKey === "keyA") {
            throw new ProviderHttpError("invalid api key", 401);
          }
          return { stream: (async function* () { yield { content: "ok" }; })() };
        }),
      ],
      { getApiKeys: async () => ["keyA", "keyB"] },
    );

    const result = await router.routeAndStream({ messages });
    expect(result.providerId).toBe("groq");
    expect(await drain(result.stream)).toBe("ok");
    // Same provider+model, key A then key B — no provider failover happened.
    expect(keysSeen).toEqual(["keyA", "keyB"]);
  });

  // 403 is treated the same as 401 (auth class).
  test("403 also triggers the key fallback", async () => {
    const keysSeen: Array<string | undefined> = [];
    const router = createTestRouter(
      [
        stubProvider("groq", 1, async (_messages, options) => {
          keysSeen.push(options.apiKey);
          if (options.apiKey === "keyA") {
            throw new ProviderHttpError("forbidden", 403);
          }
          return { stream: (async function* () { yield { content: "ok" }; })() };
        }),
      ],
      { getApiKeys: async () => ["keyA", "keyB"] },
    );
    const result = await router.routeAndStream({ messages });
    expect(await drain(result.stream)).toBe("ok");
    expect(keysSeen).toEqual(["keyA", "keyB"]);
  });

  // (b) non-auth error (429) → NO key-retry; existing provider failover happens.
  test("429 does NOT retry the next key — it fails over to the next provider", async () => {
    const groqKeys: Array<string | undefined> = [];
    const router = createTestRouter(
      [
        stubProvider("cerebras", 1, async (_messages, options) => {
          groqKeys.push(options.apiKey);
          throw new ProviderHttpError("rate limited", 429);
        }),
        stubProvider("gemini", 2, async () => ({
          stream: (async function* () { yield { content: "from gemini" }; })(),
        })),
      ],
      { getApiKeys: async () => ["keyA", "keyB"] },
    );

    const result = await router.routeAndStream({ messages });
    // Failed over to the next PROVIDER, not the next KEY.
    expect(result.providerId).toBe("gemini");
    expect(await drain(result.stream)).toBe("from gemini");
    // groq was tried with the primary key ONLY — no key-level retry on a 429.
    expect(groqKeys).toEqual(["keyA"]);
  });

  // 5xx is also non-auth → no key retry, provider failover.
  test("500 does NOT retry the next key — it fails over to the next provider", async () => {
    const groqKeys: Array<string | undefined> = [];
    const router = createTestRouter(
      [
        stubProvider("cerebras", 1, async (_messages, options) => {
          groqKeys.push(options.apiKey);
          throw new ProviderHttpError("server error", 500);
        }),
        stubProvider("gemini", 2, async () => ({
          stream: (async function* () { yield { content: "ok" }; })(),
        })),
      ],
      { getApiKeys: async () => ["keyA", "keyB"] },
    );
    const result = await router.routeAndStream({ messages });
    expect(result.providerId).toBe("gemini");
    await drain(result.stream);
    expect(groqKeys).toEqual(["keyA"]);
  });

  // (c) ALL keys 401 → provider abandoned EXACTLY as today (401 aborts; it does
  // NOT fall over to the next provider, same as a single-key 401 does today).
  test("all keys 401 abandons the provider exactly as today (no provider failover)", async () => {
    const groqKeys: Array<string | undefined> = [];
    let geminiCalled = false;
    const router = createTestRouter(
      [
        stubProvider("groq", 1, async (_messages, options) => {
          groqKeys.push(options.apiKey);
          throw new ProviderHttpError("invalid api key", 401);
        }),
        stubProvider("gemini", 2, async () => {
          geminiCalled = true;
          return { stream: (async function* () { yield { content: "x" }; })() };
        }),
      ],
      { getApiKeys: async () => ["keyA", "keyB"] },
    );

    await expect(router.routeAndStream({ messages })).rejects.toThrow();
    // Both keys were tried on groq...
    expect(groqKeys).toEqual(["keyA", "keyB"]);
    // ...then the request aborted on the 401 (today's behavior) — gemini was
    // never tried (a 401 is a hard error, not a provider-failover trigger).
    expect(geminiCalled).toBe(false);
  });

  // (d) single key → IDENTICAL behavior + counts to today (no extra attempts).
  test("single key success: streamChat is called exactly once with that key", async () => {
    const keysSeen: Array<string | undefined> = [];
    const router = createTestRouter(
      [
        stubProvider("groq", 1, async (_messages, options) => {
          keysSeen.push(options.apiKey);
          return { stream: (async function* () { yield { content: "ok" }; })() };
        }),
      ],
      { getApiKeys: async () => ["solo"] },
    );
    const result = await router.routeAndStream({ messages });
    await drain(result.stream);
    expect(keysSeen).toEqual(["solo"]);
  });

  test("single key 401: attempted exactly once, then thrown (no extra attempts)", async () => {
    const keysSeen: Array<string | undefined> = [];
    const router = createTestRouter(
      [
        stubProvider("groq", 1, async (_messages, options) => {
          keysSeen.push(options.apiKey);
          throw new ProviderHttpError("invalid api key", 401);
        }),
      ],
      { getApiKeys: async () => ["solo"] },
    );
    await expect(router.routeAndStream({ messages })).rejects.toThrow();
    expect(keysSeen).toEqual(["solo"]);
  });

  // Back-compat: a router built with only getApiKey (no getApiKeys) still wraps a
  // single key — the streamChat receives exactly that key, one attempt.
  test("getApiKey-only construction yields a single-element key list", async () => {
    const keysSeen: Array<string | undefined> = [];
    const router = createTestRouter(
      [
        stubProvider("groq", 1, async (_messages, options) => {
          keysSeen.push(options.apiKey);
          return { stream: (async function* () { yield { content: "ok" }; })() };
        }),
      ],
      { getApiKey: async () => "legacy-key" },
    );
    const result = await router.routeAndStream({ messages });
    await drain(result.stream);
    expect(keysSeen).toEqual(["legacy-key"]);
  });

  // A per-request BYOK key takes precedence and is tried before the keychain
  // fallbacks (primary-first ordering across both sources).
  test("per-request key is primary, keychain keys are appended as fallbacks", async () => {
    const keysSeen: Array<string | undefined> = [];
    const router = createTestRouter(
      [
        stubProvider("groq", 1, async (_messages, options) => {
          keysSeen.push(options.apiKey);
          if (options.apiKey !== "chain-b") {
            throw new ProviderHttpError("invalid api key", 401);
          }
          return { stream: (async function* () { yield { content: "ok" }; })() };
        }),
      ],
      { getApiKeys: async () => ["chain-a", "chain-b"] },
    );
    const result = await router.routeAndStream({
      messages,
      keys: { groq: "req-key" },
    });
    await drain(result.stream);
    // Per-request key first, then the keychain fallbacks in order.
    expect(keysSeen).toEqual(["req-key", "chain-a", "chain-b"]);
  });
});
