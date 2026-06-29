// B5 (NOTES.md scratchpad / working memory) tests.
//
// Proves: append_note writes a bounded, sandbox-confined NOTES.md; read_notes returns
// it; the file stays under the byte cap (oldest entries trimmed); and the scratchpad
// path is always inside the sandbox root (path-confined).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolCallContentBlock } from "@zintus/types";
import {
  MAX_NOTES_BYTES,
  NOTES_FILENAME,
  type AgentToolContext,
  type ConfirmWrite,
  createSandbox,
  executeAgentToolCall,
  notesPath,
} from "./agent-tools.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-notes-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(): AgentToolContext & { confirmCalls: number } {
  let confirmCalls = 0;
  const confirm: ConfirmWrite = () => {
    confirmCalls += 1;
    return true;
  };
  const base: AgentToolContext = {
    sandbox: createSandbox(root),
    confirm,
    budget: { used: 0, max: 50 },
    changeLog: [],
  };
  return Object.assign(base, {
    get confirmCalls() {
      return confirmCalls;
    },
  });
}

function call(name: string, args: Record<string, unknown>): ToolCallContentBlock {
  return { type: "tool_call", id: `c_${name}`, name, arguments: args };
}

describe("B5 NOTES scratchpad", () => {
  it("append_note writes NOTES.md within the sandbox; read_notes returns it", async () => {
    const c = ctx();
    const a = await executeAgentToolCall(
      call("append_note", { note: "found the bug in router.ts" }),
      c,
    );
    expect(a.isError).toBe(false);
    expect(JSON.parse(a.content).appended).toBe(true);

    const abs = path.join(root, NOTES_FILENAME);
    expect(existsSync(abs)).toBe(true);
    // Confined to the sandbox root.
    expect(notesPath(c.sandbox)).toBe(abs);
    expect(abs.startsWith(root + path.sep)).toBe(true);

    const file = readFileSync(abs, "utf8");
    expect(file).toContain("found the bug in router.ts");

    const r = await executeAgentToolCall(call("read_notes", {}), c);
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content).notes).toContain("found the bug in router.ts");
  });

  it("is LOW-friction: append_note never invokes the confirm gate or the budget", async () => {
    const c = ctx();
    await executeAgentToolCall(call("append_note", { note: "a" }), c);
    await executeAgentToolCall(call("append_note", { note: "b" }), c);
    expect(c.confirmCalls).toBe(0);
    expect(c.budget.used).toBe(0); // exempt from the mutation budget (documented)
  });

  it("read_notes on an empty scratchpad returns empty (not an error)", async () => {
    const c = ctx();
    const r = await executeAgentToolCall(call("read_notes", {}), c);
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.content);
    expect(parsed.empty).toBe(true);
    expect(parsed.notes).toBe("");
  });

  it("stays BOUNDED under the byte cap by trimming oldest entries", async () => {
    const c = ctx();
    const big = "z".repeat(4000); // each entry ~4KB, capped per-note at 2000 chars
    for (let i = 0; i < 60; i += 1) {
      // ~60 * 2KB worth of entries — well over MAX_NOTES_BYTES (64KB).
      await executeAgentToolCall(call("append_note", { note: `${i}-${big}` }), c);
    }
    const abs = path.join(root, NOTES_FILENAME);
    expect(statSync(abs).size).toBeLessThanOrEqual(MAX_NOTES_BYTES);
    const file = readFileSync(abs, "utf8");
    expect(file).toContain("older notes trimmed"); // honest trim marker
    expect(file).toContain("59-"); // the NEWEST entry survives
  });

  it("rejects an empty note", async () => {
    const c = ctx();
    const r = await executeAgentToolCall(call("append_note", { note: "   " }), c);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content).error).toContain("note is required");
  });
});
