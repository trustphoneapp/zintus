import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256 } from "./hash.js";

describe("canonical hashing", () => {
  test("object key order cannot change an artifact hash", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      canonicalJson({ a: { b: 3, y: 2 }, z: 1 }),
    );
    expect(sha256({ z: 1, a: 2 })).toBe(sha256({ a: 2, z: 1 }));
    expect(sha256({ a: 2, z: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("non-JSON and ambiguous values fail closed", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow("undefined");
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("non-finite");
    expect(() => canonicalJson(Symbol("not-json"))).toThrow("non-JSON");
  });
});
