import { describe, expect, test } from "bun:test";
import { parseAgentEventLine } from "./agents";

describe("parseAgentEventLine", () => {
  test("parses a data line into an AgentEvent", () => {
    const e = parseAgentEventLine(
      'data: {"seq":0,"ts":1,"type":"started","root":"/x"}',
    );
    expect(e?.type).toBe("started");
    expect(e?.root).toBe("/x");
  });

  test("ignores [DONE], comments, blanks, and malformed JSON", () => {
    expect(parseAgentEventLine("data: [DONE]")).toBeNull();
    expect(parseAgentEventLine(": keepalive")).toBeNull();
    expect(parseAgentEventLine("")).toBeNull();
    expect(parseAgentEventLine("data: {not json")).toBeNull();
    expect(parseAgentEventLine('data: {"no":"type"}')).toBeNull();
  });
});
