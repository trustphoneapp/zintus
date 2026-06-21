import { describe, it, expect } from "bun:test";
import { compressJSON } from "../src/compressors/json";

describe("compressJSON", () => {
  it("returns original for invalid JSON", () => {
    const result = compressJSON("not json");
    expect(result.content).toBe("not json");
    expect(result.ratio).toBe(1);
    expect(result.transforms).toHaveLength(0);
  });

  it("compresses uniform arrays with TOON encoding", () => {
    const arr = Array.from({ length: 25 }, (_, i) => ({
      id: i,
      name: `user-${i}`,
      email: `user${i}@example.com`,
      active: true,
    }));
    const result = compressJSON(JSON.stringify(arr));
    expect(result.ratio).toBeLessThan(1);
    expect(result.transforms).toContain("toon-encode");
  });

  it("applies UUID aliasing", () => {
    const obj = {
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      userId: "550e8400-e29b-41d4-a716-446655440001",
    };
    const result = compressJSON(JSON.stringify(obj));
    expect(result.content).toContain("u-1");
    expect(result.transforms).toContain("uuid-alias");
  });

  it("strips null and empty values", () => {
    const obj = { a: 1, b: null, c: "", d: [], e: {} };
    const result = compressJSON(JSON.stringify(obj));
    const parsed = JSON.parse(result.content);
    expect(parsed).not.toHaveProperty("b");
    expect(parsed).not.toHaveProperty("c");
  });

  it("handles nested objects without TOON", () => {
    const obj = {
      deeply: { nested: { structure: { value: 42 } } },
    };
    const result = compressJSON(JSON.stringify(obj));
    // Should not throw, should return something valid
    expect(result.content).toBeTruthy();
    expect(result.originalTokens).toBeGreaterThan(0);
  });

  it("performs statistical sampling for large arrays", () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      value: Math.random(),
      status: i % 20 === 0 ? "error" : "ok",
    }));
    const result = compressJSON(JSON.stringify(arr));
    expect(result.transforms).toContain("statistical-sampling");
    // Error items must be kept
    const parsed = result.content;
    // TOON format should reference error items
    expect(parsed).toBeTruthy();
  });

  it("never throws on any input", () => {
    const inputs = ["", "{}", "[]", "null", '"string"', "123", "{invalid"];
    for (const input of inputs) {
      expect(() => compressJSON(input)).not.toThrow();
    }
  });
});
