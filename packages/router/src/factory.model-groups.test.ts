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

function createTestRouter(providers: Provider[], extra: Partial<RouterConfig> = {}) {
  const dbPath = join(
    tmpdir(),
    `zintus-mg-test-${Date.now()}-${Math.random()}.db`,
  );
  dbPaths.push(dbPath);

  mock.module("@zintus/providers", () => ({
    listProviders: () => providers,
    ProviderHttpError,
    estimateUsage,
  }));

  return createRouter({ dbPath, getApiKey: async () => "test-key", ...extra });
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

describe("createRouter model groups (same-model failover)", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

  test("fails over across the group's providers in listed order", async () => {
    const calls: ProviderId[] = [];

    const router = createTestRouter(
      [
        // cerebras would normally sort first by priority, but it is NOT in the
        // group, so it must never be tried for this logical model.
        stubProvider("cerebras", 1, async () => {
          calls.push("cerebras");
          return { stream: (async function* () { yield { content: "nope" }; })() };
        }),
        stubProvider("gemini", 3, async () => {
          calls.push("gemini");
          throw new ProviderHttpError("rate limited", 429);
        }),
        stubProvider("groq", 5, async () => {
          calls.push("groq");
          return { stream: (async function* () { yield { content: "from groq" }; })() };
        }),
      ],
      { modelGroups: { "llama-3.3-70b": ["gemini", "groq"] } },
    );

    const res = await router.routeAndStream({ messages, model: "llama-3.3-70b" });
    expect(res.providerId).toBe("groq");
    await drain(res.stream);

    // gemini tried first (429), then groq. cerebras never touched.
    expect(calls).toEqual(["gemini", "groq"]);
    expect(calls).not.toContain("cerebras");
  });

  test("uses the first eligible group member, ignoring out-of-group priority", async () => {
    const calls: ProviderId[] = [];

    const router = createTestRouter(
      [
        stubProvider("cerebras", 1, async () => {
          calls.push("cerebras");
          return { stream: (async function* () { yield { content: "cb" }; })() };
        }),
        stubProvider("gemini", 9, async () => {
          calls.push("gemini");
          return { stream: (async function* () { yield { content: "gm" }; })() };
        }),
      ],
      { modelGroups: { logical: ["gemini", "cerebras"] } },
    );

    const res = await router.routeAndStream({ messages, model: "logical" });
    expect(res.providerId).toBe("gemini");
    await drain(res.stream);
    expect(calls).toEqual(["gemini"]);
  });

  test("policy.modelGroups is honored when no explicit config is given", async () => {
    const router = createTestRouter(
      [
        stubProvider("gemini", 1, async () => {
          throw new ProviderHttpError("rate limited", 429);
        }),
        stubProvider("groq", 2, async () => ({
          stream: (async function* () { yield { content: "ok" }; })(),
        })),
      ],
      { policy: { modelGroups: { grp: ["gemini", "groq"] } } },
    );

    const res = await router.routeAndStream({ messages, model: "grp" });
    expect(res.providerId).toBe("groq");
    await drain(res.stream);
  });
});
