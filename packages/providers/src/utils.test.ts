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

  test("surfaces reasoning and cached-token details from the usage frame", async () => {
    const stream = sseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 200,
          completion_tokens: 120,
          total_tokens: 320,
          completion_tokens_details: { reasoning_tokens: 90 },
          prompt_tokens_details: { cached_tokens: 150 },
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    let usageSeen: import("@zintus/types").TokenUsage | undefined;
    for await (const chunk of parseOpenAiSseStream(stream)) {
      if (chunk.usage) {
        usageSeen = chunk.usage;
      }
    }

    expect(usageSeen?.reasoningTokens).toBe(90);
    expect(usageSeen?.cacheReadTokens).toBe(150);
    expect(usageSeen?.cacheWriteTokens).toBeUndefined();
  });

  test("usage detail fields stay absent when the provider omits the detail objects", async () => {
    const stream = sseStream([
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    let usageSeen: import("@zintus/types").TokenUsage | undefined;
    for await (const chunk of parseOpenAiSseStream(stream)) {
      if (chunk.usage) {
        usageSeen = chunk.usage;
      }
    }

    expect(usageSeen).toBeDefined();
    expect("reasoningTokens" in (usageSeen ?? {})).toBe(false);
    expect("cacheReadTokens" in (usageSeen ?? {})).toBe(false);
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

  test("accumulates a single tool call split across argument fragments", async () => {
    const stream = sseStream([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "get_weather" } },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const toolCalls = [];
    let finishReason: string | undefined;
    for await (const chunk of parseOpenAiSseStream(stream)) {
      if (chunk.toolCall) {
        toolCalls.push(chunk.toolCall);
      }
      if (chunk.finishReason) {
        finishReason = chunk.finishReason;
      }
    }

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "get_weather",
      arguments: { city: "Paris" },
    });
    expect(finishReason).toBe("tool_calls");
  });

  test("accumulates two parallel tool calls by differing index", async () => {
    const stream = sseStream([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", function: { name: "a", arguments: '{"x":1}' } },
                { index: 1, id: "call_b", function: { name: "b", arguments: '{"y":2}' } },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const toolCalls = [];
    for await (const chunk of parseOpenAiSseStream(stream)) {
      if (chunk.toolCall) {
        toolCalls.push(chunk.toolCall);
      }
    }

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toEqual({
      type: "tool_call",
      id: "call_a",
      name: "a",
      arguments: { x: 1 },
    });
    expect(toolCalls[1]).toEqual({
      type: "tool_call",
      id: "call_b",
      name: "b",
      arguments: { y: 2 },
    });
  });

  test("malformed argument JSON yields arguments:{} instead of throwing", async () => {
    const stream = sseStream([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "broken", arguments: "{not json" },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const toolCalls = [];
    for await (const chunk of parseOpenAiSseStream(stream)) {
      if (chunk.toolCall) {
        toolCalls.push(chunk.toolCall);
      }
    }

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.arguments).toEqual({});
    expect(toolCalls[0]?.name).toBe("broken");
  });

  test("maps a plain stop finish_reason and leaves text streaming intact", async () => {
    const stream = sseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    let text = "";
    let finishReason: string | undefined;
    let sawToolCall = false;
    for await (const chunk of parseOpenAiSseStream(stream)) {
      if (chunk.content) {
        text += chunk.content;
      }
      if (chunk.finishReason) {
        finishReason = chunk.finishReason;
      }
      if (chunk.toolCall) {
        sawToolCall = true;
      }
    }

    expect(text).toBe("done");
    expect(finishReason).toBe("stop");
    expect(sawToolCall).toBe(false);
  });

  test("tool calls buffered under finish_reason:stop are labeled tool_calls", async () => {
    // Some OpenAI-compatible providers send finish_reason "stop" while tool-call
    // fragments are buffered. The drained turn must be labeled "tool_calls".
    const stream = sseStream([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const toolCalls = [];
    const finishReasons: string[] = [];
    for await (const chunk of parseOpenAiSseStream(stream)) {
      if (chunk.toolCall) {
        toolCalls.push(chunk.toolCall);
      }
      if (chunk.finishReason) {
        finishReasons.push(chunk.finishReason);
      }
    }

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe("get_weather");
    // Forced to "tool_calls" despite the raw finish_reason being "stop".
    expect(finishReasons).toEqual(["tool_calls"]);
  });

  test("emits done exactly once, after the trailing usage frame", async () => {
    // Real include_usage frame order: finish_reason frame, then a SEPARATE usage
    // frame, then [DONE]. `done` must fire ONCE, at stream end, AFTER usage.
    const stream = sseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: null,
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const order: string[] = [];
    for await (const chunk of parseOpenAiSseStream(stream)) {
      if (chunk.content) order.push("content");
      if (chunk.finishReason) order.push(`finish:${chunk.finishReason}`);
      if (chunk.usage) order.push("usage");
      if (chunk.done) order.push("done");
    }

    // Exactly one done.
    expect(order.filter((o) => o === "done")).toHaveLength(1);
    // done is last, and it comes AFTER usage.
    expect(order.at(-1)).toBe("done");
    expect(order.indexOf("usage")).toBeLessThan(order.indexOf("done"));
    expect(order).toEqual(["content", "finish:stop", "usage", "done"]);
  });
});
