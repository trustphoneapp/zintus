import { describe, expect, it } from "bun:test";
// Imported from ./messages (react-native-free) rather than ./chat, which pulls
// in NativeModules/MMKV via ./gateway-url and can't load under bun. ./chat
// re-exports both helpers, so the runtime path is identical.
import { buildChatRequestBody, parseChatMeta } from "./messages";

describe("parseChatMeta", () => {
  it("parses route_reason (and the rest of the metadata frame)", () => {
    const meta = parseChatMeta({
      type: "metadata",
      provider: "groq",
      model: "llama-3.3-70b",
      tokens: { input: 12, output: 34 },
      latency_ms: 512,
      cost_usd: 0,
      saved_vs_claude_sonnet: 0.004,
      routing_strategy: "economy",
      route_reason: "cheapest healthy provider",
      private_mode_honored: true,
    });
    expect(meta).toEqual({
      provider: "groq",
      model: "llama-3.3-70b",
      inputTokens: 12,
      outputTokens: 34,
      latencyMs: 512,
      costUsd: 0,
      savedUsd: 0.004,
      routingStrategy: "economy",
      routeReason: "cheapest healthy provider",
      privacyHonored: true,
    });
  });

  it("returns undefined for a non-metadata content frame", () => {
    expect(
      parseChatMeta({
        provider: "groq",
        choices: [{ delta: { content: "hi" } }],
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a metadata frame with no provider", () => {
    expect(parseChatMeta({ type: "metadata" })).toBeUndefined();
  });

  it("leaves routeReason undefined when the trace recorded no reason", () => {
    const meta = parseChatMeta({ type: "metadata", provider: "gemini" });
    expect(meta?.routeReason).toBeUndefined();
    expect(meta?.routingStrategy).toBe("auto");
  });
});

describe("buildChatRequestBody", () => {
  it("threads responseFormat through to snake_case response_format", () => {
    const body = buildChatRequestBody({
      messages: [{ role: "user", content: "hi" }],
      responseFormat: { type: "json_object" },
    });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.stream).toBe(true);
  });

  it("omits response_format (undefined) when JSON mode is off", () => {
    const body = buildChatRequestBody({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.response_format).toBeUndefined();
  });

  it("maps provider/strategy/mode/thread_id onto the wire body", () => {
    const body = buildChatRequestBody({
      messages: [{ role: "user", content: "hi" }],
      providerId: "groq",
      strategy: "fastest",
      mode: "smart",
      threadId: "t-1",
    });
    expect(body.provider).toBe("groq");
    expect(body.strategy).toBe("fastest");
    expect(body.mode).toBe("smart");
    expect(body.thread_id).toBe("t-1");
  });
});
