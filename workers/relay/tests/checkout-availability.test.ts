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
  test("placeholder price IDs count as NOT configured", () => {
    // Shipping default: all three are `price_FILL_FROM_STRIPE`.
    expect(isStripePriceConfigured("starter")).toBe(false);
    expect(isStripePriceConfigured("growth")).toBe(false);
    expect(isStripePriceConfigured("scale")).toBe(false);
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
    const block = checkoutAvailability("growth", false);
    expect(block).not.toBeNull();
    expect(block!.status).toBe(503);
    expect(block!.code).toBe("managed_keys_unavailable");
  });

  test("with managed keys ON but placeholder prices -> 503 billing_not_configured (no 500)", () => {
    const block = checkoutAvailability("growth", true);
    expect(block).not.toBeNull();
    expect(block!.status).toBe(503);
    expect(block!.code).toBe("billing_not_configured");
  });
});
