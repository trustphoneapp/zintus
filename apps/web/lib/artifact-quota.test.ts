import { describe, expect, test } from "bun:test";
import {
  newArtifactBudget,
  remainingUsd,
  decideSpend,
  applySpend,
  grantConsent,
  denyReasonText,
  NO_CONSENT,
  DEFAULT_ARTIFACT_CAP_USD,
} from "./artifact-quota";

describe("artifact budget", () => {
  test("a fresh budget has the cap as remaining, nothing spent", () => {
    const b = newArtifactBudget(0.5, 1000);
    expect(b.capUsd).toBe(0.5);
    expect(b.spentUsd).toBe(0);
    expect(remainingUsd(b)).toBe(0.5);
  });

  test("default cap + negative cap clamps to 0", () => {
    expect(newArtifactBudget().capUsd).toBe(DEFAULT_ARTIFACT_CAP_USD);
    expect(newArtifactBudget(-3).capUsd).toBe(0);
  });

  test("applySpend accumulates spend and counts a call", () => {
    let b = newArtifactBudget(0.5, 1000);
    b = applySpend(b, 0.1, 1000);
    b = applySpend(b, 0.05, 1500);
    expect(b.spentUsd).toBeCloseTo(0.15);
    expect(b.windowCalls).toBe(2);
    expect(remainingUsd(b)).toBeCloseTo(0.35);
  });

  test("applySpend rolls the rate window once it elapses", () => {
    let b = newArtifactBudget(0.5, 1000);
    b = applySpend(b, 0.01, 1000, 60_000); // call 1, window starts at 1000
    b = applySpend(b, 0.01, 70_000, 60_000); // > window ⇒ roll, count resets to 1
    expect(b.windowCalls).toBe(1);
    expect(b.windowStartedAt).toBe(70_000);
    expect(b.spentUsd).toBeCloseTo(0.02); // spend still accumulates across windows
  });
});

describe("decideSpend", () => {
  const consent = grantConsent();

  test("blocks a spend that would exceed the cap", () => {
    const b = newArtifactBudget(0.1, 0);
    const d = decideSpend({ ...b, spentUsd: 0.08 }, consent, 0.05, { now: 0 });
    expect(d).toEqual({ allow: false, reason: "over-cap" });
  });

  test("blocks when the rate limit is hit within the window", () => {
    const b = { ...newArtifactBudget(1, 0), windowCalls: 20, windowStartedAt: 0 };
    const d = decideSpend(b, consent, 0.001, { now: 1000, rateLimit: 20, rateWindowMs: 60_000 });
    expect(d).toEqual({ allow: false, reason: "rate-limited" });
  });

  test("an expired window resets the effective call count", () => {
    const b = { ...newArtifactBudget(1, 0), windowCalls: 20, windowStartedAt: 0 };
    const d = decideSpend(b, consent, 0.001, { now: 61_000, rateLimit: 20, rateWindowMs: 60_000 });
    expect(d.allow).toBe(true);
  });

  test("blocks an automated spend with no consent", () => {
    const b = newArtifactBudget(1, 0);
    expect(decideSpend(b, NO_CONSENT, 0.001, { now: 0 })).toEqual({
      allow: false,
      reason: "no-consent",
    });
  });

  test("a user-confirmed flow can waive the consent requirement", () => {
    const b = newArtifactBudget(1, 0);
    const d = decideSpend(b, NO_CONSENT, 0.001, { now: 0, requireConsent: false });
    expect(d).toEqual({ allow: true, needsConfirm: true });
  });

  test("granted consent allows, but still needs confirm above the auto-approve threshold", () => {
    const b = newArtifactBudget(1, 0);
    const c = grantConsent(0.002); // auto-approve ≤ $0.002
    expect(decideSpend(b, c, 0.001, { now: 0 })).toEqual({ allow: true, needsConfirm: false });
    expect(decideSpend(b, c, 0.01, { now: 0 })).toEqual({ allow: true, needsConfirm: true });
  });

  test("over-cap is checked before rate-limit before consent", () => {
    const overCap = { ...newArtifactBudget(0.01, 0), windowCalls: 99, windowStartedAt: 0 };
    // even rate-limited + no consent, the cap reason wins (checked first)
    expect(decideSpend(overCap, NO_CONSENT, 1, { now: 0 }).allow).toBe(false);
    expect((decideSpend(overCap, NO_CONSENT, 1, { now: 0 }) as { reason: string }).reason).toBe(
      "over-cap",
    );
  });
});

describe("helpers", () => {
  test("denyReasonText is human + covers every reason", () => {
    expect(denyReasonText("over-cap")).toContain("cap");
    expect(denyReasonText("rate-limited")).toContain("Too many");
    expect(denyReasonText("no-consent")).toContain("spend");
  });
});
