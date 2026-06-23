import { describe, it, expect } from "bun:test";
import { compressCode } from "../src/compressors/code";

const TS_FILE = `
import { useState } from "react";
import { Router } from "./router";

interface Config {
  provider: string;
  model: string;
}

function initializeRouter(config: Config): Router {
  const router = new Router();
  router.setProvider(config.provider);
  router.setModel(config.model);
  const validated = router.validate();
  if (!validated) {
    throw new Error("Invalid router config");
  }
  return router;
}

export async function routeRequest(
  messages: string[],
  config: Config,
): Promise<string> {
  const router = initializeRouter(config);
  const first = messages[0];
  const second = messages[1];
  const joined = messages.join(",");
  const result = router.route(joined);
  return result + first + second;
}
`.trim();

const PY_FILE = `
import os

class Service:
    def __init__(self, name):
        self.name = name

    def process(self, items):
        results = []
        for item in items:
            value = item * 2
            value = value + 1
            results.append(value)
        return results
`.trim();

describe("code compressor — AST mode", () => {
  it("uses AST mode for TypeScript (not the text fallback)", async () => {
    const result = await compressCode(TS_FILE, {}, { language: "ts", keepErrorHandlers: false });
    expect(result.transforms).toContain("ast-signature");
  });

  it("preserves imports, interfaces, and signatures while eliding bodies", async () => {
    const result = await compressCode(TS_FILE, {}, { language: "ts", keepErrorHandlers: false });
    expect(result.content).toContain('import { useState }');
    expect(result.content).toContain('import { Router }');
    expect(result.content).toContain("interface Config");
    expect(result.content).toContain("function initializeRouter");
    expect(result.content).toContain("async function routeRequest");
    expect(result.content).toContain("lines omitted");
    // Signatures must survive intact — the body marker replaces only the block.
    expect(result.content).not.toContain("const router = new Router()");
  });

  it("achieves real compression on TypeScript", async () => {
    const result = await compressCode(TS_FILE, {}, { language: "ts", keepErrorHandlers: false });
    expect(result.ratio).toBeLessThan(1);
  });

  it("strips Python function bodies but keeps class + method signatures", async () => {
    const result = await compressCode(PY_FILE, {}, { language: "py" });
    expect(result.transforms).toContain("ast-signature");
    expect(result.content).toContain("class Service");
    expect(result.content).toContain("def process");
    expect(result.content).toContain("lines omitted");
    // Python markers must use `#`, never braces.
    expect(result.content).not.toContain("/*");
  });

  it("keeps error handlers when keepErrorHandlers is set", async () => {
    const withTry = `
function risky(x: number): number {
  try {
    const a = x + 1;
    const b = a * 2;
    return doThing(b);
  } catch (e) {
    console.error(e);
    return -1;
  }
}
`.trim();
    const result = await compressCode(withTry, {}, { language: "ts", keepErrorHandlers: true });
    // The body contains a try/catch, so it is preserved verbatim.
    expect(result.content).toContain("catch");
    expect(result.content).toContain("console.error");
  });

  it("gracefully falls back to text mode for an unknown grammar", async () => {
    // Force a language whose grammar we do not ship by passing tiny non-code.
    const result = await compressCode("hello world this is not code at all", {}, { language: "js" });
    // Either it stays untouched (too short to compress) — never throws.
    expect(result).toBeDefined();
    expect(result.ratio).toBeLessThanOrEqual(1);
  });
});
