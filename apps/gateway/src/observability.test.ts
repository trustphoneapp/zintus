import { afterEach, describe, expect, mock, test } from "bun:test";
import { createErrorSink } from "./observability.js";

// createErrorSink is opt-in: no SENTRY_DSN -> undefined (errors stay on the
// structured log). With a DSN it lazily loads @sentry/node and forwards
// exceptions. We inject a fake @sentry/node via mock.module to test the wiring
// without the real dependency.

afterEach(() => mock.restore());

describe("createErrorSink — disabled by default", () => {
  test("returns undefined when SENTRY_DSN is unset", () => {
    expect(createErrorSink({})).toBeUndefined();
  });

  test("returns undefined for an empty / whitespace DSN", () => {
    expect(createErrorSink({ SENTRY_DSN: "" })).toBeUndefined();
    expect(createErrorSink({ SENTRY_DSN: "   " })).toBeUndefined();
  });
});

describe("createErrorSink — wired to Sentry", () => {
  function installFakeSentry() {
    const calls: Array<{ error: unknown; hint?: Record<string, unknown> }> = [];
    let initOpts: Record<string, unknown> | null = null;
    mock.module("@sentry/node", () => ({
      init: (opts: Record<string, unknown>) => {
        initOpts = opts;
      },
      captureException: (error: unknown, hint?: Record<string, unknown>) => {
        calls.push({ error, hint });
      },
    }));
    return { calls, getInitOpts: () => initOpts };
  }

  test("returns a hook and initialises Sentry with the DSN + environment", async () => {
    const fake = installFakeSentry();
    const sink = createErrorSink({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/1", SENTRY_ENVIRONMENT: "staging" });
    expect(typeof sink).toBe("function");
    await Promise.resolve(); // let the async init() run
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.getInitOpts()?.dsn).toBe("https://k@o1.ingest.sentry.io/1");
    expect(fake.getInitOpts()?.environment).toBe("staging");
  });

  test("forwards exceptions to captureException with path + requestId", async () => {
    const fake = installFakeSentry();
    const sink = createErrorSink({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/1" })!;
    await new Promise((r) => setTimeout(r, 5)); // allow init to complete

    const err = new Error("boom");
    sink(err, { requestId: "req-123", path: "/v1/chat/completions" });

    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.error).toBe(err);
    expect(fake.calls[0]!.hint?.tags).toEqual({ path: "/v1/chat/completions" });
    expect(fake.calls[0]!.hint?.extra).toEqual({ requestId: "req-123" });
  });

  test("buffers early-boot errors and flushes them once init completes", async () => {
    const fake = installFakeSentry();
    const sink = createErrorSink({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/1" })!;
    // Fire immediately, before the async import resolves — these must be buffered.
    sink(new Error("early-1"), { requestId: "r1", path: "/x" });
    sink(new Error("early-2"), { requestId: "r2", path: "/y" });
    await new Promise((r) => setTimeout(r, 10)); // init + flush
    expect(fake.calls.length).toBe(2);
  });
});
