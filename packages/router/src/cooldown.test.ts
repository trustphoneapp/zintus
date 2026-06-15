import { describe, expect, it } from "vitest";
import { computeCooldownMs, isInCooldown } from "./cooldown.js";

describe("cooldown", () => {
  it("isInCooldown returns true when until is in the future", () => {
    expect(isInCooldown(Date.now() + 5_000, Date.now())).toBe(true);
  });

  it("isInCooldown returns false when until is null or past", () => {
    expect(isInCooldown(null, Date.now())).toBe(false);
    expect(isInCooldown(Date.now() - 1, Date.now())).toBe(false);
  });

  it("computeCooldownMs uses 30s base with exponential backoff capped at 30min", () => {
    expect(computeCooldownMs(0)).toBe(30_000);
    expect(computeCooldownMs(1)).toBe(60_000);
    expect(computeCooldownMs(2)).toBe(120_000);
    expect(computeCooldownMs(10)).toBe(1_800_000);
  });
});
