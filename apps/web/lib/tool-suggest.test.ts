import { describe, expect, test } from "bun:test";
import { suggestTool, type ToolSuggestKind, type ToolSuggestState } from "./tool-suggest";

function state(overrides: Partial<ToolSuggestState> = {}): ToolSuggestState {
  return {
    searchOn: false,
    researchOn: false,
    jsonMode: "off",
    dismissed: new Set<ToolSuggestKind>(),
    ...overrides,
  };
}

describe("suggestTool — search heuristic", () => {
  test.each([
    "What's the latest news on AI regulation?",
    "Who won the game last night?",
    "What's the stock price of Tesla right now?",
    "What happened in the market in 2027?",
  ])("triggers on %p", (text) => {
    expect(suggestTool(text, state())?.kind).toBe("search");
  });

  test("suppressed when searchOn is already true", () => {
    expect(suggestTool("what's the latest news", state({ searchOn: true }))).toBeNull();
  });

  test("suppressed when the kind is dismissed", () => {
    expect(
      suggestTool(
        "what's the latest news",
        state({ dismissed: new Set<ToolSuggestKind>(["search"]) }),
      ),
    ).toBeNull();
  });

  test("exact copy strings", () => {
    const s = suggestTool("what's the latest news today", state());
    expect(s).toEqual({
      kind: "search",
      label: "Looks like this needs current info",
      costHint: "+~2K tok",
    });
  });
});

describe("suggestTool — json heuristic", () => {
  test.each([
    "Give me the response as JSON please",
    "What's the schema for this object?",
    "I need structured output for this",
  ])("triggers on %p", (text) => {
    expect(suggestTool(text, state())?.kind).toBe("json");
  });

  test("suppressed when jsonMode is not off", () => {
    expect(
      suggestTool("respond in json please", state({ jsonMode: "json_object" })),
    ).toBeNull();
    expect(
      suggestTool("respond in json please", state({ jsonMode: "json_schema" })),
    ).toBeNull();
  });

  test("suppressed when the kind is dismissed", () => {
    expect(
      suggestTool(
        "respond in json please",
        state({ dismissed: new Set<ToolSuggestKind>(["json"]) }),
      ),
    ).toBeNull();
  });

  test("exact copy strings", () => {
    const s = suggestTool("respond in json please", state());
    expect(s).toEqual({
      kind: "json",
      label: "Want structured JSON output?",
      costHint: "no extra cost",
    });
  });
});

describe("suggestTool — research heuristic", () => {
  test.each([
    "Can you do a deep dive into the history and evolution of quantum computing over the last five decades?",
    "I need you to research this thoroughly and give me a comprehensive report on renewable energy trends worldwide",
    "Please write a report comparing the pros and cons of various programming languages used in enterprise systems",
    "Could you compare these cloud providers options in detail, covering pricing, reliability, and support quality across the board?",
  ])("triggers on %p", (text) => {
    expect(suggestTool(text, state())?.kind).toBe("research");
  });

  test("suppressed when researchOn is already true", () => {
    const text =
      "Can you do a deep dive into the history and evolution of quantum computing over the last five decades?";
    expect(suggestTool(text, state({ researchOn: true }))).toBeNull();
  });

  test("suppressed when the kind is dismissed", () => {
    const text =
      "Can you do a deep dive into the history and evolution of quantum computing over the last five decades?";
    expect(
      suggestTool(text, state({ dismissed: new Set<ToolSuggestKind>(["research"]) })),
    ).toBeNull();
  });

  test("length gate: matches the phrase but is <= 80 chars", () => {
    expect(suggestTool("Give me a deep dive", state())).toBeNull();
    expect("Give me a deep dive".length).toBeLessThanOrEqual(80);
  });

  test("exact copy strings", () => {
    const text =
      "I need you to research this thoroughly and give me a comprehensive report on renewable energy trends worldwide";
    const s = suggestTool(text, state());
    expect(s).toEqual({
      kind: "research",
      label: "This could use deep research",
      costHint: "multi-step · higher token use",
    });
  });
});

describe("suggestTool — non-triggers and edge cases", () => {
  test("plain text with no intent signal", () => {
    expect(suggestTool("tell me a joke", state())).toBeNull();
  });

  test("empty / whitespace-only text", () => {
    expect(suggestTool("", state())).toBeNull();
    expect(suggestTool("   ", state())).toBeNull();
  });
});

describe("suggestTool — priority order", () => {
  test("search wins over json when both match", () => {
    const s = suggestTool("What's the latest news — give me JSON output for it", state());
    expect(s?.kind).toBe("search");
  });

  test("json wins over research when both match", () => {
    const text =
      "Give me the schema as JSON — this could use a deep dive into the topic thoroughly researched and detailed";
    const s = suggestTool(text, state());
    expect(s?.kind).toBe("json");
  });

  test("research is reachable when search and json are suppressed", () => {
    const text =
      "I need you to research this thoroughly and give me a comprehensive report on renewable energy trends worldwide";
    const s = suggestTool(
      text,
      state({
        searchOn: true,
        jsonMode: "json_object",
      }),
    );
    expect(s?.kind).toBe("research");
  });
});
