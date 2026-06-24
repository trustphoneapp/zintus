import { describe, expect, test } from "bun:test";
import {
  createMockProvider,
  createMockRequest,
  assertChatCompletionShape,
  assertErrorShape,
  assertValidSSEStream,
  makeTypeScriptSource,
  makeLogLines,
  SAMPLE_MESSAGES,
} from "./index.js";

describe("test-utils: createMockProvider", () => {
  test("emits the requested content and counts calls", async () => {
    const p = createMockProvider({ id: "groq", content: "hello world" });
    expect(p.calls()).toBe(0);
    const result = await p.streamChat(SAMPLE_MESSAGES, { model: "m" });
    let out = "";
    for await (const chunk of result.stream) out += chunk.content ?? "";
    expect(out).toBe("hello world");
    expect(p.calls()).toBe(1);
  });

  test("failWith throws a ProviderHttpError carrying the status", async () => {
    const p = createMockProvider({ failWith: 429 });
    await expect(p.streamChat(SAMPLE_MESSAGES, {})).rejects.toMatchObject({ status: 429 });
  });

  test("latencyMs delays the first chunk", async () => {
    const p = createMockProvider({ latencyMs: 25, content: "x" });
    const start = Date.now();
    await p.streamChat(SAMPLE_MESSAGES, {});
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });
});

describe("test-utils: createMockRequest", () => {
  test("builds a POST with bearer + JSON body", async () => {
    const req = createMockRequest({ token: "secret", provider: "groq" });
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer secret");
    const body = (await req.json()) as { provider: string; messages: unknown[] };
    expect(body.provider).toBe("groq");
    expect(Array.isArray(body.messages)).toBe(true);
  });

  test("rawBody overrides for invalid-body tests", async () => {
    const req = createMockRequest({ rawBody: "not json" });
    expect(await req.text()).toBe("not json");
  });
});

describe("test-utils: assertions", () => {
  test("assertChatCompletionShape accepts the real Zintus shape, rejects bad", () => {
    expect(() =>
      assertChatCompletionShape({
        id: "trace-1",
        object: "chat.completion",
        model: "m",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
      }),
    ).not.toThrow();
    expect(() => assertChatCompletionShape({ id: "x", object: "wrong" })).toThrow();
  });

  test("assertErrorShape handles both {error:{message}} and {error:string}", () => {
    expect(assertErrorShape({ error: { message: "boom" } })).toBe("boom");
    expect(assertErrorShape({ error: "Not found" })).toBe("Not found");
    expect(() => assertErrorShape({ nope: true })).toThrow();
  });

  test("assertValidSSEStream parses chunks and requires [DONE]", async () => {
    const sse =
      `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ delta: { content: "he" } }] })}\n\n` +
      `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ delta: { content: "llo" } }] })}\n\n` +
      `data: [DONE]\n\n`;
    const res = new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    const { chunks, totalContent } = await assertValidSSEStream(res);
    expect(chunks).toBe(2);
    expect(totalContent).toBe("hello");
  });

  test("assertValidSSEStream throws when [DONE] is missing", async () => {
    const sse = `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [] })}\n\n`;
    const res = new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    await expect(assertValidSSEStream(res)).rejects.toThrow(/DONE/);
  });
});

describe("test-utils: fixtures", () => {
  test("makeTypeScriptSource has function bodies and ~the requested size", () => {
    const src = makeTypeScriptSource(80);
    expect(src.split("\n").length).toBeGreaterThanOrEqual(80);
    expect(src).toContain("export function fn0");
    expect(src).toContain("return scaled");
  });

  test("makeLogLines includes ERROR lines among repeated INFO", () => {
    const log = makeLogLines(500);
    expect(log.split("\n").length).toBe(500);
    expect(log).toContain("[ERROR]");
    expect(log).toContain("[INFO]");
  });
});
