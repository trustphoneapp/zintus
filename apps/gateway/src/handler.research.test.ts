import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Engine } from "@zintus/engine";
import type { GatewayConfig } from "./auth.js";

/**
 * /v1/research idle-watchdog tests. These mirror the chat watchdog tests in
 * handler.test.ts but for the SSE research endpoint: a start timeout
 * (requestTimeoutMs) bounds time-to-first-event, and a mid-stream idle watchdog
 * (streamIdleTimeoutMs) aborts the upstream research work when the synthesis
 * stalls.
 *
 * deepResearch's real orchestration (decompose → search → synthesize) is unit
 * tested in @zintus/search; here we want to exercise the GATEWAY's stream
 * wrapping (timeouts + SSE framing + abort), so we mock only `runFallbackSearch`
 * to a fast canned result (no network) and keep the real deepResearch. The
 * synthesis/decompose upstream is the injectable fake Engine, which is what the
 * watchdog must abort.
 *
 * mock.module on @zintus/search is known to leak across files (bun), so we spread
 * every real export and re-register the real module in afterEach.
 */

const realSearch = await import("@zintus/search");

type RunFallbackSearch = typeof realSearch.runFallbackSearch;

function installSearchMock(runFallbackSearch: RunFallbackSearch) {
  mock.module("@zintus/search", () => ({
    ...realSearch,
    runFallbackSearch,
  }));
}

afterEach(() => {
  // Restore the genuine module: mock.restore alone does not reliably undo
  // mock.module across files (see repo memory notes), so re-register it.
  mock.module("@zintus/search", () => ({ ...realSearch }));
  mock.restore();
});

const cannedSearch: RunFallbackSearch = (async () => ({
  servedBy: "tavily" as const,
  results: [
    {
      title: "Result A",
      url: "https://example.com/a",
      content: "Alpha content about the topic.",
    },
  ],
})) as RunFallbackSearch;

