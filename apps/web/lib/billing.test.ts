import { describe, expect, it } from "bun:test";
import { REFERRAL_PAYOUTS_LIVE, formatReferralEarned } from "./billing";

describe("formatReferralEarned", () => {
  it("hides any earned figure while payouts are gated (honest 'Coming soon')", () => {
    // The whole point of the audit fix: a non-zero accrual must NOT render as a
    // withdrawable dollar amount while there is no payout path.
    expect(formatReferralEarned(0, false)).toBe("Coming soon");
    expect(formatReferralEarned(4200, false)).toBe("Coming soon");
    expect(formatReferralEarned(999_999, false)).toBe("Coming soon");
  });

  it("formats accrued cents as USD once payouts are live", () => {
    expect(formatReferralEarned(0, true)).toBe("$0.00");
    expect(formatReferralEarned(4200, true)).toBe("$42.00");
    expect(formatReferralEarned(150, true)).toBe("$1.50");
  });

  it("defaults to the shipped gate (payouts not live => never a $ figure)", () => {
    // Guards against the flag silently flipping to true in a release.
    expect(REFERRAL_PAYOUTS_LIVE).toBe(false);
    expect(formatReferralEarned(4200)).toBe("Coming soon");
  });
});
