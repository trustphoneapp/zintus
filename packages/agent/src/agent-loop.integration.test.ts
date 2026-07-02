// REAL-LOOP integration test for the agent's route -> execute -> feed-back loop.
//
// agent-tools.test.ts unit-tests the sandbox and the tools in isolation, and its
// one loop test scripts fixed turns that ignore the conversation. This test
// drives the ACTUAL runAgentToolLoop with a LOCAL, deterministic "model": a pure
// function that, given the tool schema + the running conversation, returns the
// next tool call by REACTING to the real tool results fed back to it. So the
// machinery actually exercised end-to-end is: tool dispatch (executeAgentToolCall)
// -> real sandbox fs read/write -> result fed back into the message history ->
// the model reads that result and decides the next step -> the write gate +
// mutation budget -> natural termination on a no-tool-call turn.
//
// The proof that feed-back is real: the content written in round 2 is DERIVED
// from the content read in round 1 (uppercased). If the read result did not flow
// back through the loop into the next route() call, the write would be empty and
// the assertion would fail. Hermetic: a temp sandbox dir, real files, cleaned up.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ChatMessage,
  ContentBlock,
  ToolCallContentBlock,
  ToolDefinition,
} from "@zintus/types";
import {
  AGENT_TOOL_DEFINITIONS,
  type AgentToolContext,
  type ConfirmWrite,
  type ToolLoopTurn,
  createSandbox,
  executeAgentToolCall,
  runAgentToolLoop,
} from "./agent-tools.js";
import type { ToolExecutionResult } from "./builtin-tools.js";

let root: string;
beforeEach(() => {
  // realpathSync to defeat macOS /var -> /private/var temp-dir symlinking.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-agent-loop-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A context with an always-approve gate, recording confirm calls + the budget. */
function ctxWith(budgetMax = 50): AgentToolContext & {
  confirmCalls: { path: string }[];
} {
  const confirmCalls: { path: string }[] = [];
  const confirm: ConfirmWrite = ({ path: p }) => {
    confirmCalls.push({ path: p });
    return true;
  };
  return {
    sandbox: createSandbox(root),
    confirm,
    budget: { used: 0, max: budgetMax },
    confirmCalls,
  };
}

function call(name: string, args: Record<string, unknown>): ToolCallContentBlock {
  return { type: "tool_call", id: `c_${name}_${Math.random().toString(36).slice(2)}`, name, arguments: args };
}

function textStream(text: string): AsyncIterable<string> {
  return (async function* () {
    if (text) yield text;
  })();
}
function turn(text: string, toolCalls?: ToolCallContentBlock[]): ToolLoopTurn {
  return { stream: textStream(text), toolCalls };
}

/** The most recent tool_result block fed back into the conversation, if any. */
function lastToolResult(convo: ChatMessage[]): { content: string } | null {
  for (let i = convo.length - 1; i >= 0; i -= 1) {
    const c = convo[i]!.content;
    if (typeof c === "string" || !Array.isArray(c)) continue;
    const blocks = c as ContentBlock[];
    for (let j = blocks.length - 1; j >= 0; j -= 1) {
      const b = blocks[j]!;
      if (b.type === "tool_result") {
        return { content: typeof b.content === "string" ? b.content : "" };
      }
    }
  }
  return null;
}

describe("runAgentToolLoop driven by a local deterministic model", () => {
  it("reads a file, then writes a result DERIVED from the real read, then stops", async () => {
    writeFileSync(path.join(root, "input.txt"), "hello loop", "utf8");
    const ctx = ctxWith();

    // The "model": pure, deterministic, reacts to the real fed-back results.
    const model = (defs: ToolDefinition[], convo: ChatMessage[]): ToolLoopTurn => {
      const names = new Set(defs.map((d) => d.name));
      // It only ever uses tools the real schema advertises.
      expect(names.has("read_file")).toBe(true);
      expect(names.has("write_file")).toBe(true);

      const last = lastToolResult(convo);
      if (!last) {
        // Round 0: read the input file.
        return turn("Reading input.", [call("read_file", { path: "input.txt" })]);
      }
      const parsed = JSON.parse(last.content) as Record<string, unknown>;
      if (typeof parsed.content === "string") {
        // Round 1: we just READ the file — transform its real content and write it.
        const upper = parsed.content.toUpperCase();
        return turn("Writing transformed output.", [
          call("write_file", { path: "output.txt", content: upper }),
        ]);
      }
      if (parsed.applied === true) {
        // Round 2: the write was applied — finish with a no-tool-call turn.
        return turn("Done.");
      }
      return turn("Unexpected state — stopping.");
    };

    const executed: ToolExecutionResult[] = [];
    const { rounds, finalResult } = await runAgentToolLoop(
      [{ role: "user", content: "read input.txt and write its uppercase to output.txt" }],
      {
        route: async (convo) => model(AGENT_TOOL_DEFINITIONS, convo),
        execute: async (c) => {
          const r = await executeAgentToolCall(
            { id: c.id, name: c.name, arguments: c.arguments },
            ctx,
          );
          executed.push(r);
          return r;
        },
      },
    );

    // The loop ran read -> write -> stop and terminated on its own.
    expect(rounds).toBe(3);
    expect(finalResult.toolCalls ?? []).toHaveLength(0);

    // The file was ACTUALLY written through the loop, with content derived from
    // the real read result that was fed back between rounds.
    expect(existsSync(path.join(root, "output.txt"))).toBe(true);
    expect(readFileSync(path.join(root, "output.txt"), "utf8")).toBe("HELLO LOOP");

    // The real tools ran: one read (with content), one applied write.
    expect(executed).toHaveLength(2);
    expect(JSON.parse(executed[0]!.content).content).toBe("hello loop");
    expect(JSON.parse(executed[1]!.content).applied).toBe(true);

    // The write went through the gate and consumed exactly one mutation.
    expect(ctx.confirmCalls).toHaveLength(1);
    expect(ctx.budget.used).toBe(1);
  });

  it("enforces the mutation budget INSIDE the loop — over-budget writes are refused, the loop still terminates", async () => {
    const ctx = ctxWith(1); // budget of one applied write

    // A model that tries to write two files, then stops. The second write must be
    // refused by the budget — surfaced back to the model as an error result — yet
    // the loop must still terminate cleanly.
    let step = 0;
    const model = (): ToolLoopTurn => {
      step += 1;
      if (step === 1) return turn("", [call("write_file", { path: "a.txt", content: "A" })]);
      if (step === 2) return turn("", [call("write_file", { path: "b.txt", content: "B" })]);
      return turn("Stopping.");
    };

    const executed: ToolExecutionResult[] = [];
    const { rounds } = await runAgentToolLoop([{ role: "user", content: "write two files" }], {
      route: async () => model(),
      execute: async (c) => {
        const r = await executeAgentToolCall(
          { id: c.id, name: c.name, arguments: c.arguments },
          ctx,
        );
        executed.push(r);
        return r;
      },
    });

    expect(rounds).toBe(3);
    // First write applied; second refused by the budget (fed back as an error).
    expect(existsSync(path.join(root, "a.txt"))).toBe(true);
    expect(existsSync(path.join(root, "b.txt"))).toBe(false);
    expect(JSON.parse(executed[0]!.content).applied).toBe(true);
    expect(executed[1]!.isError).toBe(true);
    expect(executed[1]!.content).toContain("budget exhausted");
    expect(ctx.budget.used).toBe(1);
  });
});
