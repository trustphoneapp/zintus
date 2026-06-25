import { afterEach, describe, expect, test } from "bun:test";
import { createErrorSink } from "../src/observability.js";

// The opt-in relay error sink. Must be a true no-op when unconfigured, and must
// never leak secrets/PII when it does report.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createErrorSink — opt-in", () => {
  test("returns undefined (no-op) when SENTRY_DSN is unset", () => {
    expect(createErrorSink({})).toBeUndefined();
  });

  test("returns undefined when SENTRY_DSN is blank", () => {
    expect(createErrorSink({ SENTRY_DSN: "   " })).toBeUndefined();
  });

  test("returns undefined for a malformed DSN (no throw)", () => {
    expect(createErrorSink({ SENTRY_DSN: "not a dsn" })).toBeUndefined();
  });

  test("returns a reporter function when a valid DSN is set", () => {
    const sink = createErrorSink({ SENTRY_DSN: "https://pub@o9.ingest.sentry.io/42" });
    expect(typeof sink).toBe("function");
  });
});

describe("createErrorSink — reporting", () => {
  test("POSTs a redacted envelope (no secret, no PII) to the ingest URL", async () => {
    let captured: { url: string; body: string } | null = null;
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      captured = { url: String(url), body: String((init as { body: string }).body) };
      return new Response("ok");
    }) as typeof fetch;

    const sink = createErrorSink({ SENTRY_DSN: "https://pub@o9.ingest.sentry.io/42" })!;
    // Error message embeds a live Stripe secret — must be scrubbed.
    await sink(new Error("checkout failed sk_live_ABCDEF1234567890 boom"), {
      path: "/api/billing/checkout",
      method: "POST",
    });

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://o9.ingest.sentry.io/api/42/envelope/");
    expect(captured!.body).toContain("****REDACTED****");
    expect(captured!.body).not.toContain("sk_live_ABCDEF1234567890");
    // Only the pathname is reported — never a query string that could carry tokens.
    expect(captured!.body).not.toContain("?");
  });

  test("never throws when the ingest POST fails", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const sink = createErrorSink({ SENTRY_DSN: "https://pub@o9.ingest.sentry.io/42" })!;
    await expect(sink(new Error("x"), { path: "/health" })).resolves.toBeUndefined();
  });
});
