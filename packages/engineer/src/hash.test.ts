import { describe, expect, test } from "bun:test";
import { canonicalJson, matchesSha256Bytes, providerPromptCacheKey, sha256, sha256Bytes } from "./hash.js";

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

  test("provider prompt cache keys preserve the digest within the 64-character API limit", () => {
    const canonical = sha256({ stable: "prompt" });
    expect(providerPromptCacheKey(canonical)).toBe(canonical.slice("sha256:".length));
    expect(providerPromptCacheKey(canonical)).toHaveLength(64);
    expect(() => providerPromptCacheKey("not-a-hash")).toThrow("canonical SHA-256 hash");
  });

  test("content hashes use conventional SHA-256 over exact bytes with legacy read compatibility", () => {
    const bytes = Buffer.from("abc");
    expect(sha256Bytes(bytes)).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(matchesSha256Bytes(bytes, sha256Bytes(bytes))).toBe(true);
    expect(matchesSha256Bytes(bytes, sha256(bytes))).toBe(true);
    expect(matchesSha256Bytes(Buffer.from("changed"), sha256Bytes(bytes))).toBe(false);
  });
});
