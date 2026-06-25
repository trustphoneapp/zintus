import { afterEach, describe, expect, test } from "bun:test";
import {
  createMockProvider,
  createMockRequest,
  assertChatCompletionShape,
  assertErrorShape,
  assertValidSSEStream,
} from "@zintus/test-utils";
import { createTestGateway } from "@zintus/test-utils/bun";

// Full gateway request path with a REAL engine + router + Tokzen and a mocked
// provider. Assertions match what the gateway ACTUALLY returns (verified
// against handler.ts): no `usage`/`created`; quota-exhausted is HTTP 400, not
// 429; errors are `{error:{message}}` or a bare string.

describe("gateway flow integration", () => {
  let cleanup: () => void = () => {};
  afterEach(() => cleanup());

  test("non-streaming chat routes to the provider and returns the real completion shape", async () => {
    const provider = createMockProvider({ id: "groq", content: "four" });
    const gw = await createTestGateway({ providers: [provider] });
    cleanup = gw.cleanup;

    const res = await gw.handler(
      createMockRequest({ provider: "groq", stream: false }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Provider-Used")).toBe("groq");
    const body = await res.json();
    assertChatCompletionShape(body);
    const completion = body as { choices: Array<{ message: { content: string } }> };
    expect(completion.choices[0]?.message.content).toBe("four");
    expect(provider.calls()).toBe(1);
  });

  test("streaming chat returns a valid SSE stream ending in [DONE]", async () => {
    const provider = createMockProvider({ id: "groq", content: "hello there friend" });
    const gw = await createTestGateway({ providers: [provider] });
    cleanup = gw.cleanup;

    const res = await gw.handler(
      createMockRequest({ provider: "groq", stream: true }),
    );
    expect(res.status).toBe(200);
    const { chunks, totalContent } = await assertValidSSEStream(res);
    expect(chunks).toBeGreaterThan(0);
    expect(totalContent).toBe("hello there friend");
  });

  test("invalid JSON body returns 400 and does not crash the handler", async () => {
    const provider = createMockProvider({ id: "groq" });
    const gw = await createTestGateway({ providers: [provider] });
    cleanup = gw.cleanup;

    const res = await gw.handler(createMockRequest({ rawBody: "this is not json" }));
    expect(res.status).toBe(400);
    assertErrorShape(await res.json());
    // Handler still serves the next request → it did not crash.
    const ok = await gw.handler(createMockRequest({ provider: "groq", stream: false }));
    expect(ok.status).toBe(200);
  });

  test("schema-invalid body (bad role) returns 400 with issues", async () => {
    const provider = createMockProvider({ id: "groq" });
    const gw = await createTestGateway({ providers: [provider] });
    cleanup = gw.cleanup;

    const res = await gw.handler(
      createMockRequest({
        rawBody: JSON.stringify({ messages: [{ role: "user", content: 123 }] }),
      }),
    );
    expect(res.status).toBe(400);
    const message = assertErrorShape(await res.json());
    expect(message).toBe("Invalid request body");
  });

  test("no eligible provider (no key) returns HTTP 400 'No providers available' — NOT 429", async () => {
    // Spec B1 assumed 429+Retry-After; the REAL behavior is a plain 400 because
    // the router throws `new Error("No providers available...")` which the
    // handler maps to 400 (verified by the contract agent).
    const provider = createMockProvider({ id: "groq" });
    const gw = await createTestGateway({
      providers: [provider],
      getApiKey: async () => null, // provider has no key → ineligible
    });
    cleanup = gw.cleanup;

    const res = await gw.handler(createMockRequest({ stream: false }));
    expect(res.status).toBe(400);
    expect(res.headers.get("Retry-After")).toBeNull();
    const message = assertErrorShape(await res.json());
    expect(message).toContain("No providers available");
    expect(provider.calls()).toBe(0); // never dispatched
  });

  test("failover: first provider 429s, second serves; failover header increments", async () => {
    const failing = createMockProvider({ id: "gemini", priority: 1, failWith: 429 });
    const healthy = createMockProvider({ id: "groq", priority: 2, content: "ok" });
    const gw = await createTestGateway({ providers: [failing, healthy] });
    cleanup = gw.cleanup;

    const res = await gw.handler(createMockRequest({ stream: false }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Provider-Used")).toBe("groq");
    expect(Number(res.headers.get("X-Failover-Count"))).toBeGreaterThanOrEqual(1);
    expect(failing.calls()).toBe(1);
    expect(healthy.calls()).toBe(1);
  });
});
