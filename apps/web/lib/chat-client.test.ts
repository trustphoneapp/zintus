import { describe, expect, test } from "bun:test";
import {
  sanitizeSendHistory,
  imageAwareHistory,
  type ChatMessage,
  type StoredTurn,
} from "./chat-client";

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

describe("imageAwareHistory", () => {
  test("annotates a prior user turn that carried an image", () => {
    const input: StoredTurn[] = [
      { role: "user", content: "what do you see", images: [{}] },
      { role: "assistant", content: "a screenshot of a desktop" },
    ];
    // Full-array compare (no index access): user turn annotated, assistant
    // turn untouched.
    expect(imageAwareHistory(input)).toEqual([
      {
        role: "user",
        content:
          "what do you see\n\n[This earlier message had 1 attached image, not shown here — a different image from any attached later.]",
      },
      { role: "assistant", content: "a screenshot of a desktop" },
    ]);
  });

  test("pluralizes the note for multiple images", () => {
    const joined = imageAwareHistory([
      { role: "user", content: "compare these", images: [{}, {}, {}] },
    ])
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(joined).toContain("had 3 attached images, not shown here");
  });

  test("leaves a user turn WITHOUT images unchanged (no note)", () => {
    const input: StoredTurn[] = [{ role: "user", content: "hello" }];
    expect(imageAwareHistory(input)).toEqual([{ role: "user", content: "hello" }]);
    // An empty images array is not an image turn.
    expect(
      imageAwareHistory([{ role: "user", content: "hi", images: [] }]),
    ).toEqual([{ role: "user", content: "hi" }]);
  });

  test("the exact bug: a NEW image turn is not conflated with the old one", () => {
    // Turn 1 had image A (bytes now stripped), assistant described it, turn 2
    // brings a DIFFERENT image B. The old turn must be marked so the model does
    // not answer "the same screenshot as before".
    const history: StoredTurn[] = [
      { role: "user", content: "what do you see", images: [{ name: "A.png" }] },
      { role: "assistant", content: "long description of screenshot A" },
    ];
    const joined = imageAwareHistory(history)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(joined).toContain("not shown here");
    expect(joined).toContain("a different image from any attached later");
  });

  test("never mutates the input array or its messages", () => {
    const input: StoredTurn[] = [
      { role: "user", content: "x", images: [{}] },
      { role: "assistant", content: "y" },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    imageAwareHistory(input);
    expect(input).toEqual(snapshot);
  });
});
