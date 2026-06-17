import { describe, expect, test } from "bun:test";
import { parseOpenAiSseStream } from "./utils.js";

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

describe("parseOpenAiSseStream", () => {
  test("yields content and a provider usage chunk from include_usage output", async () => {
    const stream = sseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    let text = "";
    let usageSeen: { inputTokens: number; outputTokens: number; source: string } | null =
      null;
    for await (const chunk of parseOpenAiSseStream(stream)) {
      if (chunk.content) {
        text += chunk.content;
      }
      if (chunk.usage) {
        usageSeen = chunk.usage;
      }
    }

    expect(text).toBe("Hello");
    expect(usageSeen).not.toBeNull();
    expect(usageSeen?.inputTokens).toBe(11);
    expect(usageSeen?.outputTokens).toBe(3);
    expect(usageSeen?.source).toBe("provider");
  });

  test("handles streams without a usage payload", async () => {
    const stream = sseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    let text = "";
    let sawUsage = false;
    for await (const chunk of parseOpenAiSseStream(stream)) {
      if (chunk.content) {
        text += chunk.content;
      }
      if (chunk.usage) {
        sawUsage = true;
      }
    }

    expect(text).toBe("hi");
    expect(sawUsage).toBe(false);
  });
});
