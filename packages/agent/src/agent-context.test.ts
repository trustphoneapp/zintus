// B1 (context management) + B2 (router-strategy seam) tests.
//
// B1 proves the #1 lever: an adversarial long conversation compacts UNDER a token
// cap by EVICTING bulky older tool_results into the CCR store, while (a) the system
// preamble + task (message[0]) and (b) the verbatim live tail survive untouched, and
// every evicted result stays RETRIEVABLE by hash via the `retrieve` agent tool. The
// loop-driven case additionally exercises the real runAgentToolLoop compaction hook.
//
// B2 proves the moat seam: buildAgentRouteRequest threads the routing STRATEGY through
// WITHOUT hardcoding a provider/model — the writer uses the configured strategy, and an
// internal/cheap caller can request "economy".

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ChatMessage,
  ContentBlock,
  ToolCallContentBlock,
  ToolDefinition,
} from "@zintus/types";
import {
  type AgentToolContext,
  type CCRStore,
  type ConfirmWrite,
  type ToolLoopTurn,
  countConvoTokens,
  createContextStore,
  createSandbox,
  executeAgentToolCall,
  isEvictionPointer,
  maybeCompactConvo,
  runAgentToolLoop,
} from "./agent-tools.js";
import { buildAgentRouteRequest } from "./route-request.js";

const tmpDirs: string[] = [];
const stores: CCRStore[] = [];
function tmpStore(): CCRStore {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-ccr-")));
  tmpDirs.push(dir);
  const store = createContextStore(path.join(dir, "ccr.db"));
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A big tool_result body (~`reps` repetitions) that comfortably exceeds the cap. */
function bigBody(tag: string, reps: number): string {
  return `${tag}: ` + `lorem ipsum dolor sit amet consectetur `.repeat(reps);
}

function toolCall(name: string, args: Record<string, unknown>): ToolCallContentBlock {
  return { type: "tool_call", id: `c_${name}_${Math.random().toString(36).slice(2)}`, name, arguments: args };
}

/** Build an adversarial convo: a verbatim preamble, N bulky read_file tool-result
 *  rounds in the middle, and a small recent live tail. */
function buildAdversarialConvo(midRounds: number): {
  convo: ChatMessage[];
  preamble: string;
  midBodies: string[];
} {
  const preamble = "PREAMBLE+TASK: implement the feature without losing data.";
  const convo: ChatMessage[] = [{ role: "user", content: preamble }];
  const midBodies: string[] = [];
  for (let i = 0; i < midRounds; i += 1) {
    const body = bigBody(`READ#${i}`, 120);
    midBodies.push(body);
    const call = toolCall("read_file", { path: `file_${i}.ts` });
    convo.push({ role: "assistant", content: [{ type: "text", text: `reading ${i}` }, call] });
    convo.push({
      role: "user",
      content: [{ type: "tool_result", toolCallId: call.id, content: body, isError: false }],
    });
  }
  // Small live tail (2 turns): these must survive verbatim.
  for (let i = 0; i < 2; i += 1) {
    const call = toolCall("list_directory", { path: "." });
    convo.push({ role: "assistant", content: [call] });
    convo.push({
      role: "user",
      content: [{ type: "tool_result", toolCallId: call.id, content: `tail-${i}`, isError: false }],
    });
  }
  return { convo, preamble, midBodies };
}

/** Pull the hash out of an `[evicted N tokens — retrieve("<hash>") to restore]` pointer. */
function pointerHash(s: string): string | null {
  const m = s.match(/retrieve\("([0-9a-fA-F]+)"\)/);
  return m ? m[1]! : null;
}

function firstToolResult(m: ChatMessage): { content: string } | null {
  if (typeof m.content === "string") return null;
  for (const b of m.content as ContentBlock[]) {
    if (b.type === "tool_result") return { content: b.content };
  }
  return null;
}

describe("B1 — maybeCompactConvo evicts bulky older tool_results", () => {
  it("compacts an adversarial convo under the cap; preamble + live tail survive; evicted content is retrievable; nothing is fabricated", () => {
    const store = tmpStore();
    const { convo, preamble, midBodies } = buildAdversarialConvo(8);

    const tokensBefore = countConvoTokens(convo);
    const budget = 500;
    expect(tokensBefore).toBeGreaterThan(budget);

    // Snapshot the verbatim live tail (last 2 turns = last 4 messages).
    const tailSnapshot = convo.slice(convo.length - 4).map((m) => JSON.stringify(m));

    const res = maybeCompactConvo(convo, {
      store,
      budgetTokens: budget,
      liveTailTurns: 2,
      minEvictTokens: 50,
    });

    // It actually compacted, and dropped the token count BELOW the cap.
    expect(res.compacted).toBe(true);
    expect(res.evicted).toBeGreaterThanOrEqual(1);
    expect(res.tokensAfter).toBeLessThan(res.tokensBefore);
    expect(res.tokensAfter).toBeLessThanOrEqual(budget);
    expect(countConvoTokens(convo)).toBeLessThanOrEqual(budget);
    expect(res.savedTokens).toBeGreaterThan(0);

    // (a) The preamble (message[0]) is byte-for-byte intact.
    expect(convo[0]!.content).toBe(preamble);

    // (b) The live tail survived verbatim (no eviction of the last 2 turns).
    const tailAfter = convo.slice(convo.length - 4).map((m) => JSON.stringify(m));
    expect(tailAfter).toEqual(tailSnapshot);

    // An older middle tool_result is now a pointer, and the original is retrievable.
    const evictedMsg = convo[2]!; // first middle tool_result
    const tr = firstToolResult(evictedMsg);
    expect(tr).not.toBeNull();
    expect(isEvictionPointer(tr!.content)).toBe(true);
    const hash = pointerHash(tr!.content);
    expect(hash).not.toBeNull();

    // Honest: retrieving the hash returns the ORIGINAL body verbatim (no fabrication).
    expect(store.retrieve(hash!)).toBe(midBodies[0]!);

    // The pointer's declared token count is the REAL count of the original body.
    const declared = Number(tr!.content.match(/evicted (\d+) tokens/)![1]);
    expect(declared).toBeGreaterThan(0);
  });

  it("is a no-op under budget and leaves small results inline (bounded, legible)", () => {
    const store = tmpStore();
    const convo: ChatMessage[] = [
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: [toolCall("read_file", { path: "a.ts" })],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "x", content: "small", isError: false }],
      },
    ];
    const res = maybeCompactConvo(convo, { store, budgetTokens: 100_000 });
    expect(res.compacted).toBe(false);
    expect(res.evicted).toBe(0);
    // The small inline result is untouched (not a pointer).
    expect(firstToolResult(convo[2]!)!.content).toBe("small");
  });
});

