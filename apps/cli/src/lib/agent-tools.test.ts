import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import type { ToolCallContentBlock } from "@zintus/types";
import {
  AGENT_TOOL_DEFINITIONS,
  DEFAULT_AGENT_ROUNDS,
  MAX_AGENT_ROUNDS_CAP,
  MAX_FILE_BYTES,
  MAX_RUN_OUTPUT_BYTES,
  RUN_COMMAND_TIMEOUT_MS,
  type AgentRunConfig,
  type AgentToolContext,
  type ConfirmWrite,
  type RunCommandResult,
  type RunCommandSpawn,
  buildDiff,
  createSandbox,
  executeAgentToolCall,
  isMutatingTool,
  resolveAllowedCommand,
  runAgentToolLoop,
  toolRequiresConfirmation,
  type ToolLoopTurn,
} from "./agent-tools.js";
import type { ToolExecutionResult } from "./builtin-tools.js";

let root: string;
/** A directory OUTSIDE the sandbox, to host escape targets. */
let outside: string;

beforeEach(() => {
  // realpathSync to defeat macOS /var -> /private/var symlinking in the temp dir.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-agent-root-")));
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-agent-out-")));
  writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** A context whose confirm gate records calls and returns a fixed verdict. */
function ctxWith(
  confirmReturn: boolean,
  budgetMax = 50,
): AgentToolContext & { confirmCalls: { path: string; diff: string }[] } {
  const confirmCalls: { path: string; diff: string }[] = [];
  const confirm: ConfirmWrite = ({ path: p, diff }) => {
    confirmCalls.push({ path: p, diff });
    return confirmReturn;
  };
  return {
    sandbox: createSandbox(root),
    confirm,
    budget: { used: 0, max: budgetMax },
    confirmCalls,
  };
}

function call(name: string, args: Record<string, unknown>): ToolCallContentBlock {
  return { type: "tool_call", id: `c_${name}`, name, arguments: args };
}

describe("sandbox path enforcement", () => {
  it("read/write/edit work WITHIN the root", async () => {
    const ctx = ctxWith(true);
    // write
    const w = await executeAgentToolCall(call("write_file", { path: "a/b.txt", content: "hello" }), ctx);
    expect(w.isError).toBe(false);
    expect(JSON.parse(w.content).applied).toBe(true);
    expect(readFileSync(path.join(root, "a/b.txt"), "utf8")).toBe("hello");
    // read
    const r = await executeAgentToolCall(call("read_file", { path: "a/b.txt" }), ctx);
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content).content).toBe("hello");
    // edit
    const e = await executeAgentToolCall(
      call("apply_edit", { path: "a/b.txt", old_string: "hello", new_string: "world" }),
      ctx,
    );
    expect(e.isError).toBe(false);
    expect(readFileSync(path.join(root, "a/b.txt"), "utf8")).toBe("world");
  });

  it("REJECTS ../../ traversal and touches no file", async () => {
    const ctx = ctxWith(true);
    const r = await executeAgentToolCall(
      call("read_file", { path: "../../etc/passwd" }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the sandbox root");
  });

  it("REJECTS a write via ../ traversal — the outside file is NOT modified", async () => {
    const ctx = ctxWith(true);
    const rel = path.relative(root, path.join(outside, "secret.txt"));
    const r = await executeAgentToolCall(
      call("write_file", { path: rel, content: "HACKED" }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(ctx.confirmCalls).toHaveLength(0); // gate never even reached
    expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("TOP SECRET");
  });

  it("REJECTS an absolute path outside the root", async () => {
    const ctx = ctxWith(true);
    const r = await executeAgentToolCall(
      call("read_file", { path: path.join(outside, "secret.txt") }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the sandbox root");
  });

  it("REJECTS a symlink whose realpath escapes the root (read)", async () => {
    // A symlink INSIDE the root pointing at a file OUTSIDE the root.
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    const ctx = ctxWith(true);
    const r = await executeAgentToolCall(call("read_file", { path: "link.txt" }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("symlink");
  });

  it("REJECTS a write through a symlinked DIRECTORY that escapes the root", async () => {
    // Symlinked dir inside root -> outside dir; writing 'evil/x' must be blocked.
    symlinkSync(outside, path.join(root, "evil"));
    const ctx = ctxWith(true);
    const r = await executeAgentToolCall(
      call("write_file", { path: "evil/pwned.txt", content: "x" }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(ctx.confirmCalls).toHaveLength(0);
    expect(existsSync(path.join(outside, "pwned.txt"))).toBe(false);
  });

  it("rejects a NUL byte in the path", async () => {
    const ctx = ctxWith(true);
    const r = await executeAgentToolCall(call("read_file", { path: "a\0b" }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("null byte");
  });
});

describe("write gate", () => {
  it("confirm=false => NOT applied and returns 'user declined'", async () => {
    const ctx = ctxWith(false);
    const r = await executeAgentToolCall(
      call("write_file", { path: "f.txt", content: "data" }),
      ctx,
    );
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.content);
    expect(parsed.declined).toBe(true);
    expect(parsed.message).toContain("declined");
    expect(existsSync(path.join(root, "f.txt"))).toBe(false);
    expect(ctx.confirmCalls).toHaveLength(1);
    expect(ctx.budget.used).toBe(0);
  });

  it("confirm=true => applied", async () => {
    const ctx = ctxWith(true);
    const r = await executeAgentToolCall(
      call("write_file", { path: "f.txt", content: "data" }),
      ctx,
    );
    expect(JSON.parse(r.content).applied).toBe(true);
    expect(readFileSync(path.join(root, "f.txt"), "utf8")).toBe("data");
    expect(ctx.budget.used).toBe(1);
    // The gate received a diff preview.
    expect(ctx.confirmCalls[0]!.diff).toContain("+ data");
  });

  it("a declined apply_edit leaves the file unchanged", async () => {
    writeFileSync(path.join(root, "g.txt"), "alpha", "utf8");
    const ctx = ctxWith(false);
    const r = await executeAgentToolCall(
      call("apply_edit", { path: "g.txt", old_string: "alpha", new_string: "beta" }),
      ctx,
    );
    expect(JSON.parse(r.content).declined).toBe(true);
    expect(readFileSync(path.join(root, "g.txt"), "utf8")).toBe("alpha");
  });
});

describe("apply_edit match semantics", () => {
  it("not found => error, no write", async () => {
    writeFileSync(path.join(root, "h.txt"), "one two three", "utf8");
    const ctx = ctxWith(true);
    const r = await executeAgentToolCall(
      call("apply_edit", { path: "h.txt", old_string: "MISSING", new_string: "x" }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not found");
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  it("multiple matches => error, no write", async () => {
    writeFileSync(path.join(root, "i.txt"), "foo\nfoo\nfoo", "utf8");
    const ctx = ctxWith(true);
    const r = await executeAgentToolCall(
      call("apply_edit", { path: "i.txt", old_string: "foo", new_string: "bar" }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("matches 3 times");
    expect(readFileSync(path.join(root, "i.txt"), "utf8")).toBe("foo\nfoo\nfoo");
  });

  it("exact unique match => applied", async () => {
    writeFileSync(path.join(root, "j.txt"), "keep\nUNIQUE\nkeep", "utf8");
    const ctx = ctxWith(true);
    const r = await executeAgentToolCall(
      call("apply_edit", { path: "j.txt", old_string: "UNIQUE", new_string: "CHANGED" }),
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(readFileSync(path.join(root, "j.txt"), "utf8")).toBe("keep\nCHANGED\nkeep");
  });
});

describe("size + mutation caps", () => {
  it("refuses a read over the size cap", async () => {
    const big = path.join(root, "big.bin");
    writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    const ctx = ctxWith(true);
    const r = await executeAgentToolCall(call("read_file", { path: "big.bin" }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("read cap");
  });

  it("refuses a write over the size cap (before the gate)", async () => {
    const ctx = ctxWith(true);
    const huge = "a".repeat(MAX_FILE_BYTES + 1);
    const r = await executeAgentToolCall(
      call("write_file", { path: "huge.txt", content: huge }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("write cap");
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  it("enforces the mutation budget", async () => {
    const ctx = ctxWith(true, 1);
    const r1 = await executeAgentToolCall(call("write_file", { path: "x.txt", content: "1" }), ctx);
    expect(JSON.parse(r1.content).applied).toBe(true);
    const r2 = await executeAgentToolCall(call("write_file", { path: "y.txt", content: "2" }), ctx);
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain("budget exhausted");
    expect(existsSync(path.join(root, "y.txt"))).toBe(false);
  });
});

describe("read-only tools", () => {
  it("list_directory and search_code work within the root", async () => {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "main.ts"), "const needle = 1;\nother\n", "utf8");
    const ctx = ctxWith(true);
    const list = await executeAgentToolCall(call("list_directory", { path: "." }), ctx);
    expect(JSON.parse(list.content).entries.map((e: { name: string }) => e.name)).toContain("src");
    const search = await executeAgentToolCall(call("search_code", { query: "needle" }), ctx);
    const res = JSON.parse(search.content);
    expect(res.matchCount).toBe(1);
    expect(res.matches[0].file).toContain("main.ts");
    expect(res.matches[0].line).toBe(1);
  });

  it("search_code does not follow symlinks out of the root", async () => {
    symlinkSync(outside, path.join(root, "out"));
    const ctx = ctxWith(true);
    const search = await executeAgentToolCall(call("search_code", { query: "SECRET" }), ctx);
    expect(JSON.parse(search.content).matchCount).toBe(0);
  });
});

describe("tool surface + helpers", () => {
  it("exposes exactly the nine agent tools", () => {
    expect(AGENT_TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      "apply_edit",
      "find_relevant_code",
      "list_directory",
      "read_file",
      "retrieve",
      "run_command",
      "search_code",
      "update_plan",
      "write_file",
    ]);
  });

  it("flags only the mutating tools", () => {
    expect(isMutatingTool("write_file")).toBe(true);
    expect(isMutatingTool("apply_edit")).toBe(true);
    expect(isMutatingTool("read_file")).toBe(false);
    expect(isMutatingTool("run_command")).toBe(false); // side-effecting, not a write
    expect(isMutatingTool("nope")).toBe(false);
  });

  it("flags tools that require confirmation (writes + run_command)", () => {
    expect(toolRequiresConfirmation("write_file")).toBe(true);
    expect(toolRequiresConfirmation("apply_edit")).toBe(true);
    expect(toolRequiresConfirmation("run_command")).toBe(true);
    expect(toolRequiresConfirmation("read_file")).toBe(false);
    expect(toolRequiresConfirmation("search_code")).toBe(false);
    expect(toolRequiresConfirmation("nope")).toBe(false);
  });

  it("unknown tool => surfaced as an error, never executed", async () => {
    const ctx = ctxWith(true);
    const r = await executeAgentToolCall(call("delete_everything", { cmd: "rm -rf /" }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("unknown tool: delete_everything");
  });

  it("buildDiff shows removed and added lines", () => {
    const d = buildDiff("f.txt", "a\nb\nc", "a\nX\nc");
    expect(d).toContain("- b");
    expect(d).toContain("+ X");
  });
});

/** A run-enabled ctx whose confirm gate AND spawn are recorded, so the allowlist /
 *  gate / budget can be exercised WITHOUT launching any real process. */
function runCtx(opts: {
  confirm?: boolean;
  allow?: boolean;
  budgetMax?: number;
  spawnResult?: Partial<RunCommandResult>;
}): AgentToolContext & {
  confirmCalls: { path: string; diff: string }[];
  spawnCalls: { argv: string[]; cwd: string; timeoutMs: number }[];
} {
  const confirmCalls: { path: string; diff: string }[] = [];
  const spawnCalls: { argv: string[]; cwd: string; timeoutMs: number }[] = [];
  const confirm: ConfirmWrite = ({ path: p, diff }) => {
    confirmCalls.push({ path: p, diff });
    return opts.confirm ?? true;
  };
  const spawn: RunCommandSpawn = (argv, o) => {
    spawnCalls.push({ argv, cwd: o.cwd, timeoutMs: o.timeoutMs });
    return { code: 0, stdout: "ok", stderr: "", timedOut: false, ...opts.spawnResult };
  };
  const run: AgentRunConfig = {
    allow: opts.allow ?? true,
    budget: { used: 0, max: opts.budgetMax ?? 10 },
    spawn,
  };
  return {
    sandbox: createSandbox(root),
    confirm,
    budget: { used: 0, max: 50 },
    run,
    confirmCalls,
    spawnCalls,
  };
}

describe("resolveAllowedCommand (pure validator — never spawns)", () => {
  const sandbox = () => createSandbox(root);
  it("accepts each allowlisted verification command", () => {
    for (const cmd of [
      "bun run test",
      "bun run typecheck",
      "bun run lint",
      "bun run build",
      "bun run check",
      "bun test",
    ]) {
      const r = resolveAllowedCommand(cmd, sandbox());
      expect("argv" in r).toBe(true);
    }
  });

  it("rejects non-allowlisted commands", () => {
    for (const cmd of [
      "git status",
      "curl http://evil",
      "wget http://evil",
      "bun install",
      "npm run test",
      "node script.js",
      "rm -rf /",
    ]) {
      const r = resolveAllowedCommand(cmd, sandbox());
      expect("error" in r).toBe(true);
    }
  });

  it("rejects shell metacharacters / chaining tokens", () => {
    for (const cmd of [
      "bun test; rm -rf /",
      "bun run test && rm -rf /",
      "bun run test | cat",
      "bun test `rm -rf /`",
      "bun test $(rm -rf /)",
      "bun run test > /etc/passwd",
    ]) {
      const r = resolveAllowedCommand(cmd, sandbox());
      expect("error" in r).toBe(true);
    }
  });

  it("rejects a bun test path that escapes the sandbox", () => {
    const r = resolveAllowedCommand("bun test ../../etc/passwd", sandbox());
    expect("error" in r).toBe(true);
  });

  it("accepts bun test with a sandbox-relative path", () => {
    writeFileSync(path.join(root, "x.test.ts"), "", "utf8");
    const r = resolveAllowedCommand("bun test x.test.ts", sandbox());
    expect("argv" in r && r.argv).toEqual(["bun", "test", "x.test.ts"]);
  });
});

describe("run_command tool", () => {
  it("is DISABLED with no run config — refuses, no spawn, no confirm", async () => {
    const ctx = ctxWith(true); // ctxWith has no run config
    const r = await executeAgentToolCall(
      call("run_command", { command: "bun run test" }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("disabled");
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  it("is DISABLED when run.allow is false — no spawn, no confirm", async () => {
    const ctx = runCtx({ allow: false });
    const r = await executeAgentToolCall(
      call("run_command", { command: "bun run test" }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("disabled");
    expect(ctx.spawnCalls).toHaveLength(0);
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  it("REJECTS a non-allowlisted command with no spawn and no confirm", async () => {
    const ctx = runCtx({});
    const r = await executeAgentToolCall(
      call("run_command", { command: "rm -rf /" }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not allowed");
    expect(ctx.spawnCalls).toHaveLength(0);
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  it("REJECTS metachar injection / chaining with no spawn", async () => {
    for (const command of [
      "bun test; rm -rf /",
      "bun run test && rm -rf /",
      "bun run test | cat",
      "bun test `rm -rf /`",
      "bun test $(rm -rf /)",
    ]) {
      const ctx = runCtx({});
      const r = await executeAgentToolCall(call("run_command", { command }), ctx);
      expect(r.isError).toBe(true);
      expect(ctx.spawnCalls).toHaveLength(0);
      expect(ctx.confirmCalls).toHaveLength(0);
    }
  });

  it("REJECTS a cwd escape via the bun test path with no spawn", async () => {
    const ctx = runCtx({});
    const r = await executeAgentToolCall(
      call("run_command", { command: "bun test ../../etc/passwd" }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(ctx.spawnCalls).toHaveLength(0);
    expect(ctx.confirmCalls).toHaveLength(0);
  });

  it("runs an allowlisted command: argv, cwd, timeout, exit code + output, budget", async () => {
    const ctx = runCtx({ spawnResult: { code: 1, stdout: "FAILED 2 tests", stderr: "boom" } });
    const r = await executeAgentToolCall(
      call("run_command", { command: "bun run test" }),
      ctx,
    );
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.content);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.stdout).toBe("FAILED 2 tests");
    expect(parsed.stderr).toContain("boom");
    expect(parsed.runsUsed).toBe(1);
    // exactly one spawn, with the right argv / cwd / hard timeout.
    expect(ctx.spawnCalls).toHaveLength(1);
    expect(ctx.spawnCalls[0]!.argv).toEqual(["bun", "run", "test"]);
    expect(ctx.spawnCalls[0]!.cwd).toBe(ctx.sandbox.root);
    expect(ctx.spawnCalls[0]!.timeoutMs).toBe(RUN_COMMAND_TIMEOUT_MS);
    expect(ctx.run!.budget.used).toBe(1);
    // the gate saw the argv preview.
    expect(ctx.confirmCalls[0]!.diff).toContain("bun run test");
  });

  it("does NOT run when confirmation is denied — no spawn, budget untouched", async () => {
    const ctx = runCtx({ confirm: false });
    const r = await executeAgentToolCall(
      call("run_command", { command: "bun run test" }),
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content).declined).toBe(true);
    expect(ctx.spawnCalls).toHaveLength(0);
    expect(ctx.run!.budget.used).toBe(0);
  });

  it("respects the run budget — refuses further runs with no extra spawn", async () => {
    const ctx = runCtx({ budgetMax: 1 });
    const r1 = await executeAgentToolCall(
      call("run_command", { command: "bun run test" }),
      ctx,
    );
    expect(r1.isError).toBe(false);
    const r2 = await executeAgentToolCall(
      call("run_command", { command: "bun run typecheck" }),
      ctx,
    );
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain("run budget exhausted");
    expect(ctx.spawnCalls).toHaveLength(1); // second run never spawned
  });

  it("truncates oversized output to the byte cap", async () => {
    const big = "a".repeat(MAX_RUN_OUTPUT_BYTES + 500);
    const ctx = runCtx({ spawnResult: { code: 0, stdout: big, stderr: "" } });
    const r = await executeAgentToolCall(
      call("run_command", { command: "bun run build" }),
      ctx,
    );
    const parsed = JSON.parse(r.content);
    expect(parsed.outputTruncated).toBe(true);
    expect(parsed.stdout).toContain("truncated");
    expect(parsed.stdout.length).toBeLessThan(big.length);
  });

  it("surfaces a timeout through to the model", async () => {
    const ctx = runCtx({ spawnResult: { code: null, stdout: "", stderr: "", timedOut: true } });
    const r = await executeAgentToolCall(
      call("run_command", { command: "bun run test" }),
      ctx,
    );
    const parsed = JSON.parse(r.content);
    expect(parsed.timedOut).toBe(true);
    expect(parsed.exitCode).toBe(null);
  });
});

/** Minimal turn stream for the loop test (mirrors the engine's text channel). */
function textStream(text: string): AsyncIterable<string> {
  return (async function* () {
    if (text) yield text;
  })();
}
function makeTurn(text: string, toolCalls?: ToolCallContentBlock[]): ToolLoopTurn {
  return { stream: textStream(text), toolCalls };
}

describe("runAgentToolLoop", () => {
  it("executes a tool, feeds the result back, then returns the final answer", async () => {
    writeFileSync(path.join(root, "k.txt"), "content", "utf8");
    const ctx = ctxWith(true);
    const turns: ToolLoopTurn[] = [
      makeTurn("", [call("read_file", { path: "k.txt" })]),
      makeTurn("All done."),
    ];
    const executed: ToolExecutionResult[] = [];
    const { rounds } = await runAgentToolLoop([{ role: "user", content: "read it" }], {
      route: async () => turns.shift()!,
      execute: async (c) => {
        const r = await executeAgentToolCall(
          { id: c.id, name: c.name, arguments: c.arguments },
          ctx,
        );
        executed.push(r);
        return r;
      },
    });
    expect(rounds).toBe(2);
    expect(executed).toHaveLength(1);
    expect(JSON.parse(executed[0]!.content).content).toBe("content");
  });

  it("is BOUNDED — a runaway model stops at maxRounds", async () => {
    let routeCalls = 0;
    let stoppedAt: number | undefined;
    const maxRounds = 3;
    const { rounds } = await runAgentToolLoop([{ role: "user", content: "loop" }], {
      maxRounds,
      route: async () => {
        routeCalls += 1;
        return makeTurn("", [call("read_file", { path: "k.txt" })]);
      },
      execute: async () => ({ toolCallId: "x", content: "{}", isError: false }),
      onStopped: (m) => {
        stoppedAt = m;
      },
    });
    expect(routeCalls).toBe(maxRounds + 1);
    expect(rounds).toBe(maxRounds + 1);
    expect(stoppedAt).toBe(maxRounds);
  });

  it("clamps maxRounds to the hard cap", async () => {
    let routeCalls = 0;
    await runAgentToolLoop([{ role: "user", content: "loop" }], {
      maxRounds: MAX_AGENT_ROUNDS_CAP + 100,
      route: async () => {
        routeCalls += 1;
        return makeTurn("", [call("read_file", { path: "k.txt" })]);
      },
      execute: async () => ({ toolCallId: "x", content: "{}", isError: false }),
    });
    // At most CAP + 1 routes even though a far larger maxRounds was requested.
    expect(routeCalls).toBe(MAX_AGENT_ROUNDS_CAP + 1);
  });

  it("DEFAULT_AGENT_ROUNDS is 15", () => {
    expect(DEFAULT_AGENT_ROUNDS).toBe(15);
  });
});
