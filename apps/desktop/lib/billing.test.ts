import { afterEach, describe, expect, test } from "bun:test";
import { PLANS, createCheckout, fetchManagedModels } from "./billing";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("PLANS display constants", () => {
  // These MUST mirror the relay's TIERS (workers/relay/src/tiers.ts), which in
  // turn mirror the public pricing page. If this test fails, one of the three
  // surfaces is lying to users.
  test("match the relay tier budgets and public prices", () => {
    expect(PLANS).toEqual([
      { tier: "starter", name: "Starter", priceUsd: 15, tokensPerMonth: 1_000_000 },
      { tier: "pro", name: "Pro", priceUsd: 49, tokensPerMonth: 10_000_000 },
      { tier: "max", name: "Max", priceUsd: 99, tokensPerMonth: 50_000_000 },
      { tier: "ultra", name: "Ultra", priceUsd: 199, tokensPerMonth: 200_000_000 },
    ]);
  });
});

describe("createCheckout", () => {
  test("success returns the Stripe URL", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ url: "https://checkout.stripe.com/x" }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await createCheckout("starter")).toEqual({
      ok: true,
      url: "https://checkout.stripe.com/x",
    });
  });

  test("relay 503 billing_not_configured is surfaced honestly", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { code: "billing_not_configured", message: "Billing is not configured yet." },
        }),
        { status: 503 },
      )) as unknown as typeof fetch;
    const r = await createCheckout("pro");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("billing_not_configured");
      expect(r.message).toBe("Billing is not configured yet.");
    }
  });

  test("401 → unauthorized (UI should prompt sign-in)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch;
    const r = await createCheckout("pro");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unauthorized");
  });

  test("network failure → generic error, never a throw", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const r = await createCheckout("max");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("error");
  });
});

describe("fetchManagedModels", () => {
  test("parses the relay list", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              id: "zintus/llama-3.3-70b",
              display_name: "Llama 3.3 70B",
              context_window: 128000,
              multiplier: 1,
              capabilities: { tools: true, json: true, vision: false },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const models = await fetchManagedModels();
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("zintus/llama-3.3-70b");
  });

  test("failure → empty list (Models page renders BYOK only)", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchManagedModels()).toEqual([]);
  });
});
