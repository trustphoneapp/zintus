import { describe, expect, test } from "bun:test";
import {
  verifyStripeSignature,
  handleStripeWebhook,
  withinReplayWindow,
  createPortalSession,
  createCheckoutSession,
  STRIPE_SIGNATURE_TOLERANCE_SECS,
} from "../src/billing.js";
import type { Env } from "../src/types.js";

// The Stripe webhook signature gate. A bypass here = anyone can forge a
// "checkout.session.completed" and grant themselves a free Pro subscription, so
// this is one of the highest-value tests in the relay. Stripe's scheme:
// HMAC-SHA256 over `${t}.${body}` keyed by the webhook secret, compared to v1.

const SECRET = "whsec_test_secret_value";

/** Produce a valid Stripe-style signature header for a body, as Stripe would.
 *  Defaults `t` to NOW so handler tests pass the ±5-min replay window; the
 *  signature-only tests below pass an explicit `t` and don't care about recency. */
async function sign(body: string, secret = SECRET, t = String(Math.floor(Date.now() / 1000))): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${t},v1=${hex}`;
}

describe("verifyStripeSignature", () => {
  const body = JSON.stringify({ type: "checkout.session.completed", data: { object: {} } });

  test("accepts a correctly-signed payload", async () => {
    expect(await verifyStripeSignature(body, await sign(body), SECRET)).toBe(true);
  });

  test("rejects a signature made with the WRONG secret (no free Pro)", async () => {
    const forged = await sign(body, "whsec_attacker_secret");
    expect(await verifyStripeSignature(body, forged, SECRET)).toBe(false);
  });

  test("rejects when the body was tampered after signing", async () => {
    const header = await sign(body);
    const tamperedBody = body.replace("checkout.session.completed", "invoice.paid");
    expect(await verifyStripeSignature(tamperedBody, header, SECRET)).toBe(false);
  });

  test("rejects a header missing the timestamp (t)", async () => {
    const header = (await sign(body)).replace(/t=[^,]+,/, "");
    expect(await verifyStripeSignature(body, header, SECRET)).toBe(false);
  });

  test("rejects a header missing the v1 signature", async () => {
    expect(await verifyStripeSignature(body, "t=1718000000", SECRET)).toBe(false);
  });

  test("rejects an outright garbage header", async () => {
    expect(await verifyStripeSignature(body, "totally-bogus", SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, "", SECRET)).toBe(false);
  });

  test("a changed timestamp invalidates the signature (t is part of the signed payload)", async () => {
    const header = await sign(body, SECRET, "1718000000");
    const movedTimestamp = header.replace("t=1718000000", "t=1719999999");
    expect(await verifyStripeSignature(body, movedTimestamp, SECRET)).toBe(false);
  });
});

// ── B4: stripe_customer_id is persisted where the reads expect it ────────────
// The portal path reads `SELECT stripe_customer_id FROM subscriptions`, so the
// `subscriptions` table is authoritative. The webhook previously also ran
// `UPDATE zintus_users SET stripe_customer_id=?` against a column that does not
// exist (silent 0-row write). These tests pin that the customer id + tokens_limit
// land on `subscriptions`, and that nothing writes to `zintus_users`.

/** Fake D1 that records every executed (sql, args). */
function recordingDb() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  return {
    calls,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          calls.push({ sql, args });
          return {};
        },
        first: async () => null,
      }),
    }),
  };
}

describe("handleStripeWebhook — checkout.session.completed persistence (B4)", () => {
  test("writes stripe_customer_id + tokens_limit to subscriptions, never to zintus_users", async () => {
    const db = recordingDb();
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { user_id: "u1", tier: "growth" },
          customer: "cus_123",
          subscription: "sub_123",
        },
      },
    };
    const payload = JSON.stringify(event);
    const env = { DB: db, STRIPE_WEBHOOK_SECRET: SECRET } as unknown as Env;

    const res = await handleStripeWebhook(
      new Request("https://relay/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": await sign(payload) },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // No write targets the (non-existent) zintus_users.stripe_customer_id column.
    expect(db.calls.some((c) => /zintus_users/i.test(c.sql))).toBe(false);

    // The subscriptions upsert carries the customer id and the tier's token cap.
    const upsert = db.calls.find((c) => /INSERT INTO subscriptions/i.test(c.sql));
    expect(upsert).toBeDefined();
    expect(upsert!.sql).toContain("stripe_customer_id");
    expect(upsert!.sql).toContain("tokens_limit");
    expect(upsert!.args).toContain("cus_123");
    expect(upsert!.args).toContain(5_000_000); // growth tier monthly budget
  });

  test("rejects an unsigned/forged webhook before any DB write", async () => {
    const db = recordingDb();
    const env = { DB: db, STRIPE_WEBHOOK_SECRET: SECRET } as unknown as Env;
    const payload = JSON.stringify({ type: "checkout.session.completed", data: { object: {} } });

    const res = await handleStripeWebhook(
      new Request("https://relay/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": "t=1,v1=deadbeef" },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(db.calls.length).toBe(0);
  });
});

// ── B-Lane fix 1: replay window (±5 min) ────────────────────────────────────
// A correctly-signed but stale (replayed) event must be rejected before any DB
// write. Stripe's `t` is inside the HMAC, so it can't be moved without breaking
// v1 — but a captured request replayed within seconds is otherwise valid forever.

describe("withinReplayWindow", () => {
  const now = 1_800_000_000;
  test("default tolerance is Stripe's documented 5 minutes (300s)", () => {
    expect(STRIPE_SIGNATURE_TOLERANCE_SECS).toBe(300);
  });
  test("accepts a timestamp inside the tolerance (both directions)", () => {
    expect(withinReplayWindow(`t=${now},v1=x`, now)).toBe(true);
    expect(withinReplayWindow(`t=${now - 299},v1=x`, now)).toBe(true);
    expect(withinReplayWindow(`t=${now + 299},v1=x`, now)).toBe(true);
  });
  test("boundary is inclusive: exactly ±tolerance accepted, one past rejected", () => {
    expect(withinReplayWindow(`t=${now - STRIPE_SIGNATURE_TOLERANCE_SECS},v1=x`, now)).toBe(true);
    expect(withinReplayWindow(`t=${now + STRIPE_SIGNATURE_TOLERANCE_SECS},v1=x`, now)).toBe(true);
    expect(withinReplayWindow(`t=${now - STRIPE_SIGNATURE_TOLERANCE_SECS - 1},v1=x`, now)).toBe(false);
  });

  test("rejects a stale timestamp beyond tolerance", () => {
    expect(withinReplayWindow(`t=${now - STRIPE_SIGNATURE_TOLERANCE_SECS - 1},v1=x`, now)).toBe(false);
  });
  test("rejects a future timestamp beyond tolerance", () => {
    expect(withinReplayWindow(`t=${now + STRIPE_SIGNATURE_TOLERANCE_SECS + 1},v1=x`, now)).toBe(false);
  });
  test("rejects a missing/garbage timestamp", () => {
    expect(withinReplayWindow("v1=x", now)).toBe(false);
    expect(withinReplayWindow("t=notanumber,v1=x", now)).toBe(false);
  });
});

describe("handleStripeWebhook — replay window", () => {
  const event = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { metadata: { user_id: "u1", tier: "growth" }, customer: "cus_1", subscription: "sub_1" } },
  });

  test("rejects a correctly-signed but STALE event (400) with zero DB writes", async () => {
    const db = recordingDb();
    const env = { DB: db, STRIPE_WEBHOOK_SECRET: SECRET } as unknown as Env;
    // Signed an hour ago: valid HMAC (the t is the signed one), stale window.
    const staleT = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await handleStripeWebhook(
      new Request("https://relay/webhook", {
        method: "POST",
        body: event,
        headers: { "stripe-signature": await sign(event, SECRET, staleT) },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(db.calls.length).toBe(0);
  });

  test("accepts a fresh, correctly-signed event (200) and writes", async () => {
    const db = recordingDb();
    const env = { DB: db, STRIPE_WEBHOOK_SECRET: SECRET } as unknown as Env;
    const res = await handleStripeWebhook(
      new Request("https://relay/webhook", {
        method: "POST",
        body: event,
        headers: { "stripe-signature": await sign(event) }, // default t = now
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(db.calls.some((c) => /INSERT INTO subscriptions/i.test(c.sql))).toBe(true);
  });
});

// ── B-Lane fix 2: createPortalSession must check res.ok ─────────────────────

describe("createPortalSession — Stripe error path", () => {
  const realFetch = globalThis.fetch;
  const env = { STRIPE_SECRET_KEY: "sk_test" } as unknown as Env;

  test("throws on a non-2xx Stripe response instead of returning undefined url", async () => {
    globalThis.fetch = (async () =>
      new Response("No such customer", { status: 400 })) as typeof fetch;
    try {
      await expect(createPortalSession("cus_missing", env)).rejects.toThrow(/Stripe portal error/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("returns the url on success", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ url: "https://billing.stripe.com/session/abc" }), { status: 200 })) as typeof fetch;
    try {
      expect(await createPortalSession("cus_ok", env)).toBe("https://billing.stripe.com/session/abc");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── B-Lane fix 3 (adjacent): checkout never hits Stripe with a placeholder price.
// createCheckoutSession throws BEFORE the network call when the price is still a
// `price_FILL…` placeholder, so the route's checkoutAvailability guard returns a
// clean 503 rather than letting an empty `line_items[0][price]` reach Stripe.

describe("createCheckoutSession — placeholder price guard", () => {
  test("throws before any fetch when the price is an unconfigured placeholder", async () => {
    const realFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const env = { STRIPE_SECRET_KEY: "sk_test" } as unknown as Env;
    try {
      await expect(createCheckoutSession("u1", "u1@e.com", "growth", null, env)).rejects.toThrow(/price not configured/i);
      expect(fetched).toBe(false); // never reached Stripe
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
