import { describe, expect, test } from "bun:test";
import { compressTerminalOutput } from "./terminal-compress.js";

function buildLog(total: number): {
  raw: string;
  errorIndex: number;
  fileLineIndex: number;
} {
  const lines: string[] = [];
  const errorIndex = 400;
  const fileLineIndex = 500;
  for (let i = 0; i < total; i++) {
    if (i === errorIndex) {
      lines.push("FATAL ERROR: something exploded in the build pipeline");
    } else if (i === fileLineIndex) {
      lines.push("    at compileModule (src/compiler/index.ts:128:14)");
    } else {
      lines.push(`info: routine progress line number ${i}`);
    }
  }
  return { raw: lines.join("\n"), errorIndex, fileLineIndex };
}

describe("compressTerminalOutput", () => {
  test("900-line log collapses to <= maxLines", () => {
    const { raw } = buildLog(900);
    const result = compressTerminalOutput(raw);
    const outLines = result.text.split("\n");
    expect(result.originalLines).toBe(900);
    expect(outLines.length).toBeLessThanOrEqual(80);
  });

  test("respects a custom maxLines budget", () => {
    const { raw } = buildLog(900);
    const result = compressTerminalOutput(raw, { maxLines: 40 });
    const outLines = result.text.split("\n");
    expect(outLines.length).toBeLessThanOrEqual(40);
  });

  test("error line and file:line reference survive compression", () => {
    const { raw } = buildLog(900);
    const result = compressTerminalOutput(raw);
    expect(result.text).toContain("FATAL ERROR: something exploded in the build pipeline");
    expect(result.text).toContain("src/compiler/index.ts:128:14");
  });

  test("head and tail are preserved", () => {
    const { raw } = buildLog(900);
    const result = compressTerminalOutput(raw, {
      keepHeadLines: 5,
      keepTailLines: 15,
    });
    const outLines = result.text.split("\n");
    // First 5 head lines.
    for (let i = 0; i < 5; i++) {
      expect(outLines[i]).toBe(`info: routine progress line number ${i}`);
    }
    // Last 15 tail lines.
    for (let i = 0; i < 15; i++) {
      const original = `info: routine progress line number ${900 - 15 + i}`;
      expect(result.text).toContain(original);
    }
  });

  test("emits an elision marker for collapsed runs", () => {
    const { raw } = buildLog(900);
    const result = compressTerminalOutput(raw);
    expect(result.text).toMatch(/… \d+ lines elided …/);
  });

  test("short input is returned unchanged with kept == original", () => {
    const raw = ["line one", "line two", "line three"].join("\n");
    const result = compressTerminalOutput(raw, { maxLines: 80 });
    expect(result.text).toBe(raw);
    expect(result.originalLines).toBe(3);
    expect(result.keptLines).toBe(3);
  });

  test("input exactly at maxLines is unchanged", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `row ${i}`);
    const raw = lines.join("\n");
    const result = compressTerminalOutput(raw, { maxLines: 80 });
    expect(result.text).toBe(raw);
    expect(result.keptLines).toBe(80);
  });

  test("does not truncate individual kept lines", () => {
    const longLine = "x".repeat(5000);
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(i === 100 ? `ERROR ${longLine}` : `noise ${i}`);
    }
    const result = compressTerminalOutput(lines.join("\n"));
    expect(result.text).toContain(`ERROR ${longLine}`);
  });

  test("is deterministic across repeated calls", () => {
    const { raw } = buildLog(900);
    const a = compressTerminalOutput(raw);
    const b = compressTerminalOutput(raw);
    expect(a.text).toBe(b.text);
    expect(a.keptLines).toBe(b.keptLines);
  });

  test("keeps many error lines but still respects maxLines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push(`error: failure number ${i}`);
    }
    const result = compressTerminalOutput(lines.join("\n"), { maxLines: 50 });
    const outLines = result.text.split("\n");
    expect(outLines.length).toBeLessThanOrEqual(50);
    // Head must still be intact even though everything is "important".
    expect(outLines[0]).toBe("error: failure number 0");
  });
});
