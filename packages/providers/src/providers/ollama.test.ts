import { afterEach, describe, expect, test } from "bun:test";
import type { ChatMessage } from "@zintus/types";
import { installedLocalVisionModel, toOllamaMessages } from "./ollama.js";

/**
 * Pure/fetch-stubbed tests for the Ollama adapter's local-vision pieces:
 *  - toOllamaMessages: engine ChatMessages → native /api/chat shape (text in
 *    `content`, images in `images: [base64]` — Ollama does NOT speak OpenAI
 *    content parts).
 *  - installedLocalVisionModel: resolves the first INSTALLED multimodal model
 *    from /api/tags (stubbed — no live runtime in unit tests).
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("toOllamaMessages", () => {
  test("plain-string messages pass through untouched", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ];
    expect(toOllamaMessages(messages)).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  test("block content flattens text and lifts image base64 into images[]", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what do you see" },
          {
            type: "image",
            data: "AAAABBBB",
            mimeType: "image/jpeg",
            bytes: 8,
            exifStripped: true,
          },
        ],
      },
    ];
    expect(toOllamaMessages(messages)).toEqual([
      { role: "user", content: "what do you see", images: ["AAAABBBB"] },
    ]);
  });

  test("text-only block content emits no images field", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    ];
    expect(toOllamaMessages(messages)).toEqual([{ role: "user", content: "a\nb" }]);
  });
});

describe("installedLocalVisionModel", () => {
  test("returns the first installed multimodal family, skipping text models", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [{ name: "qwen2.5:0.5b" }, { name: "moondream:latest" }, { name: "llava:7b" }],
        }),
      )) as typeof fetch;
    expect(await installedLocalVisionModel("http://stub")).toBe("moondream:latest");
  });

  test("null when only text models are installed", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: [{ name: "llama3.3:latest" }] }))) as typeof fetch;
    expect(await installedLocalVisionModel("http://stub")).toBeNull();
  });

  test("null when Ollama is unreachable (never throws)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await installedLocalVisionModel("http://stub")).toBeNull();
  });
});
