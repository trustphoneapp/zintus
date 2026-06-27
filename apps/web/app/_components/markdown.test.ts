import { describe, expect, test } from "bun:test";
import { parseBlocks } from "./Markdown";

describe("markdown parseBlocks (web)", () => {
  test("does NOT strip fenced code blocks — the bug this replaces", () => {
    // The old renderLine() returned null for any ``` line, deleting the whole
    // code block. The real parser must keep it as a {kind:"code"} block.
    const blocks = parseBlocks("before\n```ts\nconst x = 1;\n```\nafter");
    const code = blocks.find((b) => b.kind === "code");
    expect(code).toMatchObject({ kind: "code", lang: "ts", text: "const x = 1;" });
    // surrounding prose is preserved, not swallowed
    expect(blocks.filter((b) => b.kind === "p").length).toBe(2);
  });

  test("parses headings, lists, and tables", () => {
    const blocks = parseBlocks(
      "# Title\n\n- a\n- b\n\n| h1 | h2 |\n| --- | --- |\n| 1 | 2 |",
    );
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1, text: "Title" });
    expect(blocks.find((b) => b.kind === "ul")).toMatchObject({
      kind: "ul",
      items: ["a", "b"],
    });
    expect(blocks.find((b) => b.kind === "table")).toMatchObject({
      kind: "table",
      header: ["h1", "h2"],
      rows: [["1", "2"]],
    });
  });

  test("plain prose with no markdown is a single paragraph", () => {
    const blocks = parseBlocks("just a normal sentence with no markup");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "p" });
  });
});
