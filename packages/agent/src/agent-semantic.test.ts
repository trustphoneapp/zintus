import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolCallContentBlock } from "@zintus/types";
import {
  AGENT_TOOL_DEFINITIONS,
  DEFAULT_SEMANTIC_RESULTS,
  MAX_SEMANTIC_RESULTS,
  MAX_SNIPPET_CHARS,
  type AgentSemanticConfig,
  type AgentToolContext,
  type ConfirmWrite,
  createSandbox,
  executeAgentToolCall,
} from "./agent-tools.js";

let root: string;
/** A directory OUTSIDE the sandbox (escape targets / db files live here). */
let outside: string;
/** Where the per-run sqlite index db is created (kept OUT of the sandbox). */
let indexDir: string;

beforeEach(() => {
  // realpathSync to defeat macOS /var -> /private/var symlinking in temp dirs.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-sem-root-")));
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-sem-out-")));
  indexDir = realpathSync(mkdtempSync(path.join(tmpdir(), "zintus-sem-idx-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(indexDir, { recursive: true, force: true });
});

/** confirm gate is never invoked by the read-only tool; default to NO anyway. */
const denyConfirm: ConfirmWrite = () => false;

function makeCtx(semantic?: AgentSemanticConfig): AgentToolContext {
  return {
    sandbox: createSandbox(root),
    confirm: denyConfirm,
    budget: { used: 0, max: 50 },
    semantic: { indexDir, ...semantic },
  };
}

function call(args: Record<string, unknown>): ToolCallContentBlock {
  return { type: "tool_call", id: "c_find", name: "find_relevant_code", arguments: args };
}

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const AUTH = `// User login and authentication module.
// Handles login, password checks and session creation for an authenticated user.
export function loginUser(username, password) {
  return verifyPassword(username, password);
}
`;
const PAYMENTS = `// Payment processing and invoice generation.
export function processPayment(amount, invoice) {
  return chargeCard(amount, invoice);
}
`;
const UI = `// Render the dashboard buttons and layout.
export function renderDashboard(state) {
  return draw(state);
}
`;

describe("find_relevant_code — registration", () => {
  it("is exposed as an agent tool definition", () => {
    const def = AGENT_TOOL_DEFINITIONS.find((d) => d.name === "find_relevant_code");
    expect(def).toBeDefined();
    expect(def?.parameters.required).toContain("query");
  });
});

describe("find_relevant_code — lexical fallback (NO embedder)", () => {
  it("ranks the relevant file first and reports lexical mode", async () => {
    write("src/auth.ts", AUTH);
    write("src/payments.ts", PAYMENTS);
    write("src/ui.ts", UI);
    const ctx = makeCtx(); // no embed => lexical

    const res = await executeAgentToolCall(
      call({ query: "where is user login and authentication handled" }),
      ctx,
    );
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content);
    expect(out.mode).toBe("lexical");
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0].file).toBe("src/auth.ts");
    // line range + snippet present
    expect(out.results[0].startLine).toBeGreaterThanOrEqual(1);
    expect(out.results[0].endLine).toBeGreaterThanOrEqual(out.results[0].startLine);
    expect(out.results[0].snippet).toContain("loginUser");
  });

  it("requires a non-empty query", async () => {
    write("src/auth.ts", AUTH);
    const ctx = makeCtx();
    const res = await executeAgentToolCall(call({ query: "   " }), ctx);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).error).toContain("query");
  });
});

describe("find_relevant_code — sandbox confinement", () => {
  it("never returns files outside the sandbox root", async () => {
    write("src/auth.ts", AUTH);
    // A juicy match OUTSIDE the sandbox — must never be indexed or returned.
    writeFileSync(
      path.join(outside, "leak.ts"),
      "// user login authentication login authentication user secret\n",
      "utf8",
    );
    const ctx = makeCtx();
    const res = await executeAgentToolCall(
      call({ query: "user login authentication", limit: 20 }),
      ctx,
    );
    const out = JSON.parse(res.content);
    for (const r of out.results) {
      expect(r.file.startsWith("..")).toBe(false);
      expect(path.isAbsolute(r.file)).toBe(false);
      expect(r.file).not.toContain("leak");
    }
    // The outside match contributed nothing — only the in-sandbox file is found.
    expect(out.results.some((r: { file: string }) => r.file === "src/auth.ts")).toBe(true);
  });
});

