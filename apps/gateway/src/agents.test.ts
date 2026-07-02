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
    const mgr = new AgentTaskManager(scriptedEngine([() => turn("hi there")]));
    const { id } = mgr.create({ task: "say hi", root });
    await waitFor(() => (mgr.get(id) as { status: string }).status === "done");

    const stream = mgr.subscribe(id)!;
    const text = await new Response(stream).text();
    expect(text).toContain('"type":"started"');
    expect(text).toContain('"type":"text"');
    expect(text).toContain('"type":"done"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(mgr.subscribe("nope")).toBeNull();
  });
});
