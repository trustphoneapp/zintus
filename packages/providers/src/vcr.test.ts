import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamChunk, TokenUsage } from "@zintus/types";
import { groqProvider } from "./providers/groq.js";
import { geminiProvider } from "./providers/gemini.js";

/**
 * VCR-style adapter tests (Phase 5.2): replay recorded provider SSE responses
 * through the real adapters with NO network. `fetch` is stubbed to return a
 * Response whose body is the recorded fixture, so streaming + usage parsing are
 * exercised exactly as in production. No API keys required.
 */

const FIXTURES = join(import.meta.dir, "..", "..", "..", "tests", "fixtures", "providers");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

const realFetch = globalThis.fetch;

function stubFetch(body: string, headers: Record<string, string> = {}) {
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers })) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function collect(stream: AsyncIterable<StreamChunk>) {
  let content = "";
  let usage: TokenUsage | undefined;
  for await (const chunk of stream) {
    if (chunk.content) content += chunk.content;
    if (chunk.usage) usage = chunk.usage;
  }
  return { content, usage };
}

describe("provider adapters (VCR fixtures)", () => {
  test("groq (openai-compat) parses streamed content, usage, and rate-limit headers", async () => {
    stubFetch(fixture("groq.chat.sse.txt"), {
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "998",
      "x-ratelimit-reset-requests": "2m59.56s",
    });

    const result = await groqProvider.streamChat(
      [{ role: "user", content: "hi" }],
      { apiKey: "gsk_" + "a".repeat(52), model: "llama-3.3-70b-versatile" },
    );

    // Rate-limit headers surfaced for the quota ledger.
    expect(result.rateLimit?.remainingRequests).toBe("998");
    expect(result.rateLimit?.resetRequests).toBe("2m59.56s");

    const { content, usage } = await collect(result.stream);
    expect(content).toBe("Hello world");
    expect(usage?.inputTokens).toBe(11);
    expect(usage?.outputTokens).toBe(2);
  });

  test("gemini parses streamed candidate text and usageMetadata", async () => {
    stubFetch(fixture("gemini.chat.sse.txt"));

    const result = await geminiProvider.streamChat(
      [{ role: "user", content: "hi" }],
      { apiKey: "AIza" + "a".repeat(35), model: "gemini-2.5-flash" },
    );

    const { content, usage } = await collect(result.stream);
    expect(content).toBe("Hello world");
    expect(usage?.inputTokens).toBe(9);
    expect(usage?.outputTokens).toBe(2);
  });

  test("openrouter (openai-compat) reuses the same SSE contract", async () => {
    // OpenRouter is OpenAI-compatible; the groq fixture exercises the shared path.
    stubFetch(fixture("groq.chat.sse.txt"));
    const { openrouterProvider } = await import("./providers/skeletons.js");
    const result = await openrouterProvider.streamChat(
      [{ role: "user", content: "hi" }],
      { apiKey: "sk-or-" + "a".repeat(20) },
    );
    const { content, usage } = await collect(result.stream);
    expect(content).toBe("Hello world");
    expect(usage?.totalTokens).toBe(13);
  });
});
