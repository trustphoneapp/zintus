import { describe, expect, test } from "bun:test";
import { createMetrics } from "./metrics.js";

describe("metrics", () => {
  test("counts requests by outcome and tracks latency", () => {
    const m = createMetrics();
    m.recordRequest(200, 10);
    m.recordRequest(404, 20);
    m.recordRequest(500, 30);

    const s = m.snapshot();
    expect(s.requestsTotal).toBe(3);
    expect(s.requestsByOutcome).toEqual({ ok: 1, clientError: 1, serverError: 1 });
    expect(s.latencyMs.count).toBe(3);
    expect(s.latencyMs.max).toBe(30);
    expect(s.latencyMs.avg).toBe(20);
  });

  test("counts chat completions per provider and errors", () => {
    const m = createMetrics();
    m.recordChat("groq");
    m.recordChat("groq");
    m.recordChat("gemini");
    m.recordError();

    const s = m.snapshot();
    expect(s.chatCompletionsTotal).toBe(3);
    expect(s.chatByProvider).toEqual({ groq: 2, gemini: 1 });
    expect(s.errorsTotal).toBe(1);
  });

  test("emits Prometheus exposition text", () => {
    const m = createMetrics();
    m.recordRequest(200, 5);
    m.recordChat("groq");
    const text = m.toPrometheus();
    expect(text).toContain("zintus_gateway_requests_total 1");
    expect(text).toContain('zintus_gateway_chat_completions_total{provider="groq"} 1');
  });
});
