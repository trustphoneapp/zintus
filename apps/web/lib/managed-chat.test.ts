import { afterEach, describe, expect, test } from "bun:test";
import {
  ManagedChatFailure,
  classifyManagedError,
  drainSseBuffer,
  isManagedModelId,
  managedFailureMessage,
  streamManagedChat,
} from "./managed-chat";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── drainSseBuffer ──────────────────────────────────────────────────────────

describe("drainSseBuffer", () => {
  test("emits deltas and captures the usage chunk", () => {
    const deltas: string[] = [];
    const usages: Array<{ inputTokens: number; outputTokens: number }> = [];
    const tail = drainSseBuffer(
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
        'data: {"usage":{"prompt_tokens":12,"completion_tokens":5},"choices":[]}\n\n' +
        "data: [DONE]\n\n",
      (t) => deltas.push(t),
      (u) => usages.push(u),
    );
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(usages).toEqual([{ inputTokens: 12, outputTokens: 5 }]);
    expect(tail).toBe("");
  });

  test("keeps an incomplete frame as the tail", () => {
    const deltas: string[] = [];
    const tail = drainSseBuffer(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"cho',
      (t) => deltas.push(t),
      () => {},
    );
    expect(deltas).toEqual(["ok"]);
    expect(tail).toBe('data: {"cho');
  });

  test("ignores malformed frames without dying", () => {
    const deltas: string[] = [];
    const tail = drainSseBuffer(
      "data: not-json\n\n" + 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      (t) => deltas.push(t),
      () => {},
    );
    expect(deltas).toEqual(["x"]);
    expect(tail).toBe("");
  });
});

// ── error classification + honest messages ──────────────────────────────────

describe("classifyManagedError", () => {
  test("401 → unauthorized regardless of body", () => {
    expect(classifyManagedError(401, {})).toEqual({ kind: "unauthorized" });
  });

  test("membership_required and model_unavailable pass through", () => {
    expect(classifyManagedError(403, { code: "membership_required" })).toEqual({
      kind: "membership_required",
    });
    expect(classifyManagedError(404, { code: "model_unavailable" })).toEqual({
      kind: "model_unavailable",
    });
  });

  test("plan_tokens_exhausted carries used/limit/reset", () => {
    expect(
      classifyManagedError(429, {
        code: "plan_tokens_exhausted",
        used: 10,
        limit: 20,
        reset: 30,
      }),
    ).toEqual({ kind: "plan_tokens_exhausted", used: 10, limit: 20, reset: 30 });
  });

  test("anything else is a generic error with the relay message", () => {
    expect(classifyManagedError(502, { error: "All managed upstreams failed" })).toEqual({
      kind: "error",
      message: "All managed upstreams failed",
    });
  });
});

describe("managedFailureMessage", () => {
  test("unauthorized → sign-in guidance (session-expiry honesty)", () => {
    expect(managedFailureMessage({ kind: "unauthorized" })).toContain("Sign in again");
  });
  test("membership_required → pick-a-plan, no dead end", () => {
    expect(managedFailureMessage({ kind: "membership_required" })).toContain(
      "active Zintus membership",
    );
  });
  test("plan_tokens_exhausted names the exact used/limit", () => {
    const msg = managedFailureMessage({
      kind: "plan_tokens_exhausted",
      used: 1234,
      limit: 5678,
      reset: 0,
    });
    expect(msg).toContain("1,234");
    expect(msg).toContain("5,678");
  });
  test("generic error surfaces the relay message verbatim", () => {
    expect(managedFailureMessage({ kind: "error", message: "boom" })).toBe("boom");
  });
});

describe("isManagedModelId", () => {
  test("only zintus/-prefixed ids are managed", () => {
    expect(isManagedModelId("zintus/llama-3.3-70b")).toBe(true);
    expect(isManagedModelId("gpt-4o-mini")).toBe(false);
    expect(isManagedModelId("groq/llama")).toBe(false);
  });
});

// ── streamManagedChat (mocked stream) ───────────────────────────────────────

function sseResponse(frames: string[], headers: Record<string, string> = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream", ...headers } },
  );
}

describe("streamManagedChat", () => {
  test("sends a credentialed POST and streams deltas + served-by/model/usage", async () => {
    let sawCredentials: RequestCredentials | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sawCredentials = init.credentials;
      return sseResponse(
        [
          'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"there"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":7,"completion_tokens":2},"choices":[]}\n\n',
          "data: [DONE]\n\n",
        ],
        { "X-Zintus-Served-By": "groq", "X-Zintus-Model": "zintus/llama-3.3-70b" },
      );
    }) as unknown as typeof fetch;

    const chunks: string[] = [];
    const result = await streamManagedChat({
      model: "zintus/llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
      onChunk: (t) => chunks.push(t),
    });
    // Cross-subdomain cookie auth requires credentials:"include".
    expect(sawCredentials).toBe("include");
    expect(chunks.join("")).toBe("Hi there");
    expect(result.servedBy).toBe("groq");
    expect(result.model).toBe("zintus/llama-3.3-70b");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // No plan-debit header on this response → honest null, never a guess.
    expect(result.planTokensDebited).toBeNull();
  });

  test("computes the plan-token debit from X-Zintus-Plan-Per-1k", async () => {
    // Premium model on a Pro member: 1,429 plan tokens per 1K real tokens.
    // 900 real tokens → round(900 × 1429 / 1000) = 1,286 (PRICING-FINAL Part 6).
    globalThis.fetch = (async () =>
      sseResponse(
        [
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":600,"completion_tokens":300},"choices":[]}\n\n',
          "data: [DONE]\n\n",
        ],
        {
          "X-Zintus-Served-By": "groq",
          "X-Zintus-Model": "zintus/llama-3.3-70b",
          "X-Zintus-Class": "premium",
          "X-Zintus-Plan-Per-1k": "1429",
        },
      )) as unknown as typeof fetch;

    const result = await streamManagedChat({
      model: "zintus/llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(result.modelClass).toBe("premium");
    expect(result.planTokensDebited).toBe(1286);
  });

  test("no usage chunk → planTokensDebited stays null even with the header", async () => {
    globalThis.fetch = (async () =>
      sseResponse(
        ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"],
        { "X-Zintus-Plan-Per-1k": "1429" },
      )) as unknown as typeof fetch;

    const result = await streamManagedChat({
      model: "zintus/llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
      onChunk: () => {},
    });
    expect(result.usage).toBeNull();
    expect(result.planTokensDebited).toBeNull();
  });

  test("throws a typed failure on a membership gate", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "membership_required", error: "nope" }), {
        status: 403,
      })) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await streamManagedChat({
        model: "zintus/llama-3.3-70b",
        messages: [{ role: "user", content: "hi" }],
        onChunk: () => {},
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ManagedChatFailure);
    expect((thrown as ManagedChatFailure).detail).toEqual({ kind: "membership_required" });
  });

  test("401 → unauthorized failure (mid-chat session expiry)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      })) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await streamManagedChat({
        model: "zintus/llama-3.3-70b",
        messages: [{ role: "user", content: "hi" }],
        onChunk: () => {},
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ManagedChatFailure);
    expect((thrown as ManagedChatFailure).detail).toEqual({ kind: "unauthorized" });
  });
});