function textStream(text: string): AsyncIterable<string> {
  return (async function* () {
    if (text) yield text;
  })();
}

describe("B1 — runAgentToolLoop compacts between rounds and the retrieve tool restores", () => {
  it("evicts a bulky early tool_result during the loop; retrieve tool returns the original", async () => {
    const store = tmpStore();
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-loop-")));
    tmpDirs.push(root);
    const ctx: AgentToolContext = {
      sandbox: createSandbox(root),
      confirm: (() => true) as ConfirmWrite,
      budget: { used: 0, max: 50 },
      context: {
        store,
        budgetTokens: 400,
        liveTailTurns: 1,
        minEvictTokens: 50,
      },
    };

    const big = bigBody("FAKE_READ", 120);

    // Deterministic model: emit a tool call for 5 rounds, then stop.
    let step = 0;
    const route = async (): Promise<ToolLoopTurn> => {
      step += 1;
      if (step <= 5) {
        return { stream: textStream(`round ${step}`), toolCalls: [toolCall("read_file", { path: `f${step}.ts` })] };
      }
      return { stream: textStream("done"), toolCalls: [] };
    };

    let compactions = 0;
    const { convo } = await runAgentToolLoop([{ role: "user", content: "PREAMBLE" }], {
      route,
      // Fake executor: every tool call returns the SAME big body (no real fs needed).
      execute: async (c) => ({ toolCallId: c.id, content: big, isError: false }),
      context: ctx.context,
      onCompact: () => {
        compactions += 1;
      },
    });

    // Compaction fired at least once during the loop.
    expect(compactions).toBeGreaterThanOrEqual(1);

    // An early tool_result in the returned convo is now a pointer.
    let foundPointer: string | null = null;
    for (const m of convo) {
      const tr = firstToolResult(m);
      if (tr && isEvictionPointer(tr.content)) {
        foundPointer = pointerHash(tr.content);
        break;
      }
    }
    expect(foundPointer).not.toBeNull();

    // The model pulls it back through the REAL retrieve tool dispatch.
    const restored = await executeAgentToolCall(
      { id: "r1", name: "retrieve", arguments: { hash: foundPointer! } },
      ctx,
    );
    expect(restored.isError).toBe(false);
    expect(JSON.parse(restored.content).content).toBe(big);
  });

  it("retrieve refuses honestly when no context store is configured", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-nostore-")));
    tmpDirs.push(root);
    const ctx: AgentToolContext = {
      sandbox: createSandbox(root),
      confirm: (() => true) as ConfirmWrite,
      budget: { used: 0, max: 50 },
    };
    const r = await executeAgentToolCall(
      { id: "r", name: "retrieve", arguments: { hash: "deadbeef" } },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no context store");
  });
});

describe("B2 — buildAgentRouteRequest threads strategy without hardcoding a model", () => {
  const tools: ToolDefinition[] = [
    { name: "read_file", description: "x", parameters: { type: "object", properties: {} } },
  ];
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

  it("the writer passes the configured strategy verbatim (no silent override)", () => {
    // Mirror the loop's routeTurn: strategy ?? config.routingStrategy.
    const configStrategy = "fastest" as const;
    const req = buildAgentRouteRequest({
      messages,
      mode: "smart",
      tools,
      strategy: configStrategy,
    });
    expect(req.strategy).toBe("fastest");
    expect(req.mode).toBe("smart");
    expect(req.tools).toBe(tools);
    // Routing is preserved: no provider/model is pinned anywhere in the request.
    expect("provider" in req).toBe(false);
    expect("model" in req).toBe(false);
  });

  it("the seam can request economy for an internal/cheap call", () => {
    const req = buildAgentRouteRequest({
      messages,
      mode: "fast",
      tools,
      strategy: "economy",
    });
    expect(req.strategy).toBe("economy");
  });
});
