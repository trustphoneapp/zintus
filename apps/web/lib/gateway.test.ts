import { describe, expect, test } from "bun:test";
import {
  type ToolCallAccumulator,
  accumulateToolCallDeltas,
  finalizeToolCalls,
} from "./gateway.js";

// The web client reassembles streamed tool calls the same fragile way the
// provider side does: the gateway emits each call's `name` once and its
// `arguments` as a (possibly fragmented) JSON string, keyed by `index`. These
// tests exercise the pure fold + finalize helpers that `streamGatewayChat` uses
// internally, so the user-facing reassembly is covered without mocking `fetch`.

describe("accumulateToolCallDeltas + finalizeToolCalls — web SSE reassembly", () => {
  test("accumulates a single call whose arguments arrive in fragments", () => {
    const acc: ToolCallAccumulator = new Map();
    // name + id arrive on the first frame; arguments span three frames.
    accumulateToolCallDeltas(acc, [
      { index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"ci' } },
    ]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: 'ty":"Par' } }]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: 'is"}' } }]);

    const calls = finalizeToolCalls(acc);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "get_weather",
      arguments: { city: "Paris" },
    });
  });

  test("keeps two parallel calls separate by index, ordered deterministically", () => {
    const acc: ToolCallAccumulator = new Map();
    // Interleaved fragments for index 1 then index 0 (out of order on the wire).
    accumulateToolCallDeltas(acc, [
      { index: 1, id: "b", function: { name: "f_b", arguments: '{"y":2}' } },
      { index: 0, id: "a", function: { name: "f_a", arguments: '{"x":' } },
    ]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: "1}" } }]);

    const calls = finalizeToolCalls(acc);
    expect(calls.map((c) => c.name)).toEqual(["f_a", "f_b"]); // sorted by index
    expect(calls[0]?.arguments).toEqual({ x: 1 });
    expect(calls[1]?.arguments).toEqual({ y: 2 });
  });

  test("malformed argument JSON degrades to {} instead of throwing", () => {
    const acc: ToolCallAccumulator = new Map();
    accumulateToolCallDeltas(acc, [
      { index: 0, id: "c", function: { name: "broken", arguments: "{not json" } },
    ]);
    const calls = finalizeToolCalls(acc);
    expect(calls[0]?.arguments).toEqual({});
    expect(calls[0]?.name).toBe("broken");
  });

  test("defaults a missing index to 0 and synthesizes an id when absent", () => {
    const acc: ToolCallAccumulator = new Map();
    accumulateToolCallDeltas(acc, [{ function: { name: "noid", arguments: "{}" } }]);
    const calls = finalizeToolCalls(acc);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe("call_noid_0");
    expect(calls[0]?.arguments).toEqual({});
  });

  test("empty accumulator yields no tool calls", () => {
    expect(finalizeToolCalls(new Map())).toEqual([]);
  });
});
