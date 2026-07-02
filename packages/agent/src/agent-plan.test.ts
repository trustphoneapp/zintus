// Tests for the agent's PLANNING + change-summary additions.
//
// The plan is the MODEL'S: it is captured (and re-captured, with updated step
// statuses) via the update_plan tool, tracked in the run context, and the files
// ACTUALLY mutated through the loop are rolled up into an end-of-run change
// summary. These tests drive the REAL runAgentToolLoop with a local,
// deterministic "model" (the pattern from agent-loop.integration.test.ts) so the
// capture/track/summarize machinery is exercised end-to-end, and prove planning
// doesn't break a no-plan run (back-compat).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
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
  MAX_PLAN_STEPS,
  MAX_PLAN_STEP_CHARS,
  type AgentToolContext,
  type ChangeLogEntry,
  type ConfirmWrite,
  type PlanState,
  type ToolLoopTurn,
  createPlanState,
  createSandbox,
  executeAgentToolCall,
  planStatusSummary,
  runAgentToolLoop,
  summarizeChanges,
} from "./agent-tools.js";

let root: string;
beforeEach(() => {
  // realpathSync to defeat macOS /var -> /private/var temp-dir symlinking.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-agent-plan-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A context with an always-approve gate + plan + change-log wired in (as the CLI
 *  does), so update_plan and the change summary can be exercised. */
function ctxWith(): AgentToolContext & {
  plan: PlanState;
  changeLog: ChangeLogEntry[];
} {
  const confirm: ConfirmWrite = () => true;
  return {
    sandbox: createSandbox(root),
    confirm,
    budget: { used: 0, max: 50 },
    plan: createPlanState(),
    changeLog: [],
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

describe("update_plan captures + tracks the model's plan", () => {
  it("captures the plan from an update_plan call into run state", async () => {
    const ctx = ctxWith();
    const r = await executeAgentToolCall(
      call("update_plan", {
        steps: [{ step: "Read the file" }, { step: "Edit it" }, { step: "Verify" }],
      }),
      ctx,
    );
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.content);
    expect(parsed.planUpdated).toBe(true);
    expect(parsed.revision).toBe(1);
    // The plan is captured in run state — all steps default to pending.
    expect(ctx.plan.steps).toEqual([
      { text: "Read the file", status: "pending" },
      { text: "Edit it", status: "pending" },
      { text: "Verify", status: "pending" },
    ]);
    expect(planStatusSummary(ctx.plan.steps)).toBe("0/3 done");
  });

  it("accepts bare strings as pending steps", async () => {
    const ctx = ctxWith();
    await executeAgentToolCall(
      call("update_plan", { steps: ["one", "two"] }),
      ctx,
    );
    expect(ctx.plan.steps).toEqual([
      { text: "one", status: "pending" },
      { text: "two", status: "pending" },
    ]);
  });

  it("tracks step status transitions across re-emitted plans", async () => {
    const ctx = ctxWith();
    await executeAgentToolCall(
      call("update_plan", {
        steps: [{ step: "A", status: "in_progress" }, { step: "B" }],
      }),
      ctx,
    );
    expect(planStatusSummary(ctx.plan.steps)).toBe("0/2 done, 1 in progress");

    // Re-emit with A done and B in progress — the new statuses replace the old.
    const r = await executeAgentToolCall(
      call("update_plan", {
        steps: [{ step: "A", status: "done" }, { step: "B", status: "in_progress" }],
      }),
      ctx,
    );
    const parsed = JSON.parse(r.content);
    expect(parsed.revision).toBe(2);
    expect(ctx.plan.steps).toEqual([
      { text: "A", status: "done" },
      { text: "B", status: "in_progress" },
    ]);
    expect(planStatusSummary(ctx.plan.steps)).toBe("1/2 done, 1 in progress");
  });

  it("rejects an empty plan and bounds the step count + text length", async () => {
    const ctx = ctxWith();
    const empty = await executeAgentToolCall(call("update_plan", { steps: [] }), ctx);
    expect(empty.isError).toBe(true);
    expect(ctx.plan.revision).toBe(0); // unchanged

    const many = Array.from({ length: MAX_PLAN_STEPS + 10 }, (_, i) => `step ${i}`);
    await executeAgentToolCall(call("update_plan", { steps: many }), ctx);
    expect(ctx.plan.steps.length).toBe(MAX_PLAN_STEPS);

    const longText = "x".repeat(MAX_PLAN_STEP_CHARS + 50);
    await executeAgentToolCall(call("update_plan", { steps: [longText] }), ctx);
    // Truncated to the cap + a single ellipsis marker.
    expect(ctx.plan.steps[0]!.text.length).toBe(MAX_PLAN_STEP_CHARS + 1);
    expect(ctx.plan.steps[0]!.text.endsWith("…")).toBe(true);
  });

  it("invalid statuses fall back to pending (honest — never invented)", async () => {
    const ctx = ctxWith();
    await executeAgentToolCall(
      call("update_plan", { steps: [{ step: "A", status: "finished" }] }),
      ctx,
    );
    expect(ctx.plan.steps[0]!.status).toBe("pending");
  });
});

describe("end-of-run change summary lists files actually mutated", () => {
  it("plans first, edits two files through the loop, then summarizes the real mutations", async () => {
    writeFileSync(path.join(root, "a.txt"), "alpha", "utf8");
    const ctx = ctxWith();

    // A deterministic "model": plan -> write file 1 -> write file 2 -> mark done.
    const model = (defs: ToolDefinition[], convo: ChatMessage[]): ToolLoopTurn => {
      const names = new Set(defs.map((d) => d.name));
      expect(names.has("update_plan")).toBe(true);

      const last = lastToolResult(convo);
      if (!last) {
        // Round 0: produce the plan BEFORE editing.
        return turn("Planning.", [
          call("update_plan", {
            steps: [
              { step: "Write a.txt", status: "in_progress" },
              { step: "Write b.txt" },
            ],
          }),
        ]);
      }
      const parsed = JSON.parse(last.content) as Record<string, unknown>;
      if (parsed.planUpdated === true && parsed.revision === 1) {
        return turn("Writing a.", [call("write_file", { path: "a.txt", content: "ALPHA" })]);
      }
      if (parsed.applied === true && ctx.changeLog.length === 1) {
        return turn("Writing b.", [call("write_file", { path: "b.txt", content: "BETA" })]);
      }
      if (parsed.applied === true && ctx.changeLog.length === 2) {
        // Mark the plan complete, then stop next round.
        return turn("Done editing.", [
          call("update_plan", {
            steps: [
              { step: "Write a.txt", status: "done" },
              { step: "Write b.txt", status: "done" },
            ],
          }),
        ]);
      }
      return turn("All done.");
    };

    const { rounds } = await runAgentToolLoop(
      [{ role: "user", content: "write a.txt and b.txt" }],
      {
        route: async (convo) => model(AGENT_TOOL_DEFINITIONS, convo),
        execute: (c) =>
          executeAgentToolCall(
            { id: c.id, name: c.name, arguments: c.arguments },
            ctx,
          ),
      },
    );

    expect(rounds).toBe(5); // plan, write a, write b, mark-done, stop
    // Files were really written.
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("ALPHA");
    expect(readFileSync(path.join(root, "b.txt"), "utf8")).toBe("BETA");

    // The change summary lists exactly the two files actually mutated.
    const summary = summarizeChanges(ctx.changeLog);
    expect(summary.mutations).toBe(2);
    expect(summary.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(summary.files.every((f) => f.tools.includes("write_file"))).toBe(true);

    // The model's final plan is captured + fully done.
    expect(planStatusSummary(ctx.plan.steps)).toBe("2/2 done");
  });

  it("summarizeChanges collapses repeated writes to the same file", () => {
    const log: ChangeLogEntry[] = [
      { path: "x.ts", tool: "write_file", bytes: 10 },
      { path: "x.ts", tool: "apply_edit", bytes: 12 },
      { path: "y.ts", tool: "write_file", bytes: 5 },
    ];
    const summary = summarizeChanges(log);
    expect(summary.mutations).toBe(3);
    expect(summary.files).toEqual([
      { path: "x.ts", writes: 2, tools: ["write_file", "apply_edit"] },
      { path: "y.ts", writes: 1, tools: ["write_file"] },
    ]);
  });
});

describe("back-compat: planning doesn't break a no-plan run", () => {
  it("a context WITHOUT a plan errors gracefully on update_plan (no throw)", async () => {
    const ctx: AgentToolContext = {
      sandbox: createSandbox(root),
      confirm: () => true,
      budget: { used: 0, max: 50 },
      // no plan, no changeLog
    };
    const r = await executeAgentToolCall(
      call("update_plan", { steps: ["x"] }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("planning is not enabled");
  });

  it("a run that never plans still reads, writes (no change log) and terminates", async () => {
    writeFileSync(path.join(root, "in.txt"), "data", "utf8");
    const ctx: AgentToolContext = {
      sandbox: createSandbox(root),
      confirm: () => true,
      budget: { used: 0, max: 50 },
      // Deliberately NO plan/changeLog — the prior behaviour.
    };

    const model = (_defs: ToolDefinition[], convo: ChatMessage[]): ToolLoopTurn => {
      const last = lastToolResult(convo);
      if (!last) return turn("", [call("read_file", { path: "in.txt" })]);
      const parsed = JSON.parse(last.content) as Record<string, unknown>;
      if (typeof parsed.content === "string") {
        return turn("", [
          call("write_file", { path: "out.txt", content: String(parsed.content).toUpperCase() }),
        ]);
      }
      return turn("done");
    };

    const { rounds } = await runAgentToolLoop(
      [{ role: "user", content: "transform" }],
      {
        route: async (convo) => model(AGENT_TOOL_DEFINITIONS, convo),
        execute: (c) =>
          executeAgentToolCall(
            { id: c.id, name: c.name, arguments: c.arguments },
            ctx,
          ),
      },
    );
    expect(rounds).toBe(3);
    expect(readFileSync(path.join(root, "out.txt"), "utf8")).toBe("DATA");
    expect(ctx.budget.used).toBe(1);
    // No change log was wired — summarizing an empty log is still safe.
    expect(summarizeChanges([]).files).toEqual([]);
  });
});
