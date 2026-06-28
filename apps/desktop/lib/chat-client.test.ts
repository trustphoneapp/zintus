import { describe, expect, test } from "bun:test";
import { sanitizeSendHistory, type ChatMessage } from "./chat-client";

describe("sanitizeSendHistory", () => {
  test("drops an empty-content assistant turn (blank string)", () => {
    const input: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "   " },
    ];
    expect(sanitizeSendHistory(input)).toEqual([{ role: "user", content: "hi" }]);
  });

  test("drops an assistant turn with an empty block array", () => {
    const input: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [] },
    ];
    expect(sanitizeSendHistory(input)).toEqual([{ role: "user", content: "hi" }]);
  });

  test("merges two adjacent assistant string turns with a newline", () => {
    const input: ChatMessage[] = [
      { role: "user", content: "1234 * 5678?" },
      { role: "assistant", content: "let me compute" },
      { role: "assistant", content: "the answer is 7006652" },
    ];
    expect(sanitizeSendHistory(input)).toEqual([
      { role: "user", content: "1234 * 5678?" },
      { role: "assistant", content: "let me compute\nthe answer is 7006652" },
    ]);
  });

  test("leaves a non-string (block array) turn un-merged", () => {
    const blocks: ChatMessage = {
      role: "assistant",
      content: [{ type: "text", text: "with a tool call" }],
    };
    const input: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "preamble" },
      blocks,
    ];
    const out = sanitizeSendHistory(input);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual(blocks);
  });

  test("passes a normal user/assistant alternation through unchanged", () => {
    const input: ChatMessage[] = [
      { role: "system", content: "be helpful" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "thanks" },
    ];
    expect(sanitizeSendHistory(input)).toEqual(input);
  });

  test("preserves a trailing user turn", () => {
    const input: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const out = sanitizeSendHistory(input);
    expect(out[out.length - 1]).toEqual({ role: "user", content: "c" });
  });

  test("never mutates the input array or its messages", () => {
    const input: ChatMessage[] = [
      { role: "assistant", content: "x" },
      { role: "assistant", content: "y" },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeSendHistory(input);
    expect(input).toEqual(snapshot);
  });
});