describe("find_relevant_code — vector mode (injected embedder)", () => {
  it("uses vector ranking when an embedder is provided", async () => {
    write("src/auth.ts", AUTH);
    write("src/payments.ts", PAYMENTS);
    write("src/ui.ts", UI);

    // A deterministic, key-free fake embedder: one-hot over a tiny vocabulary so
    // cosine similarity favors the chunk sharing the query's keywords.
    const VOCAB = ["login", "authentication", "password", "payment", "invoice", "render"];
    const embed: AgentSemanticConfig["embed"] = async (texts) =>
      texts.map((t) => {
        const lower = t.toLowerCase();
        const v: number[] = VOCAB.map((w) => (lower.includes(w) ? 1 : 0));
        v.push(0.001); // baseline so an all-miss chunk still has magnitude
        return v;
      });

    const ctx = makeCtx({ embed });
    const res = await executeAgentToolCall(
      call({ query: "login and authentication" }),
      ctx,
    );
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content);
    expect(out.mode).toBe("vector");
    expect(out.results[0].file).toBe("src/auth.ts");
  });
});

describe("find_relevant_code — bounds", () => {
  it("caps results at MAX_SEMANTIC_RESULTS and honors a small limit", async () => {
    for (let i = 0; i < MAX_SEMANTIC_RESULTS + 5; i += 1) {
      write(`src/file${i}.ts`, `// user login authentication module ${i}\nexport const x${i} = 1;\n`);
    }
    const ctx = makeCtx();

    const big = JSON.parse(
      (await executeAgentToolCall(call({ query: "user login authentication", limit: 999 }), ctx)).content,
    );
    expect(big.results.length).toBeLessThanOrEqual(MAX_SEMANTIC_RESULTS);

    const one = JSON.parse(
      (await executeAgentToolCall(call({ query: "user login authentication", limit: 1 }), ctx)).content,
    );
    expect(one.results.length).toBe(1);
  });

  it("defaults to DEFAULT_SEMANTIC_RESULTS when no limit is given", async () => {
    for (let i = 0; i < DEFAULT_SEMANTIC_RESULTS + 4; i += 1) {
      write(`src/file${i}.ts`, `// user login authentication module ${i}\nexport const x${i} = 1;\n`);
    }
    const ctx = makeCtx();
    const out = JSON.parse(
      (await executeAgentToolCall(call({ query: "user login authentication" }), ctx)).content,
    );
    expect(out.results.length).toBe(DEFAULT_SEMANTIC_RESULTS);
  });

  it("truncates oversized snippets to the cap", async () => {
    const longLine = "login authentication user ".repeat(4); // ~104 chars
    const lines = Array.from({ length: 40 }, () => longLine).join("\n");
    write("src/huge.ts", `${lines}\n`);
    const ctx = makeCtx();
    const out = JSON.parse(
      (await executeAgentToolCall(call({ query: "login authentication user" }), ctx)).content,
    );
    const hit = out.results.find((r: { file: string }) => r.file === "src/huge.ts");
    expect(hit).toBeDefined();
    expect(hit.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS + 40);
    expect(hit.snippet).toContain("snippet truncated");
  });
});

describe("find_relevant_code — per-run index caching", () => {
  it("builds the index ONCE across multiple queries", async () => {
    write("src/auth.ts", AUTH);
    write("src/payments.ts", PAYMENTS);
    let built = 0;
    const ctx = makeCtx({ onIndexBuilt: () => { built += 1; } });

    await executeAgentToolCall(call({ query: "login" }), ctx);
    await executeAgentToolCall(call({ query: "payment invoice" }), ctx);
    await executeAgentToolCall(call({ query: "user" }), ctx);
    expect(built).toBe(1);
  });
});
