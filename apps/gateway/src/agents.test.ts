import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolLoopTurn } from "@zintus/agent";
import { AgentTaskManager, type AgentEngine, type AgentEvent } from "./agents.js";

// Unit tests for the gateway-hosted agent runtime (P2). The engine is a
// scripted fake: round 0 asks to write a file (exercising the HTTP approval
// gate), round 1 answers with plain text (terminating the loop). Everything
// else — sandbox, budgets, event stream, persistence — is the real code.

function turn(text: string, toolCalls?: ToolLoopTurn["toolCalls"]): ToolLoopTurn {
  return {
    stream: (async function* () {
      yield text;
    })(),
    toolCalls,
    providerId: "groq",
    traceId: "trace-1",
  } as ToolLoopTurn;
}

function scriptedEngine(script: Array<() => ToolLoopTurn>): AgentEngine {
  let i = 0;
  return {
    async routeAndStream() {
      const make = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return make() as ToolLoopTurn & { threadId?: string };
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const dirs: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zintus-agents-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ZINTUS_AGENT_RECORDS;
});

function eventsOf(mgr: AgentTaskManager, id: string): AgentEvent[] {
  return (mgr.get(id) ? ((mgr as unknown as { tasks: Map<string, { events: AgentEvent[] }> })
    .tasks.get(id)?.events ?? []) : []);
}

describe("gateway agent runtime", () => {
  test("declined approval feeds back and the run completes", async () => {
    const root = tmpRoot();
    process.env.ZINTUS_AGENT_RECORDS = path.join(root, ".records");
    const engine = scriptedEngine([
      () =>
        turn("editing…", [
          {
            type: "tool_call",
            id: "c1",
            name: "write_file",
            arguments: { path: "a.txt", content: "hello" },
          },
        ]),
      () => turn("all done"),
    ]);
    const mgr = new AgentTaskManager(engine);
    const { id } = mgr.create({ task: "write a.txt", root });

    // The write gate must surface as an approval_required event.
    await waitFor(() =>
      eventsOf(mgr, id).some((e) => e.type === "approval_required"),
    );
    const approval = eventsOf(mgr, id).find(
      (e) => e.type === "approval_required",
    )!;
    expect(approval.tool).toBe("write_file");
    expect(String(approval.diff)).toContain("hello");
    expect((mgr.get(id) as { status: string }).status).toBe("awaiting_approval");

    // DECLINE — the file must not exist and the loop must still finish.
    expect(mgr.approve(id, String(approval.approval_id), false)).toBe(true);
    await waitFor(() => (mgr.get(id) as { status: string }).status === "done");
    expect(existsSync(path.join(root, "a.txt"))).toBe(false);
    const done = eventsOf(mgr, id).find((e) => e.type === "done")!;
    expect(done.mutations).toBe(0);

    // Finished run persisted for post-restart review.
    const record = path.join(root, ".records", `${id}.json`);
    expect(existsSync(record)).toBe(true);
    expect(JSON.parse(readFileSync(record, "utf8")).status).toBe("done");
  });

  test("approved write lands on disk inside the sandbox", async () => {
    const root = tmpRoot();
    process.env.ZINTUS_AGENT_RECORDS = path.join(root, ".records");
    const engine = scriptedEngine([
      () =>
        turn("editing…", [
          {
            type: "tool_call",
            id: "c1",
            name: "write_file",
            arguments: { path: "b.txt", content: "approved!" },
          },
        ]),
      () => turn("all done"),
    ]);
    const mgr = new AgentTaskManager(engine);
    const { id } = mgr.create({ task: "write b.txt", root });
    await waitFor(() =>
      eventsOf(mgr, id).some((e) => e.type === "approval_required"),
    );
    const approval = eventsOf(mgr, id).find(
      (e) => e.type === "approval_required",
    )!;
    mgr.approve(id, String(approval.approval_id), true);
    await waitFor(() => (mgr.get(id) as { status: string }).status === "done");
    expect(readFileSync(path.join(root, "b.txt"), "utf8")).toBe("approved!");
    const done = eventsOf(mgr, id).find((e) => e.type === "done")!;
    expect(done.mutations).toBe(1);
    expect((done.changes as Array<{ path: string }>)[0]?.path).toBe("b.txt");
  });

  test("autoApprove writes without a pending gate (explicit --yes analog)", async () => {
    const root = tmpRoot();
    process.env.ZINTUS_AGENT_RECORDS = path.join(root, ".records");
    const engine = scriptedEngine([
      () =>
        turn("", [
          {
            type: "tool_call",
            id: "c1",
            name: "write_file",
            arguments: { path: "c.txt", content: "yes" },
          },
        ]),
      () => turn("done"),
    ]);
    const mgr = new AgentTaskManager(engine);
    const { id } = mgr.create({ task: "x", root, autoApprove: true });
    await waitFor(() => (mgr.get(id) as { status: string }).status === "done");
    expect(readFileSync(path.join(root, "c.txt"), "utf8")).toBe("yes");
    expect(eventsOf(mgr, id).some((e) => e.type === "approval_required")).toBe(false);
  });

  test("stop during a pending approval fails the gate closed and stops", async () => {
    const root = tmpRoot();
    process.env.ZINTUS_AGENT_RECORDS = path.join(root, ".records");
    const engine = scriptedEngine([
      () =>
        turn("", [
          {
            type: "tool_call",
            id: "c1",
            name: "write_file",
            arguments: { path: "d.txt", content: "never" },
          },
        ]),
      () => turn("should not matter"),
    ]);
    const mgr = new AgentTaskManager(engine);
    const { id } = mgr.create({ task: "x", root });
    await waitFor(() =>
      eventsOf(mgr, id).some((e) => e.type === "approval_required"),
    );
    expect(mgr.stop(id)).toBe(true);
    await waitFor(() => {
      const s = (mgr.get(id) as { status: string }).status;
      return s === "stopped";
    });
    expect(existsSync(path.join(root, "d.txt"))).toBe(false);
  });

  test("SSE subscribe replays the backlog and terminates with [DONE]", async () => {
    const root = tmpRoot();
    process.env.ZINTUS_AGENT_RECORDS = path.join(root, ".records");
    // Round 0 reads a file (a REAL tool call — a zero-tool run is a P4
    // failure, not "done"), round 1 answers.
    const mgr = new AgentTaskManager(
      scriptedEngine([
        () =>
          turn("looking…", [
            { type: "tool_call", id: "c1", name: "read_file", arguments: { path: "x.txt" } },
          ]),
        () => turn("hi there"),
      ]),
    );
    const { id } = mgr.create({ task: "say hi", root, autoApprove: true });
    await waitFor(() => (mgr.get(id) as { status: string }).status === "done");

    const stream = mgr.subscribe(id)!;
    const text = await new Response(stream).text();
    expect(text).toContain('"type":"started"');
    expect(text).toContain('"type":"text"');
    expect(text).toContain('"type":"done"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(mgr.subscribe("nope")).toBeNull();
  });

  test("zero-tool run reports failure, never done (P4)", async () => {
    const root = tmpRoot();
    process.env.ZINTUS_AGENT_RECORDS = path.join(root, ".records");
    const mgr = new AgentTaskManager(scriptedEngine([() => turn("all set, no tools needed!")]));
    const { id } = mgr.create({ task: "do work", root });
    await waitFor(() => (mgr.get(id) as { status: string }).status === "error");
    const task = (mgr as unknown as { tasks: Map<string, { events: AgentEvent[] }> }).tasks.get(id)!;
    const err = task.events.find((e) => e.type === "error");
    expect(String(err?.message)).toContain("no tools used");
  });

  test("3-exchange follow-up keeps root + full context; events are exchange-tagged (P2)", async () => {
    const root = tmpRoot();
    process.env.ZINTUS_AGENT_RECORDS = path.join(root, ".records");
    // Capture every route call's seed so context retention is PROVEN, not assumed.
    const routedMessages: unknown[][] = [];
    let call = 0;
    const engine: AgentEngine = {
      async routeAndStream(req) {
        routedMessages.push(req.messages as unknown[]);
        call += 1;
        // Each exchange: round 0 = a real tool call, round 1 = the text answer.
        if (call % 2 === 1) {
          return turn(`working ${call}`, [
            { type: "tool_call", id: `c${call}`, name: "read_file", arguments: { path: "x.txt" } },
          ]) as ToolLoopTurn & { threadId?: string };
        }
        return turn(`answer-${call}`) as ToolLoopTurn & { threadId?: string };
      },
    };
    const mgr = new AgentTaskManager(engine);
    const { id } = mgr.create({
      task: "Read package.json and tell me the project name",
      root,
      autoApprove: true,
    });
    const status = () => (mgr.get(id) as { status: string }).status;
    await waitFor(() => status() === "done");

    const res1 = mgr.followUp(id, "Now read tsconfig.json and tell me the target");
    expect(res1.ok).toBe(true);
    await waitFor(() => status() === "done");

    const res2 = mgr.followUp(id, "Summarize what you learned from both files");
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.exchange).toBe(2);
    await waitFor(() => status() === "done");

    // Exchange 3's seed must contain the whole session: both prior tasks,
    // exchange 1's FINAL ANSWER (appended at checkpoint time), and the new turn.
    const finalSeed = JSON.stringify(routedMessages.at(-1));
    expect(finalSeed).toContain("Read package.json and tell me the project name");
    expect(finalSeed).toContain("answer-2");
    expect(finalSeed).toContain("Now read tsconfig.json and tell me the target");
    expect(finalSeed).toContain("answer-4");
    expect(finalSeed).toContain("Summarize what you learned from both files");

    // Same sandbox root all the way through; events tagged by exchange 0/1/2.
    const t = (mgr as unknown as { tasks: Map<string, { root: string; events: AgentEvent[] }> }).tasks.get(id)!;
    expect(t.root).toBe((mgr.get(id) as { root: string }).root);
    const startedExchanges = t.events
      .filter((e) => e.type === "started")
      .map((e) => e.exchange);
    expect(startedExchanges).toEqual([0, 1, 2]);
    const doneExchanges = t.events.filter((e) => e.type === "done").map((e) => e.exchange);
    expect(doneExchanges).toEqual([0, 1, 2]);
  });

  test("follow-up while running is rejected with a clear reason (P2)", async () => {
    const root = tmpRoot();
    process.env.ZINTUS_AGENT_RECORDS = path.join(root, ".records");
    let release: (() => void) | null = null;
    const engine: AgentEngine = {
      async routeAndStream() {
        await new Promise<void>((r) => {
          release = r;
        });
        return turn("done now", [
          { type: "tool_call", id: "c1", name: "read_file", arguments: { path: "x" } },
        ]) as ToolLoopTurn & { threadId?: string };
      },
    };
    const mgr = new AgentTaskManager(engine);
    const { id } = mgr.create({ task: "slow", root, autoApprove: true });
    await waitFor(() => release !== null);
    const res = mgr.followUp(id, "too early");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.reason).toContain("still working");
    }
    mgr.stop(id);
    release!();
  });

  test("pseudocode narration gets the tailored model-switch error (P4)", async () => {
    const root = tmpRoot();
    process.env.ZINTUS_AGENT_RECORDS = path.join(root, ".records");
    const mgr = new AgentTaskManager(
      scriptedEngine([
        () => turn("I will do this:\n```python\nimport search_code\nfor f in files:\n  pass\n```"),
      ]),
    );
    const { id } = mgr.create({ task: "refactor", root });
    await waitFor(() => (mgr.get(id) as { status: string }).status === "error");
    const task = (mgr as unknown as { tasks: Map<string, { events: AgentEvent[] }> }).tasks.get(id)!;
    const err = task.events.find((e) => e.type === "error");
    expect(String(err?.message)).toContain("produced code instead of tool calls");
  });

  test("interrupted run is recovered on startup and resumes to completion", async () => {
    const root = tmpRoot();
    const records = path.join(root, ".records");
    process.env.ZINTUS_AGENT_RECORDS = records;

    // Manager 1: round 0 asks for a tool (→ a round-boundary checkpoint is
    // written), then the engine HANGS forever on the next route call —
    // simulating a process that died mid-flight while the record still says
    // "running".
    let routeCall = 0;
    const hangingEngine: AgentEngine = {
      async routeAndStream() {
        routeCall += 1;
        if (routeCall === 1) {
          return turn("looking…", [
            { type: "tool_call", id: "c1", name: "read_file", arguments: { path: "x.txt" } },
          ]) as ToolLoopTurn & { threadId?: string };
        }
        // Never resolves — the "dead process" mid-round.
        return new Promise(() => {}) as Promise<ToolLoopTurn & { threadId?: string }>;
      },
    };
    const mgr1 = new AgentTaskManager(hangingEngine);
    const { id } = mgr1.create({ task: "explore", root, autoApprove: true });
    // Wait until at least one round boundary has been checkpointed to disk.
    await waitFor(() => existsSync(path.join(records, `${id}.json`)));
    await waitFor(() => {
      const rec = JSON.parse(readFileSync(path.join(records, `${id}.json`), "utf8"));
      return Array.isArray(rec.checkpoint) && rec.checkpoint.length > 0;
    });

    // Manager 2 = a fresh process. It must recover the non-terminal run as
    // "interrupted", then resume it to completion with a finishing engine.
    const mgr2 = new AgentTaskManager(scriptedEngine([() => turn("done exploring")]));
    expect((mgr2.get(id) as { status: string }).status).toBe("interrupted");

    const res = mgr2.resume(id);
    expect(res.ok).toBe(true);
    await waitFor(() => (mgr2.get(id) as { status: string }).status === "done");

    // Resuming a non-interrupted task is refused.
    const again = mgr2.resume(id);
    expect(again.ok).toBe(false);
    // Resuming an unknown id is refused.
    expect(mgr2.resume("nope").ok).toBe(false);
  });
});
