import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, Provider, ProviderId } from "@zintus/types";
import { ProviderHttpError, estimateUsage } from "@zintus/providers";
import {
  createRouter,
  reservedOutputTokens,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  type RouteAttemptEvent,
  type RouterConfig,
} from "./factory.js";

const dbPaths: string[] = [];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Yield to the event loop until `cond` holds (or fail loudly on timeout). */
async function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("until(): condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

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
    `zintus-router-test-${Date.now()}-${Math.random()}.db`,
  );
  dbPaths.push(dbPath);

  mock.module("@zintus/providers", () => ({
    listProviders: () => providers,
    ProviderHttpError,
    estimateUsage,
    // Match the real trainers used by the privacy filter (see data-policies.ts).
    trainsOnUserData: (id: ProviderId) => id === "gemini" || id === "cohere",
    // may-train = trains OR an "unknown" policy (openrouter/deepseek/xai/
    // huggingface). The privacy filter uses THIS predicate, so an undocumented
    // provider is dropped under private mode rather than silently leaking.
    mayTrainOnUserData: (id: ProviderId) =>
      id === "gemini" ||
      id === "cohere" ||
      id === "openrouter" ||
      id === "deepseek" ||
      id === "xai" ||
      id === "huggingface",
    // Only gemini is vision-capable in these tests (matches the real default).
    supportsVision: (id: ProviderId, _model?: string) => id === "gemini",
    // Tool-capable everywhere EXCEPT huggingface/lmstudio (matches the real
    // registry: those two have tools:false), so the tool gate has a non-tool
    // provider to filter out.
    supportsTools: (id: ProviderId, _model?: string) =>
      id !== "huggingface" && id !== "lmstudio",
  }));

  return createRouter({
    dbPath,
    getApiKey: async () => "test-key",
    ...extraConfig,
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

  test("failsover from a Bun connection-refused error to the next provider", async () => {
    // Bun's fetch throws a plain Error (name "Error", NOT TypeError) with
    // code "ConnectionRefused" and this exact message when nothing is listening
    // (e.g. Ollama not running on localhost:11434). Before the fix this matched
    // none of the network-error patterns, so the whole route aborted with the
    // raw Bun message instead of failing over to a healthy provider.
    let cerebrasCalls = 0;
    const router = createTestRouter([
      stubProvider("cerebras", 1, async () => {
        cerebrasCalls += 1;
        const error = new Error(
          "Unable to connect. Is the computer able to access the url?",
        );
        (error as Error & { code: string }).code = "ConnectionRefused";
        throw error;
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

  test("failsover on a Bun network error code even with an unrecognized message", async () => {
    // Guards the `code`-based match on its own: other Bun network failures
    // (ConnectionClosed, FailedToOpenSocket, DNSResolveFailed, Timeout) carry
    // different messages, so failover must not depend on message text.
    const router = createTestRouter([
      stubProvider("cerebras", 1, async () => {
        const error = new Error("socket hang up mid-handshake");
        (error as Error & { code: string }).code = "FailedToOpenSocket";
        throw error;
      }),
      stubProvider("groq", 2, async () => ({
        stream: (async function* () {
          yield { content: "ok" };
        })(),
      })),
    ]);

    const result = await router.routeAndStream({ messages });
    expect(result.providerId).toBe("groq");
    for await (const _chunk of result.stream) {
      // drain
    }
  });

  test("localRuntimeAlive=false makes ollama ineligible (never dispatched)", async () => {
    let ollamaCalls = 0;
    const router = createTestRouter(
      [
        stubProvider("ollama", 1, async () => {
          ollamaCalls += 1;
          throw new Error("should never be dispatched");
        }),
        stubProvider("groq", 2, async () => ({
          stream: (async function* () {
            yield { content: "ok" };
          })(),
        })),
      ],
      { localRuntimeAlive: async () => false },
    );

    const result = await router.routeAndStream({ messages });
    expect(ollamaCalls).toBe(0);
    expect(result.providerId).toBe("groq");
    for await (const _chunk of result.stream) {
      // drain
    }
  });

  test("localRuntimeAlive=true keeps a local runtime routable", async () => {
    const router = createTestRouter(
      [
        stubProvider("ollama", 1, async () => ({
          stream: (async function* () {
            yield { content: "local" };
          })(),
        })),
      ],
      { localRuntimeAlive: async () => true },
    );

    const result = await router.routeAndStream({ messages });
    expect(result.providerId).toBe("ollama");
    for await (const _chunk of result.stream) {
      // drain
    }
  });

  test("without a localRuntimeAlive prober, local runtimes stay eligible (back-compat)", async () => {
    const router = createTestRouter([
      stubProvider("ollama", 1, async () => ({
        stream: (async function* () {
          yield { content: "local" };
        })(),
      })),
    ]);

    const result = await router.routeAndStream({ messages });
    expect(result.providerId).toBe("ollama");
    for await (const _chunk of result.stream) {
      // drain
    }
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
    // groq is a no-training provider → privacy was honored.
    expect(result.privacyHonored).toBe(true);
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
    // The user explicitly allowed gemini → privacy is considered honored.
    expect(result.privacyHonored).toBe(true);
  });

  test("privacyHonored=false when only may-train providers remain (strand fallback)", async () => {
    // Only gemini (a trainer) is available and it is NOT allow-listed. Filtering
    // would strand the request, so the router uses it anyway — but must FLAG that
    // privacy could not be honored instead of silently training on the prompt.
    const router = createTestRouter([
      stubProvider("gemini", 1, async () => ({
        stream: (async function* () { yield { content: "g" }; })(),
      })),
    ]);

    const result = await router.routeAndStream({
      messages,
      blockTrainingProviders: true,
    });
    for await (const _chunk of result.stream) {
      // drain
    }
    expect(result.providerId).toBe("gemini");
    expect(result.privacyHonored).toBe(false);
  });

  test("privacy mode excludes 'unknown'-policy providers when a safe one exists", async () => {
    // openrouter has an "unknown" training policy. Before the fix it slipped
    // through (the filter used trainsOnUserData, true only for documented
    // trainers); now it is treated as may-train and dropped in favor of groq.
    const calls: string[] = [];
    const router = createTestRouter([
      stubProvider("openrouter", 1, async () => {
        calls.push("openrouter");
        return { stream: (async function* () { yield { content: "o" }; })() };
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
    expect(calls).not.toContain("openrouter");
    expect(result.privacyHonored).toBe(true);
  });

  test("privacyHonored is undefined when private mode is off", async () => {
    const router = createTestRouter([
      stubProvider("gemini", 1, async () => ({
        stream: (async function* () { yield { content: "g" }; })(),
      })),
    ]);

    const result = await router.routeAndStream({ messages });
    for await (const _chunk of result.stream) {
      // drain
    }
    expect(result.privacyHonored).toBeUndefined();
  });

  const imageMessages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "what is this?" },
        {
          type: "image" as const,
          data: "AAA",
          mimeType: "image/png" as const,
          bytes: 10,
          exifStripped: true as const,
        },
      ],
    },
  ];

  test("vision: an image request routes to a vision-capable provider", async () => {
    const router = createTestRouter([
      stubProvider("groq", 1, async () => ({
        stream: (async function* () { yield { content: "no" }; })(),
      })),
      stubProvider("gemini", 2, async () => ({
        stream: (async function* () { yield { content: "a cat" }; })(),
      })),
    ]);
    // groq (priority 1) is filtered out for lacking vision → gemini serves it.
    const result = await router.routeAndStream({ messages: imageMessages });
    for await (const _chunk of result.stream) {
      // drain
    }
    expect(result.providerId).toBe("gemini");
  });

  test("vision: an image request with NO vision provider throws unsupported_capability", async () => {
    const router = createTestRouter([
      stubProvider("groq", 1, async () => ({
        stream: (async function* () { yield { content: "x" }; })(),
      })),
    ]);
    await expect(
      router.routeAndStream({ messages: imageMessages }),
    ).rejects.toThrow(/unsupported_capability/);
  });

  test("vision: a forced non-vision provider on an image request fails (no silent switch)", async () => {
    const router = createTestRouter([
      stubProvider("groq", 1, async () => ({
        stream: (async function* () { yield { content: "x" }; })(),
      })),
      stubProvider("gemini", 2, async () => ({
        stream: (async function* () { yield { content: "y" }; })(),
      })),
    ]);
    // User explicitly forced groq — must NOT be silently re-routed to gemini.
    await expect(
      router.routeAndStream({ messages: imageMessages, provider: "groq" }),
    ).rejects.toThrow(/unsupported_capability/);
  });

  test("vision: an explicit openrouter vision model does NOT fail over onto a non-vision free model", async () => {
    const VISION_MODEL = "meta-llama/llama-3.2-90b-vision-instruct";
    const dbPath = join(
      tmpdir(),
      `zintus-vision-refilter-${Date.now()}-${Math.random()}.db`,
    );
    dbPaths.push(dbPath);
    const attemptedModels: string[] = [];
    mock.module("@zintus/providers", () => ({
      listProviders: () => [
        stubProvider("openrouter", 1, async (_messages, options) => {
          attemptedModels.push(options.model ?? "default");
          // The vision model is rate-limited → WITHOUT the vision re-filter the
          // router would fail over onto the non-vision free models and re-send the
          // image blocks to a blind model (silent downgrade). With the re-filter,
          // the free models are dropped and the request fails honestly instead.
          throw new ProviderHttpError("rate limited", 429);
        }),
      ],
      ProviderHttpError,
      estimateUsage,
      trainsOnUserData: () => false,
      mayTrainOnUserData: () => false,
      // Model-aware: only the explicit vision model is vision-capable; the
      // openrouter free fallbacks are text-only.
      supportsVision: (id: ProviderId, model?: string) =>
        id === "openrouter" && model === VISION_MODEL,
      supportsTools: () => true,
    }));
    const router = createRouter({ dbPath, getApiKey: async () => "test-key" });

    await expect(
      router.routeAndStream({ messages: imageMessages, model: VISION_MODEL }),
    ).rejects.toThrow();

    // ONLY the vision model was attempted — the non-vision free models were never
    // tried (the image blocks are never re-sent to a blind model).
    expect(attemptedModels).toEqual([VISION_MODEL]);
    expect(attemptedModels.some((m) => m.includes(":free"))).toBe(false);
  });

  const weatherTool = {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  };

  test("tools: a tools request routes to a tool-capable provider", async () => {
    const router = createTestRouter([
      stubProvider("huggingface", 1, async () => ({
        stream: (async function* () { yield { content: "no tools" }; })(),
      })),
      stubProvider("groq", 2, async () => ({
        stream: (async function* () {
          yield {
            toolCall: {
              type: "tool_call" as const,
              id: "call_get_weather_0",
              name: "get_weather",
              arguments: { city: "Paris" },
            },
          };
          yield { finishReason: "tool_calls" as const };
        })(),
      })),
    ]);
    // huggingface (priority 1) is filtered out for lacking tools → groq serves it.
    const result = await router.routeAndStream({
      messages,
      tools: [weatherTool],
    });
    for await (const _chunk of result.stream) {
      // drain
    }
    expect(result.providerId).toBe("groq");
    // The parallel tool-call channel is populated after the drain.
    expect(result.toolCalls?.[0]?.name).toBe("get_weather");
    expect(result.toolCalls?.[0]?.arguments).toEqual({ city: "Paris" });
  });

  test("tools: a tools request with NO tool-capable provider throws unsupported_capability", async () => {
    const router = createTestRouter([
      stubProvider("huggingface", 1, async () => ({
        stream: (async function* () { yield { content: "x" }; })(),
      })),
    ]);
    await expect(
      router.routeAndStream({ messages, tools: [weatherTool] }),
    ).rejects.toThrow(/unsupported_capability/);
  });

  test("tools: a forced non-tool provider on a tools request fails (no silent switch)", async () => {
    const router = createTestRouter([
      stubProvider("huggingface", 1, async () => ({
        stream: (async function* () { yield { content: "x" }; })(),
      })),
      stubProvider("groq", 2, async () => ({
        stream: (async function* () { yield { content: "y" }; })(),
      })),
    ]);
    await expect(
      router.routeAndStream({
        messages,
        tools: [weatherTool],
        provider: "huggingface",
      }),
    ).rejects.toThrow(/unsupported_capability/);
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

// The pre-dispatch reservation gate must estimate a request's OUTPUT before the
// model produces a token. The old fixed 1024 under-counted any substantive
// completion, so a concurrent burst of unbounded requests could overshoot a
// provider's tokensPerMinute cap by (actual − 1024) × concurrency before
// recordUsage reconciled it. These cover the realistic-reserve fix + the
// invariant that an explicit maxTokens is still honored EXACTLY.
describe("reservedOutputTokens (pre-dispatch output budget)", () => {
  test("no maxTokens → reserves the higher default, not the old fixed 1024", () => {
    expect(reservedOutputTokens(undefined)).toBe(DEFAULT_OUTPUT_RESERVE_TOKENS);
    expect(reservedOutputTokens(undefined)).toBeGreaterThan(1024);
  });

  test("non-positive maxTokens counts as 'no cap given' → default", () => {
    expect(reservedOutputTokens(0)).toBe(DEFAULT_OUTPUT_RESERVE_TOKENS);
    expect(reservedOutputTokens(-1)).toBe(DEFAULT_OUTPUT_RESERVE_TOKENS);
  });

  test("an explicit maxTokens is honored EXACTLY (never inflated to the default)", () => {
    expect(reservedOutputTokens(256)).toBe(256);
    expect(reservedOutputTokens(8192)).toBe(8192);
    // Even a tiny explicit budget below the default is respected to the token.
    expect(reservedOutputTokens(100)).toBe(100);
  });

  test("the default is overridable per-router (configurable, not hard-coded)", () => {
    expect(reservedOutputTokens(undefined, 2048)).toBe(2048);
    // An explicit cap still wins over a custom default.
    expect(reservedOutputTokens(512, 2048)).toBe(512);
  });
});

describe("createRouter output reservation under a concurrent burst (TPM overshoot guard)", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  // Same heuristic the router uses internally (estimateUsage is passed through
  // the @zintus/providers mock unchanged), so the expected per-request reserve
  // is input + outputBudget.
  const inputTokens = estimateUsage(messages, "").inputTokens;

  // Drives N concurrent requests at a single tokensPerMinute-capped provider
  // whose streamChat BLOCKS in flight (holding its reservation), then waits until
  // every request has cleared the gate (admitted ones blocked inside streamChat,
  // the rest rejected). Returns how many were admitted — exactly floor(TPM / R).
  async function admittedUnderBurst(opts: {
    tpm: number;
    perRequestMaxTokens?: number;
    burst: number;
  }): Promise<number> {
    let entered = 0;
    let rejected = 0;
    const block = deferred();
    const router = createTestRouter(
      [
        stubProvider("cerebras", 1, async () => {
          entered += 1;
          await block.promise; // hold the reservation live for the whole burst
          return {
            stream: (async function* () {
              yield { content: "ok" };
            })(),
          };
        }),
      ],
      { limits: { cerebras: { tokensPerMinute: opts.tpm } } },
    );

    const inflight = Array.from({ length: opts.burst }, () =>
      router
        .routeAndStream({ messages, maxTokens: opts.perRequestMaxTokens })
        .catch(() => {
          // A request the gate rejected throws "All providers exhausted".
          rejected += 1;
          return null;
        }),
    );

    await until(() => entered + rejected === opts.burst);
    const admitted = entered;

    // Release everything and drain so reservations are reclaimed cleanly.
    block.resolve();
    const settled = await Promise.allSettled(inflight);
    await Promise.all(
      settled.map(async (s) => {
        if (s.status === "fulfilled" && s.value) {
          for await (const _chunk of s.value.stream) {
            // drain → triggers the reservation release
          }
        }
      }),
    );
    return admitted;
  }

  test("no maxTokens: a burst reserves the realistic 4096 budget, capping admissions far below the old 1024 reserve", async () => {
    const TPM = 20_000;
    const reserveNew = inputTokens + DEFAULT_OUTPUT_RESERVE_TOKENS;
    const expectedAdmitted = Math.floor(TPM / reserveNew);
    // The old fixed-1024 reserve would have let this many through — the overshoot.
    const wouldAdmitAtOld1024 = Math.floor(TPM / (inputTokens + 1024));

    const admitted = await admittedUnderBurst({
      tpm: TPM,
      burst: wouldAdmitAtOld1024 + 2, // enough to saturate even the old reserve
    });

    // Admitted exactly floor(TPM / (input + 4096)) — proof the gate now reserves
    // the realistic 4096 output budget, not 1024.
    expect(admitted).toBe(expectedAdmitted);
    // Strictly fewer than the old 1024 reserve would have admitted → the burst
    // can no longer overshoot the TPM cap the way it used to.
    expect(admitted).toBeLessThan(wouldAdmitAtOld1024);
    // ...but not over-reserved into starvation.
    expect(admitted).toBeGreaterThan(0);
    // The cap held: total reserved output never exceeded the per-minute budget.
    expect(admitted * reserveNew).toBeLessThanOrEqual(TPM);
  });

  test("explicit maxTokens is reserved EXACTLY at the gate (not inflated to the 4096 default)", async () => {
    const TPM = 12_000;
    const MAX = 2_000; // caller's own output cap; > 1024 and < the 4096 default
    const reserveExact = inputTokens + MAX;
    const expectedAdmitted = Math.floor(TPM / reserveExact);

    const admitted = await admittedUnderBurst({
      tpm: TPM,
      perRequestMaxTokens: MAX,
      burst: expectedAdmitted + 3,
    });

    // Reserved input + 2000 per request (the explicit cap), NOT input + 4096.
    expect(admitted).toBe(expectedAdmitted);
    // Honoring 2000 (< 4096) admits strictly more than the default would have —
    // the caller's smaller budget is respected to the token, not over-reserved.
    expect(admitted).toBeGreaterThan(
      Math.floor(TPM / (inputTokens + DEFAULT_OUTPUT_RESERVE_TOKENS)),
    );
  });
});
