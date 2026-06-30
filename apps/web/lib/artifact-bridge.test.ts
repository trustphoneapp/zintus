import { describe, expect, test } from "bun:test";
import {
  isBridgeRequest,
  bridgeReply,
  bridgeShim,
  authorizeBridgeCall,
} from "./artifact-bridge";
import { newArtifactBudget, grantConsent, NO_CONSENT } from "./artifact-quota";

describe("bridge protocol", () => {
  test("isBridgeRequest accepts a well-formed request, rejects junk", () => {
    expect(isBridgeRequest({ type: "zintus:complete", id: "b1", prompt: "hi" })).toBe(true);
    expect(isBridgeRequest({ type: "zintus:complete", id: "", prompt: "hi" })).toBe(false);
    expect(isBridgeRequest({ type: "other", id: "b1", prompt: "hi" })).toBe(false);
    expect(isBridgeRequest({ type: "zintus:complete", id: "b1" })).toBe(false);
    expect(isBridgeRequest(null)).toBe(false);
    expect(isBridgeRequest("zintus:complete")).toBe(false);
  });

  test("bridgeReply builds ok and error replies", () => {
    expect(bridgeReply("b1", { text: "done" })).toEqual({
      type: "zintus:complete:result",
      id: "b1",
      ok: true,
      text: "done",
    });
    expect(bridgeReply("b1", { error: "nope" })).toEqual({
      type: "zintus:complete:result",
      id: "b1",
      ok: false,
      error: "nope",
    });
  });

  test("bridgeShim exposes window.zintus.complete over postMessage, no key/network", () => {
    const shim = bridgeShim();
    expect(shim).toContain("window.zintus");
    expect(shim).toContain("zintus:complete");
    expect(shim).toContain("parent.postMessage");
    // sanity: it's a self-contained script with no fetch / no key reference
    expect(shim).not.toContain("fetch(");
    expect(shim).not.toContain("apiKey");
  });
});

describe("authorizeBridgeCall", () => {
  const frame = { id: "frame" }; // stand-in for iframe.contentWindow
  const budget = newArtifactBudget(0.5, 0);

  test("rejects a message that didn't come from the artifact's own frame", () => {
    const auth = authorizeBridgeCall({
      source: { id: "someone-else" },
      frame,
      budget,
      consent: grantConsent(),
      estUsd: 0.001,
      now: 0,
    });
    expect(auth).toEqual({ ok: false, reason: "untrusted-source" });
  });

  test("rejects when null source (can't prove identity)", () => {
    const auth = authorizeBridgeCall({ source: null, frame, budget, consent: grantConsent(), estUsd: 0.001, now: 0 });
    expect(auth).toEqual({ ok: false, reason: "untrusted-source" });
  });

  test("runtime calls require consent even from the right frame", () => {
    const auth = authorizeBridgeCall({ source: frame, frame, budget, consent: NO_CONSENT, estUsd: 0.001, now: 0 });
    expect(auth).toEqual({ ok: false, reason: "no-consent" });
  });

  test("right frame + consent + within budget ⇒ ok", () => {
    const auth = authorizeBridgeCall({ source: frame, frame, budget, consent: grantConsent(0.01), estUsd: 0.001, now: 0 });
    expect(auth).toEqual({ ok: true, needsConfirm: false });
  });

  test("right frame but over cap ⇒ blocked", () => {
    const spent = { ...newArtifactBudget(0.01, 0), spentUsd: 0.009 };
    const auth = authorizeBridgeCall({ source: frame, frame, budget: spent, consent: grantConsent(), estUsd: 0.05, now: 0 });
    expect(auth).toEqual({ ok: false, reason: "over-cap" });
  });

  test("rate limiting applies to bridge calls", () => {
    const hot = { ...newArtifactBudget(1, 0), windowCalls: 20, windowStartedAt: 0 };
    const auth = authorizeBridgeCall({
      source: frame, frame, budget: hot, consent: grantConsent(),
      estUsd: 0.001, rateLimit: 20, rateWindowMs: 60_000, now: 1000,
    });
    expect(auth).toEqual({ ok: false, reason: "rate-limited" });
  });
});
