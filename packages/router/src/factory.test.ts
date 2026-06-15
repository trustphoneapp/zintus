import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, Provider, ProviderId } from "@multipleai/types";
import { ProviderHttpError } from "@multipleai/providers";
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
    `multipleai-router-test-${Date.now()}-${Math.random()}.db`,
  );
  dbPaths.push(dbPath);

  mock.module("@multipleai/providers", () => ({
    listProviders: () => providers,
    ProviderHttpError,
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
});
