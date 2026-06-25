import { describe, expect, test } from "bun:test";
import { verifyStripeSignature } from "../src/billing.js";

// The Stripe webhook signature gate. A bypass here = anyone can forge a
// "checkout.session.completed" and grant themselves a free Pro subscription, so
// this is one of the highest-value tests in the relay. Stripe's scheme:
// HMAC-SHA256 over `${t}.${body}` keyed by the webhook secret, compared to v1.

const SECRET = "whsec_test_secret_value";

/** Produce a valid Stripe-style signature header for a body, as Stripe would. */
async function sign(body: string, secret = SECRET, t = "1718000000"): Promise<string> {
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