function fakeEngine(overrides: Partial<Engine> = {}): Engine {
  const base: Engine = {
    async routeAndStream() {
      return {
        providerId: "groq",
        model: "test-model",
        traceId: "trace-1",
        threadId: "thread-1",
        compileTraceId: undefined,
        stream: (async function* () {
          yield "Synthesized answer [1].";
        })(),
      };
    },
    async getProviderStatus() {
      return [];
    },
    getSavings: () => ({ byProvider: {}, total: 0 }),
    getQuotaRemaining: () => 1,
    updatePolicy: () => {},
    probeProviders: async () => [],
    listThreads: () => [],
    getThreadMessages: () => [],
    createThread: () => ({
      id: "t",
      title: "t",
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    getTrace: () => null,
    getLastTrace: () => null,
    listTraces: () => [],
    getThreadState: () => null,
    getCompileTrace: () => null,
    async compileThreadContext() {
      return { traceId: "0", messages: [] };
    },
  };
  return { ...base, ...overrides };
}

async function makeHandler(config: Partial<GatewayConfig>, engine: Engine) {
  const { createGatewayHandler } = await import("./handler.js");
  const full: GatewayConfig = {
    port: 8788,
    host: "127.0.0.1",
    token: "",
    corsOrigins: "*",
    tavilyApiKey: "test-key", // satisfies the "research requires a key" guard
    ...config,
  };
  return createGatewayHandler({ engine, config: full });
}

function researchRequest(body: Record<string, unknown>): Request {
  return new Request("http://x/v1/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/v1/research idle protection", () => {
  test("idle watchdog aborts a stalled synthesis and emits the SSE error shape", async () => {
    installSearchMock(cannedSearch);
    // Quick depth skips decompose, so the only engine call is synthesis. It
    // connects, the early events (queries/search_complete/synthesizing) flow,
    // then the synthesis stream stalls forever → the MID-STREAM idle watchdog
    // (not the start timeout) must abort the upstream and surface the error.
    let aborted = false;
    const engine = fakeEngine({
      async routeAndStream(request) {
        request.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            // Stall: never yields a synthesis chunk (worst case, ignores abort).
            await new Promise<void>(() => {});
            yield "never";
          })(),
        };
      },
    });
    const handler = await makeHandler(
      { streamIdleTimeoutMs: 25, requestTimeoutMs: 5000 },
      engine,
    );
    const res = await handler(researchRequest({ query: "q", depth: "quick" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // Early progress events made it through before the stall.
    expect(text).toContain("synthesizing");
    // The watchdog surfaced this endpoint's existing error event shape.
    expect(text).toContain("event: error");
    expect(text).toContain('"type":"error"');
    expect(text).toContain("stalled");
    // It did NOT terminate normally.
    expect(text).not.toContain("[DONE]");
    // And it tore the upstream synthesis fetch down (signal threaded through).
    expect(aborted).toBe(true);
  });

  test("start timeout aborts research that never produces a first event", async () => {
    installSearchMock(cannedSearch);
    // Standard depth runs decompose first (an engine call). If that connect/read
    // stalls, deepResearch never yields → the START window (requestTimeoutMs)
    // must fire and abort the upstream.
    let aborted = false;
    const engine = fakeEngine({
      async routeAndStream(request) {
        request.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            await new Promise<void>(() => {});
            yield "never";
          })(),
        };
      },
    });
    const handler = await makeHandler(
      { requestTimeoutMs: 25, streamIdleTimeoutMs: 5000 },
      engine,
    );
    const res = await handler(
      researchRequest({ query: "q", depth: "standard" }),
    );
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("stalled");
    expect(text).not.toContain("[DONE]");
    expect(aborted).toBe(true);
  });

  test("healthy research stream completes with events and [DONE]", async () => {
    installSearchMock(cannedSearch);
    const engine = fakeEngine({
      async routeAndStream() {
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            yield "Answer part one. ";
            yield "Answer part two [1].";
          })(),
        };
      },
    });
    const handler = await makeHandler(
      { streamIdleTimeoutMs: 500, requestTimeoutMs: 500 },
      engine,
    );
    const res = await handler(researchRequest({ query: "q", depth: "quick" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: queries");
    expect(text).toContain("event: search_complete");
    expect(text).toContain("event: synthesizing");
    expect(text).toContain("event: answer_chunk");
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: error");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("idle/start timers are cleared after a healthy run (no leak)", async () => {
    installSearchMock(cannedSearch);
    // Use sentinel window values so we can isolate the watchdog's timers from any
    // unrelated timers in the runtime, then assert every watchdog timer was
    // cleared once the stream completed.
    const START = 8888;
    const IDLE = 9999;
    const active = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    // Only track timers created with our sentinel windows.
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const id = (realSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      if (ms === START || ms === IDLE) {
        active.add(id);
      }
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: unknown) => {
      active.delete(id);
      return (realClearTimeout as (...a: unknown[]) => unknown)(id);
    }) as unknown as typeof clearTimeout;

    try {
      const engine = fakeEngine({
        async routeAndStream() {
          return {
            providerId: "groq",
            model: "m",
            traceId: "t",
            // Synchronous chunks — no extra timers to confuse the count.
            stream: (async function* () {
              yield "done answer [1].";
            })(),
          };
        },
      });
      const handler = await makeHandler(
        { requestTimeoutMs: START, streamIdleTimeoutMs: IDLE },
        engine,
      );
      const res = await handler(researchRequest({ query: "q", depth: "quick" }));
      const text = await res.text();
      expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
      // Every watchdog timer (start + per-event idle) was cleared by completion.
      expect(active.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("idle watchdog RESETS on each event — slow-but-progressing stream completes", async () => {
    installSearchMock(cannedSearch);
    // The synthesis stream yields a chunk every 20ms across a span (~120ms) that
    // is LONGER than the 60ms idle window, but every inter-chunk gap (20ms) is
    // SHORTER than it. A per-event RESET keeps the watchdog from ever firing, so
    // the stream completes with [DONE]. An arm-once (non-resetting) watchdog would
    // instead abort at ~60ms — so this distinguishes reset from arm-once, the one
    // property the fast/synchronous tests above can't catch.
    let aborted = false;
    const engine = fakeEngine({
      async routeAndStream(request) {
        request.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          providerId: "groq",
          model: "m",
          traceId: "t",
          stream: (async function* () {
            for (let i = 0; i < 6; i++) {
              await new Promise<void>((r) => setTimeout(r, 20));
              yield `chunk ${i} [1]. `;
            }
          })(),
        };
      },
    });
    const handler = await makeHandler(
      { streamIdleTimeoutMs: 60, requestTimeoutMs: 5000 },
      engine,
    );
    const res = await handler(researchRequest({ query: "q", depth: "quick" }));
    const text = await res.text();
    expect(text).toContain("event: answer_chunk");
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: error");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(aborted).toBe(false);
  });
});
