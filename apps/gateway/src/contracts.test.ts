import { afterEach, describe, expect, test } from "bun:test";
import {
  createMockProvider,
  createMockRequest,
  assertChatCompletionShape,
  assertValidSSEStream,
} from "@zintus/test-utils";
import { createTestGateway } from "@zintus/test-utils/bun";

// CONTRACT tests for the gateway's response shapes. These pin what the gateway
// ACTUALLY returns (verified against handler.ts), NOT the theoretical OpenAI
// spec: there is no `created` or `usage`, `id` is a UUID trace id, the 404 body
// uses `error` as a bare STRING, and /v1/models entries carry `owned_by`.

describe("gateway response contracts", () => {
  let cleanup: () => void = () => {};
  afterEach(() => cleanup());

  async function gateway() {
    const gw = await createTestGateway({ providers: [createMockProvider({ id: "groq", content: "hi there" })] });
    cleanup = gw.cleanup;
    return gw.handler;
  }

  test("non-streaming completion matches the real shape — and OMITS created/usage", async () => {
    const handler = await gateway();
    const res = await handler(createMockRequest({ provider: "groq", stream: false }));
    const body = (await res.json()) as Record<string, unknown>;

    assertChatCompletionShape(body);
    // The deviations from OpenAI, asserted explicitly so they can't silently change:
    expect(body.created).toBeUndefined();
    expect(body.usage).toBeUndefined();
    expect(body.provider).toBe("groq"); // extra Zintus field
    expect(typeof body.thread_id).toBe("string"); // extra Zintus field
  });

  test("streaming chunks are chat.completion.chunk and terminate with [DONE]", async () => {
    const handler = await gateway();
    const res = await handler(createMockRequest({ provider: "groq", stream: true }));
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const { chunks, totalContent } = await assertValidSSEStream(res);
    expect(chunks).toBeGreaterThan(0);
    expect(totalContent).toBe("hi there");
  });

  test("/v1/models returns { object:'list', data:[{id, object:'model', owned_by}] }", async () => {
    const handler = await gateway();
    const res = await handler(createMockRequest({ method: "GET", path: "/v1/models" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<Record<string, unknown>> };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    for (const m of body.data) {
      expect(typeof m.id).toBe("string");
      expect(m.object).toBe("model");
      expect(typeof m.owned_by).toBe("string");
    }
  });

  test("invalid body error is an OBJECT: { error: { message } }", async () => {
    const handler = await gateway();
    const res = await handler(createMockRequest({ rawBody: "not json" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message?: string } };
    expect(typeof body.error).toBe("object");
    expect(typeof body.error.message).toBe("string");
  });

  test("404 error is a STRING: { error: 'Not found' } (not an object)", async () => {
    const handler = await gateway();
    const res = await handler(createMockRequest({ method: "GET", path: "/v1/does-not-exist" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: unknown };
    // This is the inconsistency the contract agent flagged: body.error.message
    // would be undefined here because error is a bare string.
    expect(typeof body.error).toBe("string");
    expect(body.error).toBe("Not found");
  });

  test("health is { ok, auth } only — no provider topology", async () => {
    const handler = await gateway();
    const res = await handler(createMockRequest({ method: "GET", path: "/health" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.providers).toBeUndefined();
    expect(body.savings).toBeUndefined();
  });
});
