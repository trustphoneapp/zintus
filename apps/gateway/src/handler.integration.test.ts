import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Provider, ProviderId } from "@zintus/types";
import { ProviderHttpError, estimateUsage } from "@zintus/providers";
import type { GatewayConfig } from "./auth.js";

/**
 * Gateway integration test (criterion A1): a REAL engine (not a fake) behind the
 * HTTP handler, with stubbed providers. Proves end-to-end failover + routing
 * headers over the wire, and that an identical prompt hits the L1 cache.
 */

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
    defaultModel: "stub-model",
    streamChat,
    async validateKey() {
      return true;
    },
  };
}

describe("gateway handler integration (real engine)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zintus-gw-int-"));
  });

  afterEach(() => {
    mock.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeHandler(providers: Provider[]) {
    mock.module("@zintus/providers", () => ({
      listProviders: () => providers,
      ProviderHttpError,
      estimateUsage,
    }));
    const { createEngine } = await import("@zintus/engine");
    const { createGatewayHandler } = await import("./handler.js");
    const engine = createEngine({
      conversationsPath: join(dir, "conversations.db"),
      dbPath: join(dir, "quota.db"),
      cachePath: join(dir, "cache.db"),
      getApiKey: async () => "test-key",
      persistConversations: true,
      persistTraces: true,
    });
    const config: GatewayConfig = {
      port: 8788,
      host: "127.0.0.1",
      token: "",
      corsOrigins: "*",
    };
    return createGatewayHandler({ engine, config });
  }

  test("failover is proven end-to-end over HTTP with routing headers", async () => {
    const handler = await makeHandler([
      stubProvider("gemini", 1, async () => {
        throw new ProviderHttpError("rate limited", 429);
      }),
      stubProvider("cerebras", 2, async () => ({
        stream: (async function* () {
          yield { content: "ok from cerebras" };
        })(),
      })),
    ]);

    const res = await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Provider-Used")).toBe("cerebras");
    expect(res.headers.get("X-Failover-Count")).toBe("1");
    expect(res.headers.get("X-Cache-Hit")).toBe("miss");
    const text = await res.text();
    expect(text).toContain("ok from cerebras");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("an identical prompt hits the L1 cache on the second request", async () => {
    const handler = await makeHandler([
      stubProvider("cerebras", 1, async () => ({
        stream: (async function* () {
          yield { content: "cached answer" };
        })(),
      })),
    ]);

    const body = JSON.stringify({
      messages: [{ role: "user", content: "identical prompt" }],
      stream: false,
    });
    const make = () =>
      handler(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );

    const first = await make();
    expect(first.headers.get("X-Cache-Hit")).toBe("miss");
    await first.text();

    const second = await make();
    expect(second.headers.get("X-Cache-Hit")).toBe("L1");
    const json = (await second.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(json.choices[0]?.message.content).toBe("cached answer");
  });
});
