import { describe, expect, test } from "bun:test";
import { invoiceSubscriptionId } from "../src/billing.js";

// Stripe moved invoice.subscription to parent.subscription_details.subscription
// in API 2025-03+ ("basil"/"dahlia"). The webhook payload shape follows the
// ENDPOINT's pinned version — both shapes must resolve or invoice.paid /
// invoice.payment_failed silently no-op on newer-pinned endpoints.
describe("invoiceSubscriptionId across Stripe API versions", () => {
  test("legacy top-level subscription (≤2025-02)", () => {
    expect(invoiceSubscriptionId({ subscription: "sub_123" })).toBe("sub_123");
  });

  test("basil/dahlia nested parent.subscription_details (2025-03+)", () => {
    expect(
      invoiceSubscriptionId({
        parent: { subscription_details: { subscription: "sub_456" } },
      }),
    ).toBe("sub_456");
  });

  test("one-off invoice (no subscription anywhere) → null", () => {
    expect(invoiceSubscriptionId({})).toBeNull();
    expect(invoiceSubscriptionId({ parent: null })).toBeNull();
    expect(invoiceSubscriptionId({ parent: { subscription_details: {} } })).toBeNull();
    expect(invoiceSubscriptionId({ subscription: 42 })).toBeNull();
  });
});
