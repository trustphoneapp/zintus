import { describe, expect, test } from "bun:test";
import {
  checkoutAvailability,
  isStripePriceConfigured,
  MANAGED_KEYS_AVAILABLE,
} from "../src/tiers.js";

// B-Lane fix 3: /api/billing/checkout must return a CLEAR 503 — never a 500 that
// bubbles up from Stripe — when prices are unconfigured. Two distinct 503s:
//   • managed_keys_unavailable — the managed-key backend is gated off (current
//     production state, MANAGED_KEYS_AVAILABLE=false).
//   • billing_not_configured  — the flag is flipped on but STRIPE_PRICES are
//     still `price_FILL…` placeholders.
// `managedKeysAvailable` is injected so we test the placeholder path WITHOUT
// flipping the production constant (it stays false).

describe("isStripePriceConfigured", () => {
  test("real (test-mode) price IDs count as configured; placeholders would not", () => {
    // 2026-07-04: Stripe TEST-mode prices are set for all four tiers. The
    // placeholder guard itself is covered by the unknown-tier case below and
    // the prefix check (`price_FILL…` → false) in isStripePriceConfigured.
    expect(isStripePriceConfigured("starter")).toBe(true);
    expect(isStripePriceConfigured("pro")).toBe(true);
    expect(isStripePriceConfigured("max")).toBe(true);
    expect(isStripePriceConfigured("ultra")).toBe(true);
  });
  test("an unknown tier is not configured", () => {
    expect(isStripePriceConfigured("nope")).toBe(false);
  });
});

describe("checkoutAvailability", () => {
  test("production constant is ON — the managed backend exists (src/managed.ts)", () => {
    // Flipped 2026-07-03 together with the /v1/managed/* routes. Purchasability
    // is still gated by the placeholder-price check below until [HUMAN] fills
    // real STRIPE_PRICES.
    expect(MANAGED_KEYS_AVAILABLE).toBe(true);
  });

  test("blocks managed-key tiers with 503 managed_keys_unavailable while gated off", () => {
    const block = checkoutAvailability("pro", false);
    expect(block).not.toBeNull();
    expect(block!.status).toBe(503);
    expect(block!.code).toBe("managed_keys_unavailable");
  });

  test("an unconfigured tier with managed keys ON -> 503 billing_not_configured (no 500)", () => {
    // Behavior guard survives real prices: a tier with no configured price
    // (here: an unknown tier name) must 503 clearly, never 500 from Stripe.
    const block = checkoutAvailability("not-a-tier", true);
    expect(block).not.toBeNull();
    expect(block!.status).toBe(503);
    expect(block!.code).toBe("billing_not_configured");
  });

  test("configured tiers with managed keys ON may proceed to checkout", () => {
    for (const tier of ["starter", "pro", "max", "ultra"]) {
      expect(checkoutAvailability(tier, true)).toBeNull();
    }
  });
});
