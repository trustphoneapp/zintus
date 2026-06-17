import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPolicy, normalizePolicy } from "./policy.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("normalizePolicy", () => {
  test("returns empty policy for garbage input", () => {
    expect(normalizePolicy(null)).toEqual({});
    expect(normalizePolicy(42)).toEqual({});
    expect(normalizePolicy("nope")).toEqual({});
  });

  test("keeps known fields and drops invalid fallback actions", () => {
    const policy = normalizePolicy({
      providerPriority: ["groq", "gemini"],
      modelGroups: { "llama-3.3-70b": ["groq", "openrouter"] },
      fallbacks: { on_429: "next_provider", on_5xx: "explode" },
      limits: { groq: { requestsPerDay: 500 } },
    });
    expect(policy.providerPriority).toEqual(["groq", "gemini"]);
    expect(policy.modelGroups).toEqual({
      "llama-3.3-70b": ["groq", "openrouter"],
    });
    expect(policy.fallbacks?.on_429).toBe("next_provider");
    // "explode" is invalid and must be dropped.
    expect(policy.fallbacks?.on_5xx).toBeUndefined();
    expect(policy.limits?.groq?.requestsPerDay).toBe(500);
  });
});

describe("loadPolicy", () => {
  test("loads and parses a file via explicit path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mai-policy-"));
    dirs.push(dir);
    const path = join(dir, "policy.json");
    writeFileSync(
      path,
      JSON.stringify({ modelGroups: { x: ["groq"] } }),
      "utf8",
    );
    expect(loadPolicy(path).modelGroups).toEqual({ x: ["groq"] });
  });

  test("returns empty policy for a malformed file (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mai-policy-"));
    dirs.push(dir);
    const path = join(dir, "policy.json");
    writeFileSync(path, "{ not valid json", "utf8");
    expect(loadPolicy(path)).toEqual({});
  });
});
