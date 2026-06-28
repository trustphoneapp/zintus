import { describe, expect, test } from "bun:test";
import {
  BUILTIN_TOOL_DEFINITIONS,
  executeWebToolCall,
} from "./web-tools";

function run(name: string, args: Record<string, unknown>) {
  const r = executeWebToolCall({ id: "call_1", name, arguments: args });
  return { ...r, parsed: JSON.parse(r.content) as Record<string, unknown> };
}

describe("web-tools built-in definitions", () => {
  test("exposes calculator, current_datetime, random_number", () => {
    const names = BUILTIN_TOOL_DEFINITIONS.map((t) => t.name).sort();
    expect(names).toEqual(["calculator", "current_datetime", "random_number"]);
    // Each definition is a well-formed object schema.
    for (const def of BUILTIN_TOOL_DEFINITIONS) {
      expect(typeof def.description).toBe("string");
      expect(def.parameters.type).toBe("object");
    }
  });
});

describe("calculator (eval-free, CSP-safe)", () => {
  test("respects precedence and parentheses", () => {
    expect(run("calculator", { expression: "2 + 3 * 4" }).parsed.result).toBe(14);
    expect(run("calculator", { expression: "(2 + 3) * 4" }).parsed.result).toBe(20);
    expect(run("calculator", { expression: "10 / 4" }).parsed.result).toBe(2.5);
    expect(run("calculator", { expression: "-5 + 2" }).parsed.result).toBe(-3);
    expect(run("calculator", { expression: "10 % 3" }).parsed.result).toBe(1);
  });

  test("rejects malformed / non-arithmetic input without throwing", () => {
    const bad = run("calculator", { expression: "alert('x')" });
    expect(bad.isError).toBe(true);
    expect(bad.parsed).toHaveProperty("error");
    expect(run("calculator", { expression: "2 +" }).isError).toBe(true);
    expect(run("calculator", { expression: "" }).isError).toBe(true);
  });

  test("does not use eval/Function (source contains neither)", async () => {
    const src = await Bun.file(
      new URL("./web-tools.ts", import.meta.url),
    ).text();
    expect(src.includes("eval(")).toBe(false);
    // Function-as-constructor would be the eval escape hatch the CSP forbids.
    expect(/\bnew Function\b|\bFunction\s*\(/.test(src)).toBe(false);
  });
});

describe("random_number", () => {
  test("stays within the inclusive range", () => {
    for (let i = 0; i < 50; i += 1) {
      const v = run("random_number", { min: 1, max: 6 }).parsed.result as number;
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
  test("errors when min > max", () => {
    expect(run("random_number", { min: 9, max: 1 }).isError).toBe(true);
  });
});

describe("current_datetime", () => {
  test("returns an ISO timestamp + timezone", () => {
    const r = run("current_datetime", {});
    expect(typeof r.parsed.iso).toBe("string");
    expect(() => new Date(r.parsed.iso as string)).not.toThrow();
    expect(typeof r.parsed.timezone).toBe("string");
  });
});

describe("executeWebToolCall", () => {
  test("unknown tool returns an isError result, never throws", () => {
    const r = executeWebToolCall({ id: "x", name: "nope", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.toolCallId).toBe("x");
    expect(JSON.parse(r.content)).toHaveProperty("error");
  });
});
