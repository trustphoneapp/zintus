import { describe, expect, it } from "bun:test";
import {
  CLASS_ECONOMICS,
  RATE_TIERS,
  isModelClass,
  modelPlanEconomics,
  planCostLabel,
  planPer1k,
} from "./economics";

// These exact numbers ARE the contract with workers/relay/src/tiers.ts
// (CLASS_BURN × TIERS). If tiers.ts changes and this table isn't updated in
// lockstep, this suite fails — which is the whole point of the mirror.
const tier = (id: string) => RATE_TIERS.find((t) => t.id === id)!;

describe("planPer1k — mirrors tiers.ts planTokensPer1kByTier exactly", () => {
  it("cheap (burn 1) per tier", () => {
    expect(planPer1k(1, tier("starter"))).toBe(67);
    expect(planPer1k(1, tier("pro"))).toBe(286);
    expect(planPer1k(1, tier("max"))).toBe(833);
    expect(planPer1k(1, tier("ultra"))).toBe(1667);
  });
  it("mid (burn 2) per tier", () => {
    expect(planPer1k(2, tier("starter"))).toBe(133);
    expect(planPer1k(2, tier("pro"))).toBe(571);
    expect(planPer1k(2, tier("max"))).toBe(1667);
    expect(planPer1k(2, tier("ultra"))).toBe(3333);
  });
  it("premium (burn 5) per tier", () => {
    expect(planPer1k(5, tier("pro"))).toBe(1429);
    expect(planPer1k(5, tier("max"))).toBe(4167);
    expect(planPer1k(5, tier("ultra"))).toBe(8333);
  });
  it("frontier (burn 15) per tier", () => {
    expect(planPer1k(15, tier("max"))).toBe(12_500);
    expect(planPer1k(15, tier("ultra"))).toBe(25_000);
  });
  it("ultra (burn 46) on ultra", () => {
    expect(planPer1k(46, tier("ultra"))).toBe(76_667);
  });
});

describe("CLASS_ECONOMICS — burn + min-tier gates mirror tiers.ts", () => {
  it("burn rates equal CLASS_BURN", () => {
    expect(CLASS_ECONOMICS.free.burn).toBe(0);
    expect(CLASS_ECONOMICS.cheap.burn).toBe(1);
    expect(CLASS_ECONOMICS.mid.burn).toBe(2);
    expect(CLASS_ECONOMICS.premium.burn).toBe(5);
    expect(CLASS_ECONOMICS.frontier.burn).toBe(15);
    expect(CLASS_ECONOMICS.ultra.burn).toBe(46);
  });
  it("min tiers equal minTierForClass", () => {
    expect(CLASS_ECONOMICS.free.minTier).toBe("free");
    expect(CLASS_ECONOMICS.cheap.minTier).toBe("starter");
    expect(CLASS_ECONOMICS.mid.minTier).toBe("starter");
    expect(CLASS_ECONOMICS.premium.minTier).toBe("pro");
    expect(CLASS_ECONOMICS.frontier.minTier).toBe("max");
    expect(CLASS_ECONOMICS.ultra.minTier).toBe("ultra");
  });
});

describe("isModelClass", () => {
  it("accepts real classes, rejects anything else", () => {
    expect(isModelClass("premium")).toBe(true);
    expect(isModelClass("free")).toBe(true);
    expect(isModelClass("banana")).toBe(false);
    expect(isModelClass("")).toBe(false);
  });
});

describe("modelPlanEconomics — per-model debit for the member's tier", () => {
  it("cheap is reachable and cheap on Starter", () => {
    expect(modelPlanEconomics("cheap", "starter")).toEqual({
      debitPer1k: 67,
      locked: false,
    });
  });
  it("premium is LOCKED on Starter, unlocked on Pro", () => {
    expect(modelPlanEconomics("premium", "starter")).toEqual({
      debitPer1k: 333,
      locked: true,
    });
    expect(modelPlanEconomics("premium", "pro")).toEqual({
      debitPer1k: 1429,
      locked: false,
    });
  });
  it("frontier is LOCKED below Max", () => {
    expect(modelPlanEconomics("frontier", "pro")!.locked).toBe(true);
    expect(modelPlanEconomics("frontier", "max")).toEqual({
      debitPer1k: 12_500,
      locked: false,
    });
  });
  it("free (gift) class debits 0 and is never locked", () => {
    expect(modelPlanEconomics("free", "starter")).toEqual({
      debitPer1k: 0,
      locked: false,
    });
  });
  it("returns null for an unpriceable class (honest blank, no guess)", () => {
    expect(modelPlanEconomics("mystery", "pro")).toBeNull();
  });
});

describe("planCostLabel — mirrors the pricing page's cell grammar", () => {
  it("locked → Upgrade", () => {
    expect(planCostLabel({ debitPer1k: 333, locked: true })).toBe("Upgrade");
  });
  it("zero debit → Free", () => {
    expect(planCostLabel({ debitPer1k: 0, locked: false })).toBe("Free");
  });
  it("priced → −N / 1K with thousands separators", () => {
    expect(planCostLabel({ debitPer1k: 1429, locked: false })).toBe(
      "−1,429 / 1K",
    );
    expect(planCostLabel({ debitPer1k: 12_500, locked: false })).toBe(
      "−12,500 / 1K",
    );
  });
});
