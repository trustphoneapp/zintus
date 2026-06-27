import { describe, expect, test } from "bun:test";
import { splitGeminiMessages } from "./gemini.js";

const img = (
  data: string,
  mimeType: "image/png" | "image/jpeg" = "image/png",
) => ({ type: "image" as const, data, mimeType, bytes: 100, exifStripped: true as const });

describe("splitGeminiMessages — vision mapping", () => {
  test("text-only messages map to {text} parts (unchanged)", () => {
    const out = splitGeminiMessages([{ role: "user", content: "hello" }]);
    expect(out.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(out.systemInstruction).toBeUndefined();
  });

  test("a user text + image message becomes text + inlineData parts", () => {
    const out = splitGeminiMessages([
      {
        role: "user",
        content: [{ type: "text", text: "what is this?" }, img("AAA")],
      },
    ]);
    expect(out.contents[0]!.parts).toEqual([
      { text: "what is this?" },
      { inlineData: { mimeType: "image/png", data: "AAA" } },
    ]);
  });

  test("multiple images are included in order", () => {
    const out = splitGeminiMessages([
      { role: "user", content: [img("A"), img("B", "image/jpeg")] },
    ]);
    expect(out.contents[0]!.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "A" } },
      { inlineData: { mimeType: "image/jpeg", data: "B" } },
    ]);
  });

  test("system messages still go to systemInstruction (text)", () => {
    const out = splitGeminiMessages([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    expect(out.systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
    expect(out.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  test("an image in a system message is rejected (never silently dropped)", () => {
    expect(() =>
      splitGeminiMessages([
        { role: "system", content: [{ type: "text", text: "x" }, img("Z")] },
      ]),
    ).toThrow(/system message/);
  });

  test("assistant turns stay text-only", () => {
    const out = splitGeminiMessages([
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "follow up" },
    ]);
    expect(out.contents[0]).toEqual({
      role: "model",
      parts: [{ text: "prior answer" }],
    });
  });
});
