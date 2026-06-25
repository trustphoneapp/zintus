import { describe, expect, test } from "bun:test";
import app from "../src/index.js";

// Fast HTTP smoke of the relay Hono app via app.request() — no Workers runtime,
// no bindings. Covers the routes that respond before touching env (DB/KV/DO):
// liveness, 404, CORS, and the public magic-link input validation (zod). The
// WebSocket/Durable-Object paths need miniflare and are out of scope here; the
// control-message gate is unit-tested in gateway-session.test.ts.

describe("relay HTTP smoke", () => {
  test("GET /health returns 200 { ok: true }", async () => {
    const res = await app.request("http://relay.test/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("unknown route returns 404", async () => {
    const res = await app.request("http://relay.test/definitely-not-a-route");
    expect(res.status).toBe(404);
  });

  test("CORS preflight is answered with allow headers", async () => {
    const res = await app.request("http://relay.test/api/auth/magic-link", {
      method: "OPTIONS",
      headers: {
        Origin: "https://www.zintus.ai",
        "Access-Control-Request-Method": "POST",
      },
    });
    // hono/cors handles the preflight; assert it doesn't 500 and sets the header.
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  test("POST /api/auth/magic-link with an invalid email returns 400 (zod gate)", async () => {
    const res = await app.request("http://relay.test/api/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Valid email required");
  });

  test("POST /api/auth/magic-link with malformed JSON returns 400, not 500", async () => {
    const res = await app.request("http://relay.test/api/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not json",
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/auth/magic-link with no body returns 400", async () => {
    const res = await app.request("http://relay.test/api/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});
