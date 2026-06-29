// B4 (edit-format fallback ladder + failed-edit recovery) tests.
//
// Proves: apply_diff applies a valid multi-hunk unified diff sandboxed, confirm-gated,
// and ATOMICALLY; a non-applying hunk fails atomically with a RECOVERABLE error and
// writes nothing; apply_edit's improved miss/non-unique errors include nearby file
// context; search/replace blocks work; and sandbox confinement holds for apply_diff.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolCallContentBlock } from "@zintus/types";
import {
  type AgentToolContext,
  type ConfirmWrite,
  createSandbox,
  executeAgentToolCall,
} from "./agent-tools.js";

let root: string;
let outside: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-edit-ladder-")));
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-edit-out-")));
  writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET", "utf8");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function ctxWith(
  confirmReturn: boolean,
): AgentToolContext & { confirmCalls: { path: string; diff: string }[] } {
  const confirmCalls: { path: string; diff: string }[] = [];
  const confirm: ConfirmWrite = ({ path: p, diff }) => {
    confirmCalls.push({ path: p, diff });
    return confirmReturn;
  };
  return {
    sandbox: createSandbox(root),
    confirm,
    budget: { used: 0, max: 50 },
    changeLog: [],
    confirmCalls,
  };
}

function call(name: string, args: Record<string, unknown>): ToolCallContentBlock {
  return { type: "tool_call", id: `c_${name}`, name, arguments: args };
}

describe("B4 apply_diff — multi-hunk, atomic, gated", () => {
  it("applies a valid multi-hunk unified diff (gated, budgeted, change-logged)", async () => {
    const ctx = ctxWith(true);
    const file = "src/app.ts";
    const original = [
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "const d = 4;",
      "const e = 5;",
      "",
    ].join("\n");
    const abs = path.join(root, file);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, original, "utf8");

    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 22;",
      "@@ -4,2 +4,2 @@",
      "-const d = 4;",
      "+const d = 44;",
      " const e = 5;",
    ].join("\n");

    const r = await executeAgentToolCall(call("apply_diff", { path: file, diff }), ctx);
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content).applied).toBe(true);
    expect(ctx.confirmCalls).toHaveLength(1); // confirm-gated
    expect(ctx.budget.used).toBe(1); // counts against the mutation budget
    expect(ctx.changeLog).toHaveLength(1);
    const after = readFileSync(abs, "utf8");
    expect(after).toContain("const b = 22;");
    expect(after).toContain("const d = 44;");
    expect(after).toContain("const a = 1;"); // untouched lines preserved
    expect(after).toContain("const c = 3;");
  });

  it("applies search/replace blocks too", async () => {
    const ctx = ctxWith(true);
    const file = "note.md";
    writeFileSync(path.join(root, file), "hello world\nsecond line\n", "utf8");
    const diff = [
      "<<<<<<< SEARCH",
      "hello world",
      "=======",
      "HELLO WORLD",
      ">>>>>>> REPLACE",
    ].join("\n");
    const r = await executeAgentToolCall(call("apply_diff", { path: file, diff }), ctx);
    expect(r.isError).toBe(false);
    expect(readFileSync(path.join(root, file), "utf8")).toBe(
      "HELLO WORLD\nsecond line\n",
    );
  });

  it("a non-applying hunk fails ATOMICALLY — writes nothing, recoverable error", async () => {
    const ctx = ctxWith(true);
    const file = "data.ts";
    const original = "const keep = 1;\nconst real = 2;\n";
    writeFileSync(path.join(root, file), original, "utf8");
    const diff = [
      "@@ -1,1 +1,1 @@",
      "-const keep = 1;",
      "+const keep = 100;",
      "@@ -2,1 +2,1 @@",
      "-const NOPE_does_not_exist = 9;",
      "+const NOPE_does_not_exist = 99;",
    ].join("\n");
    const r = await executeAgentToolCall(call("apply_diff", { path: file, diff }), ctx);
    expect(r.isError).toBe(true);
    const errMsg = JSON.parse(r.content).error as string;
    expect(errMsg).toContain("hunk 2"); // names the failing hunk
    expect(errMsg.toLowerCase()).toContain("nearest region"); // recoverable context
    // ATOMIC: even the first (valid) hunk was NOT applied, and the gate never fired.
    expect(readFileSync(path.join(root, file), "utf8")).toBe(original);
    expect(ctx.confirmCalls).toHaveLength(0);
    expect(ctx.budget.used).toBe(0);
  });

  it("declining the gate writes nothing", async () => {
    const ctx = ctxWith(false);
    const file = "x.ts";
    writeFileSync(path.join(root, file), "const a = 1;\n", "utf8");
    const diff = ["@@ -1 +1 @@", "-const a = 1;", "+const a = 2;"].join("\n");
    const r = await executeAgentToolCall(call("apply_diff", { path: file, diff }), ctx);
    expect(JSON.parse(r.content).declined).toBe(true);
    expect(readFileSync(path.join(root, file), "utf8")).toBe("const a = 1;\n");
  });

  it("REJECTS a diff whose path escapes the sandbox (no write)", async () => {
    const ctx = ctxWith(true);
    const rel = path.relative(root, path.join(outside, "secret.txt"));
    const diff = ["@@ -1 +1 @@", "-TOP SECRET", "+HACKED"].join("\n");
    const r = await executeAgentToolCall(call("apply_diff", { path: rel, diff }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the sandbox root");
    expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("TOP SECRET");
  });
});

describe("B4 apply_edit — recovery-oriented miss errors", () => {
  it("a MISS returns the closest region with line numbers", async () => {
    const ctx = ctxWith(true);
    const file = "m.ts";
    writeFileSync(
      path.join(root, file),
      "function alpha() {\n  return 1;\n}\nfunction beta() {\n  return 2;\n}\n",
      "utf8",
    );
    const r = await executeAgentToolCall(
      call("apply_edit", {
        path: file,
        old_string: "function alpa() {", // typo — no exact match
        new_string: "function alpha2() {",
      }),
      ctx,
    );
    expect(r.isError).toBe(true);
    const msg = JSON.parse(r.content).error as string;
    expect(msg).toContain("not found");
    expect(msg).toContain("Closest region");
    expect(msg).toContain("function alpha()"); // shows the near line
    expect(msg).toMatch(/\d+:/); // line-numbered
  });

  it("a NON-UNIQUE match returns the occurrence regions", async () => {
    const ctx = ctxWith(true);
    const file = "n.ts";
    writeFileSync(path.join(root, file), "x = 1;\ny = 2;\nx = 1;\n", "utf8");
    const r = await executeAgentToolCall(
      call("apply_edit", { path: file, old_string: "x = 1;", new_string: "x = 9;" }),
      ctx,
    );
    expect(r.isError).toBe(true);
    const msg = JSON.parse(r.content).error as string;
    expect(msg).toContain("matches 2 times");
    expect(msg).toContain("unique");
    expect(msg).toMatch(/\d+:/);
  });
});
