import { afterEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Provider, ProviderId } from "@multipleai/types";
import { ProviderHttpError, estimateUsage } from "@multipleai/providers";
import { createRouter } from "./factory.js";

const dbPaths: string[] = [];

function stubProvider(id: ProviderId, validateKey: () => Promise<boolean>): Provider {
  return {
    id,
    name: id,
    color: "#000000",
    priority: 1,
    keyRegex: /^test$/,
    defaultModel: "test-model",
    async streamChat() {
      return { stream: (async function* () {})() };
    },
    validateKey,
  };
}

function createTestRouter(providers: Provider[]) {
  const dbPath = join(tmpdir(), `multipleai-probe-${Date.now()}-${Math.random()}.db`);
  dbPaths.push(dbPath);
  mock.module("@multipleai/providers", () => ({
    listProviders: () => providers,
    ProviderHttpError,
    estimateUsage,
  }));
  return createRouter({ dbPath, getApiKey: async () => "test-key" });
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

describe("createRouter probeProviders", () => {
  test("reports ok per provider and records a failure for unreachable ones", async () => {
    const router = createTestRouter([
      stubProvider("groq", async () => true),
      stubProvider("gemini", async () => false),
      stubProvider("cohere", async () => {
        throw new ProviderHttpError("unauthorized", 401);
      }),
    ]);

    const results = await router.probeProviders();
    const byId = new Map(results.map((r) => [r.providerId, r.ok]));
    expect(byId.get("groq")).toBe(true);
    expect(byId.get("gemini")).toBe(false);
    expect(byId.get("cohere")).toBe(false);
  });

  test("skips local providers with no remote key", async () => {
    const router = createTestRouter([
      stubProvider("ollama", async () => true),
      stubProvider("groq", async () => true),
    ]);
    const results = await router.probeProviders();
    expect(results.map((r) => r.providerId)).toEqual(["groq"]);
  });
});
