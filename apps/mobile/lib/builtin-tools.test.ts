import { describe, expect, it } from "bun:test";
import type {
  ChatMessage,
  ToolCallContentBlock,
  ToolResultContentBlock,
} from "@zintus/types";
import {
  BUILTIN_TOOL_DEFINITIONS,
  MAX_TOOL_ROUNDS,
  executeBuiltinToolCall,
  runBuiltinToolLoop,
  type ToolLoopTurn,
} from "./builtin-tools";

/** An async stream of a single text chunk (mirrors the gateway's text channel). */
function textStream(text: string): AsyncIterable<string> {
  return (async function* () {
    if (text) yield text;
  })();
}

function makeTurn(text: string, toolCalls?: ToolCallContentBlock[]): ToolLoopTurn {
  return { stream: textStream(text), toolCalls };
}

describe("executeBuiltinToolCall", () => {
  it("runs the eval-free calculator and returns the real result", () => {
    const r = executeBuiltinToolCall({
      id: "c1",
      name: "calculator",
      arguments: { expression: "(2 + 3) * 4" },
    });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content)).toEqual({ result: 20 });
  });

  it("surfaces a malformed expression as an honest error result (never throws)", () => {
    const r = executeBuiltinToolCall({
      id: "c2",
      name: "calculator",
      arguments: { expression: "2 +" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content)).toHaveProperty("error");
  });

  it("surfaces an unknown tool as an error result rather than executing anything", () => {
    const r = executeBuiltinToolCall({
      id: "c3",
      name: "rm_rf",
      arguments: {},
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("unknown tool: rm_rf");
  });

  it("exposes exactly the three built-in tool definitions", () => {
    expect(BUILTIN_TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      "calculator",
      "current_datetime",
      "random_number",
    ]);
  });
});

describe("runBuiltinToolLoop", () => {
  it("executes the built-in tool and feeds the result back, then returns the final answer", async () => {
    // Round 0: model calls calculator. Round 1: model returns final text.
    const turns: ToolLoopTurn[] = [
      makeTurn("", [
        {
          type: "tool_call",
          id: "call_1",
          name: "calculator",
          arguments: { expression: "21 * 2" },
        },
      ]),
      makeTurn("The answer is 42."),
    ];
    const routedMessages: ChatMessage[][] = [];
    const toolResults: { name: string; content: string; isError: boolean }[] = [];

    const { finalResult, rounds } = await runBuiltinToolLoop(
      [{ role: "user", content: "what is 21 * 2?" }],
      {
        route: async (messages) => {
          // Snapshot the conversation the gateway would see this round.
          routedMessages.push(structuredClone(messages));
          return turns.shift()!;
        },
        onToolResult: (r, call) =>
          toolResults.push({
            name: call.name,
            content: r.content,
            isError: r.isError,
          }),
      },
    );

    // Two rounds ran: the call round + the final-answer round.
    expect(rounds).toBe(2);

    // The built-in calculator actually ran and produced the real result.
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.name).toBe("calculator");
    expect(toolResults[0]!.isError).toBe(false);
    expect(JSON.parse(toolResults[0]!.content)).toEqual({ result: 42 });

    // The second route saw the fed-back tool_result turn (the execute→feed-back loop).
    expect(routedMessages).toHaveLength(2);
    const round2 = routedMessages[1]!;
    const lastTurn = round2[round2.length - 1]!;
    expect(lastTurn.role).toBe("user");
    const blocks = lastTurn.content as ToolResultContentBlock[];
    expect(blocks[0]).toMatchObject({
      type: "tool_result",
      toolCallId: "call_1",
    });
    expect(JSON.parse(blocks[0]!.content)).toEqual({ result: 42 });

    // The final answer is returned (the round that emitted no tool calls).
    expect(finalResult.toolCalls ?? []).toHaveLength(0);
  });

  it("is BOUNDED — a model that always calls tools stops at maxRounds and never loops forever", async () => {
    let routeCalls = 0;
    let stoppedAt: number | undefined;
    const maxRounds = 3;

    const { rounds } = await runBuiltinToolLoop(
      [{ role: "user", content: "loop forever" }],
      {
        maxRounds,
        // Every round emits a fresh tool call — a runaway model.
        route: async () => {
          routeCalls += 1;
          return makeTurn("", [
            {
              type: "tool_call",
              id: `call_${routeCalls}`,
              name: "calculator",
              arguments: { expression: "1 + 1" },
            },
          ]);
        },
        onStopped: (m) => {
          stoppedAt = m;
        },
      },
    );

    // The loop routes at most maxRounds + 1 times, then stops — not infinitely.
    expect(routeCalls).toBe(maxRounds + 1);
    expect(rounds).toBe(maxRounds + 1);
    expect(stoppedAt).toBe(maxRounds);
  });

  it("MAX_TOOL_ROUNDS matches the web chat cap (5)", () => {
    expect(MAX_TOOL_ROUNDS).toBe(5);
  });
});
