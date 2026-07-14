import { describe, expect, test } from "bun:test";
import { pickAutoManagedModel, canAutoManagedFallback } from "./managed-auto";
import type { BillingStatus, ManagedModelDto } from "./billing";

function billing(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    tier: "pro",
    status: "active",
    tokens_used: 0,
    tokens_limit: null,
    period_end: null,
    referral_code: "",
    ...overrides,
  };
}

function model(overrides: Partial<ManagedModelDto> = {}): ManagedModelDto {
  return {
    id: "m",
    display_name: "M",
    context_window: 128_000,
    class: "cheap",
    plan_tokens_per_1k: {},
    min_tier: "starter",
    capabilities: { tools: true, json: true, vision: false },
    ...overrides,
  };
}

describe("pickAutoManagedModel", () => {
  test("class preference: mid beats cheap/premium/free even at a higher debit", () => {
    // On pro: mid debits 571/1K, cheap 286, premium 2857 — Auto still prefers the
    // balanced "mid" class over the cheaper "cheap", so the choice is class-driven,
    // not debit-driven.
    const id = pickAutoManagedModel(
      [
        model({ id: "cheap-m", class: "cheap" }),
        model({ id: "mid-m", class: "mid" }),
        model({ id: "premium-m", class: "premium" }),
        model({ id: "free-m", class: "free" }),
      ],
      "pro",
    );
    expect(id).toBe("mid-m");
  });

  test("class preference cascades: cheap when no mid, premium when neither, free last", () => {
    expect(
      pickAutoManagedModel(
        [model({ id: "cheap-m", class: "cheap" }), model({ id: "premium-m", class: "premium" })],
        "pro",
      ),
    ).toBe("cheap-m");
    expect(
      pickAutoManagedModel(
        [model({ id: "premium-m", class: "premium" }), model({ id: "free-m", class: "free" })],
        "pro",
      ),
    ).toBe("premium-m");
  });

  test("frontier/ultra (unlisted real classes) sort last, behind free", () => {
    // Reachable only on max/ultra; on ultra they're candidates but rank below free.
    const id = pickAutoManagedModel(
      [
        model({ id: "frontier-m", class: "frontier" }),
        model({ id: "free-m", class: "free" }),
      ],
      "ultra",
    );
    expect(id).toBe("free-m");
  });

  test("within the winning class debits tie → deterministic lowest-id wins", () => {
    // Same-class models share a debit, so the id tie-break decides — deterministic
    // regardless of catalog order.
    const id = pickAutoManagedModel(
      [
        model({ id: "mid-z", class: "mid" }),
        model({ id: "mid-a", class: "mid" }),
        model({ id: "mid-m", class: "mid" }),
      ],
      "pro",
    );
    expect(id).toBe("mid-a");
  });

  test("locked models (above the member's tier) are excluded", () => {
    // On starter: premium needs pro+ → locked; only the reachable cheap qualifies.
    const id = pickAutoManagedModel(
      [
        model({ id: "premium-m", class: "premium" }), // locked below pro
        model({ id: "cheap-m", class: "cheap" }),
      ],
      "starter",
    );
    expect(id).toBe("cheap-m");
  });

  test("unpriceable class (no honest economics) is excluded", () => {
    const id = pickAutoManagedModel(
      [
        model({ id: "weird-m", class: "banana" }), // unpriceable → not a candidate
        model({ id: "cheap-m", class: "cheap" }),
      ],
      "pro",
    );
    expect(id).toBe("cheap-m");
  });

  test("empty catalog → null (no fallback, keep existing behavior)", () => {
    expect(pickAutoManagedModel([], "pro")).toBeNull();
  });

  test("everything locked → null", () => {
    // starter can reach neither frontier (max+) nor ultra.
    const id = pickAutoManagedModel(
      [
        model({ id: "frontier-m", class: "frontier" }),
        model({ id: "ultra-m", class: "ultra" }),
      ],
      "starter",
    );
    expect(id).toBeNull();
  });

  test("only unpriceable classes → null", () => {
    expect(
      pickAutoManagedModel([model({ id: "weird-m", class: "banana" })], "pro"),
    ).toBeNull();
  });
});

describe("canAutoManagedFallback", () => {
  const base = {
    routingOnWeb: true,
    billing: billing(),
    selectedProvider: null,
    managedModel: null,
  };

  test("member on genuine Auto (no pins) → true", () => {
    expect(canAutoManagedFallback(base)).toBe(true);
  });

  test("a pinned provider → false", () => {
    expect(canAutoManagedFallback({ ...base, selectedProvider: "groq" })).toBe(false);
  });

  test("a pinned managed model → false", () => {
    expect(canAutoManagedFallback({ ...base, managedModel: "gpt-x" })).toBe(false);
  });

  test("non-member (free tier) → false", () => {
    expect(
      canAutoManagedFallback({ ...base, billing: billing({ tier: "free" }) }),
    ).toBe(false);
  });

  test("cancelled member → false", () => {
    expect(
      canAutoManagedFallback({ ...base, billing: billing({ status: "cancelled" }) }),
    ).toBe(false);
  });

  test("signed out (null billing) → false", () => {
    expect(canAutoManagedFallback({ ...base, billing: null })).toBe(false);
  });

  test("routing seam off → false", () => {
    expect(canAutoManagedFallback({ ...base, routingOnWeb: false })).toBe(false);
  });
});
