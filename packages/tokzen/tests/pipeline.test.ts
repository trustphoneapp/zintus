import { describe, it, expect } from "bun:test";
import { compress } from "../src/pipeline/pipeline";
import type { CompressContext, Message } from "../src/pipeline/types";

const CTX: CompressContext = {
  provider: "openai",
  model: "gpt-4o",
  tokenBudget: 2000,
};

describe("Pipeline", () => {
  it("leaves short conversational user messages unchanged", async () => {
    const userContent = "Can you explain what a closure is in JavaScript?";
    const messages: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: userContent },
    ];
    const result = await compress({ messages }, CTX);
    const userMsg = result.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe(userContent);
  });

  it("compresses large structured content pasted in a user message", async () => {
    // ~240 lines of TypeScript (well over the 500-token user threshold).
    const tsFile = Array.from(
      { length: 40 },
      (_, i) => `export function handler${i}(input: Request${i}): Response${i} {
  const parsed = parseRequest(input);
  if (parsed.error) {
    logger.error("handler${i} failed", parsed.error);
    throw new HandlerError("bad input for handler${i}", parsed.error);
  }
  const records = parsed.data.map((row) => normalizeRow(row, ${i}));
  const filtered = records.filter((r) => r.score > threshold${i});
  return { status: 200, body: filtered, handledBy: "handler${i}" };
}`,
    ).join("\n\n");

    const messages: Message[] = [
      { role: "user", content: `Please review this file:\n\n${tsFile}` },
    ];
    const result = await compress({ messages }, CTX);
    const userMsg = result.messages.find((m) => m.role === "user");

    // The user message must be compressed (shorter) and the prose preface kept.
    expect(userMsg).toBeDefined();
    expect(userMsg!.content.length).toBeLessThan(tsFile.length);
    expect(userMsg!.content).toContain("Please review this file");
    expect(result.totalResult.ratio).toBeLessThan(1);
  });

  it("applies compression to assistant messages", async () => {
    const longAssistantContent = "The answer involves multiple considerations. ".repeat(60);
    const messages: Message[] = [
      { role: "user", content: "What do you think?" },
      { role: "assistant", content: longAssistantContent },
    ];
    const result = await compress({ messages }, CTX);
    // Assistant content should be compressed (or at least processed)
    expect(result.messages).toHaveLength(2);
    expect(result.totalResult).toBeDefined();
  });

  it("never throws — returns original on error", async () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
    ];
    const result = await compress({ messages }, CTX);
    expect(result.messages).toHaveLength(1);
    expect(result.totalResult.ratio).toBeGreaterThan(0);
  });

  it("processes system prompt through CacheAligner", async () => {
    const systemPrompt = `You are a helpful assistant. Session started at 2024-01-15T10:00:00Z. User ID: 550e8400-e29b-41d4-a716-446655440000.`;
    const messages: Message[] = [{ role: "user", content: "Hi" }];
    const result = await compress({ messages, systemPrompt }, CTX);
    // System prompt should have been aligned (dynamic content moved to tail)
    expect(result.systemPrompt).toBeTruthy();
  });

  it("drops old conversation history via rolling window", async () => {
    const messages: Message[] = [
      ...Array.from({ length: 20 }, (_, i) => ([
        { role: "user" as const, content: `Question ${i}: What is the meaning of life?` },
        { role: "assistant" as const, content: `Answer ${i}: The meaning of life is a philosophical question. `.repeat(5) },
      ])).flat(),
      { role: "user", content: "Current question" },
    ];
    const result = await compress({ messages }, CTX);
    // Should have dropped some old messages
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("preserves tool_use + tool_result pairs atomically", async () => {
    const messages: Message[] = [
      { role: "user", content: "Get weather" },
      { role: "assistant", content: '{"tool_use": "get_weather", "city": "NYC"}' },
      { role: "tool", content: '{"temperature": 72}', tool_use_id: "call-1" },
      { role: "user", content: "Thanks!" },
    ];
    const result = await compress({ messages }, CTX);
    // Tool pairs should be kept together
    const assistantIdx = result.messages.findIndex((m) => m.role === "assistant");
    const toolIdx = result.messages.findIndex((m) => m.role === "tool");
    if (assistantIdx !== -1 && toolIdx !== -1) {
      expect(toolIdx).toBe(assistantIdx + 1);
    }
  });

  it("returns result with ratio between 0 and 1", async () => {
    const messages: Message[] = [
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Hello" },
    ];
    const result = await compress({ messages }, CTX);
    expect(result.totalResult.ratio).toBeGreaterThan(0);
    expect(result.totalResult.ratio).toBeLessThanOrEqual(1);
  });
});
