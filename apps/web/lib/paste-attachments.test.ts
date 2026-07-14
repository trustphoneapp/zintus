import { describe, test, expect } from "bun:test";
import {
  shouldChipPaste,
  nextPastedTextName,
  formatCharCount,
  PASTE_CHAR_THRESHOLD,
  PASTE_LINE_THRESHOLD,
} from "./paste-attachments";

describe("shouldChipPaste — long-paste threshold", () => {
  test("short, few-line paste stays inline", () => {
    expect(shouldChipPaste("hello world")).toBe(false);
    expect(shouldChipPaste("a\nb\nc")).toBe(false);
  });

  test("exactly at the char threshold stays inline (strictly >)", () => {
    expect(shouldChipPaste("x".repeat(PASTE_CHAR_THRESHOLD))).toBe(false);
    expect(shouldChipPaste("x".repeat(PASTE_CHAR_THRESHOLD + 1))).toBe(true);
  });

  test("exactly at the line threshold stays inline (strictly >)", () => {
    const atThreshold = Array.from({ length: PASTE_LINE_THRESHOLD }, () => "x").join("\n");
    const overThreshold = Array.from({ length: PASTE_LINE_THRESHOLD + 1 }, () => "x").join("\n");
    expect(shouldChipPaste(atThreshold)).toBe(false);
    expect(shouldChipPaste(overThreshold)).toBe(true);
  });

  test("many short lines chip even though char count is low", () => {
    const text = Array.from({ length: 60 }, () => "x").join("\n");
    expect(text.length).toBeLessThan(PASTE_CHAR_THRESHOLD);
    expect(shouldChipPaste(text)).toBe(true);
  });

  test("one huge line chips even with a single line", () => {
    expect(shouldChipPaste("x".repeat(3000))).toBe(true);
  });
});

describe("nextPastedTextName — chip numbering", () => {
  test("first paste chip is unnumbered", () => {
    expect(nextPastedTextName([])).toBe("Pasted text");
    expect(nextPastedTextName(["notes.txt", "report.pdf"])).toBe("Pasted text");
  });

  test("counts existing 'Pasted text*' names, ignoring unrelated ones", () => {
    expect(nextPastedTextName(["Pasted text"])).toBe("Pasted text 2");
    expect(nextPastedTextName(["Pasted text", "Pasted text 2"])).toBe("Pasted text 3");
    expect(nextPastedTextName(["notes.txt", "Pasted text"])).toBe("Pasted text 2");
  });
});

describe("formatCharCount", () => {
  test("formats with thousands separators", () => {
    expect(formatCharCount(0)).toBe("0 chars");
    expect(formatCharCount(12439)).toBe("12,439 chars");
    expect(formatCharCount(500)).toBe("500 chars");
  });
});
