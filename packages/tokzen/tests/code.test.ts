import { describe, it, expect } from "bun:test";
import { compressCode } from "../src/compressors/code";

const TS_CODE = `
import { Request, Response } from "express";
import { validate } from "./validator";

export interface HandlerOptions {
  timeout: number;
  retries: number;
}

/**
 * Handle incoming HTTP requests.
 * Routes them to the appropriate handler.
 */
export async function handleRequest(
  req: Request,
  res: Response,
  opts: HandlerOptions,
): Promise<void> {
  const validated = validate(req.body);
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }
  try {
    const result = await processRequest(validated.data, opts);
    res.json(result);
  } catch (err) {
    console.error("Handler error:", err);
    res.status(500).json({ error: "Internal error" });
  }
}

async function processRequest(data: unknown, opts: HandlerOptions): Promise<unknown> {
  // Long implementation
  await new Promise((r) => setTimeout(r, opts.timeout));
  const lines: string[] = [];
  for (let i = 0; i < opts.retries; i++) {
    lines.push(\`Attempt \${i}\`);
  }
  return { lines, data };
}
`.trim();

describe("compressCode", () => {
  it("preserves import statements", async () => {
    const result = await compressCode(TS_CODE);
    expect(result.content).toContain('import { Request, Response }');
  });

  it("preserves function signatures", async () => {
    const result = await compressCode(TS_CODE);
    expect(result.content).toContain("handleRequest");
  });

  it("preserves interface declarations", async () => {
    const result = await compressCode(TS_CODE);
    expect(result.content).toContain("HandlerOptions");
  });

  it("compresses long function bodies", async () => {
    const result = await compressCode(TS_CODE);
    expect(result.ratio).toBeLessThan(1);
  });

  it("elides bodies with an honest marker (no false retrieve promise)", async () => {
    const result = await compressCode(TS_CODE);
    // Lossy-but-honest: no CCR hash, and no retrieve() round-trip is promised
    // (the gateway has no tool-calling path to satisfy one).
    expect(result.ccrHashes).toHaveLength(0);
    expect(result.content).not.toContain("retrieve(");
    expect(result.content).toContain("bodies elided");
  });

  it("returns original on error without throwing", async () => {
    const result = await compressCode("this is not really code");
    expect(result.content).toBeTruthy();
    expect(result.ratio).toBeLessThanOrEqual(1);
  });

  it("never throws on empty input", async () => {
    const result = await compressCode("");
    expect(result).toBeDefined();
  });

  it("detects TypeScript by type annotations", async () => {
    const ts = `const x: number = 42;\nfunction greet(name: string): string { return \`Hello \${name}\`; }`;
    const result = await compressCode(ts, {}, { language: "ts" });
    expect(result.content).toBeTruthy();
  });
});
