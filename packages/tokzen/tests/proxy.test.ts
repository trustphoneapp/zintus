import { describe, it, expect } from "bun:test";
import { normalizeOpenAI, normalizeAnthropic, detectProvider, denormalizeToOpenAI } from "../src/proxy/adapter";

describe("Proxy adapter", () => {
  describe("normalizeOpenAI", () => {
    it("extracts messages and system prompt", () => {
      const body = {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
      };
      const result = normalizeOpenAI(body);
      expect(result.model).toBe("gpt-4o");
      expect(result.systemPrompt).toBe("You are helpful.");
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]?.role).toBe("user");
    });

    it("handles content as array of blocks", () => {
      const body = {
        model: "gpt-4o",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello from blocks" }] },
        ],
      };
      const result = normalizeOpenAI(body);
      expect(result.messages[0]?.content).toBe("Hello from blocks");
    });
  });

  describe("normalizeAnthropic", () => {
    it("extracts system field as systemPrompt", () => {
      const body = {
        model: "claude-sonnet-4-6",
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "Tell me about AI." }],
      };
      const result = normalizeAnthropic(body);
      expect(result.systemPrompt).toBe("You are a helpful assistant.");
      expect(result.provider).toBe("anthropic");
    });

    it("handles array system content", () => {
      const body = {
        model: "claude-sonnet-4-6",
        system: [{ type: "text", text: "Array system content." }],
        messages: [],
      };
      const result = normalizeAnthropic(body);
      expect(result.systemPrompt).toBe("Array system content.");
    });
  });

  describe("detectProvider", () => {
    it("detects anthropic from anthropic-version header", () => {
      const url = new URL("http://localhost:8787/v1/messages");
      const headers = new Headers({ "anthropic-version": "2023-06-01" });
      expect(detectProvider(url, headers)).toBe("anthropic");
    });

    it("detects x-tokzen-provider header override", () => {
      const url = new URL("http://localhost:8787/v1/chat/completions");
      const headers = new Headers({ "x-tokzen-provider": "groq" });
      expect(detectProvider(url, headers)).toBe("groq");
    });

    it("defaults to openai for unknown providers", () => {
      const url = new URL("http://localhost:8787/v1/chat/completions");
      const headers = new Headers();
      expect(detectProvider(url, headers)).toBe("openai");
    });
  });

  describe("denormalizeToOpenAI", () => {
    it("reconstructs messages with compressed system", () => {
      const normalized = normalizeOpenAI({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "Original system." },
          { role: "user", content: "Hello" },
        ],
      });
      const compressed = [{ role: "user" as const, content: "Hello" }];
      const result = denormalizeToOpenAI(normalized, compressed, "Compressed system.");
      expect(result["messages"]).toHaveLength(2);
      const msgs = result["messages"] as Array<{ role: string; content: string }>;
      expect(msgs[0]?.role).toBe("system");
      expect(msgs[0]?.content).toBe("Compressed system.");
    });
  });
});
