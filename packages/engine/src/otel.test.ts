import { describe, expect, test } from "bun:test";
import type { RequestTrace } from "@zintus/types";
import { buildOtlpPayload, exportRequestTrace, isOtelEnabled } from "./otel.js";

const trace: RequestTrace = {
  traceId: "t-1",
  startedAt: new Date(1_700_000_000_000),
  completedAt: new Date(1_700_000_000_450),
  totalLatencyMs: 450,
  winner: { providerId: "groq", model: "llama-3.3-70b-versatile" },
  attempts: [
    { providerId: "gemini", model: "gemini-1.5-flash", status: "fail", latencyMs: 120, errorCode: 429 },
    { providerId: "groq", model: "llama-3.3-70b-versatile", status: "success", latencyMs: 300 },
  ],
};

describe("otel OTLP payload", () => {
  test("builds a parent span plus one child per attempt", () => {
    const payload = buildOtlpPayload({
      trace,
      cacheHit: "miss",
      failoverCount: 1,
      compileTokens: 42,
    }) as any;

    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    // 1 parent (chat.request) + 2 attempts.
    expect(spans).toHaveLength(3);
    expect(spans[0].name).toBe("chat.request");
    expect(spans[1].name).toBe("provider.attempt");

    // All spans share one 32-hex-char (16-byte) trace id.
    const traceId = spans[0].traceId;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    for (const s of spans) {
      expect(s.traceId).toBe(traceId);
    }

    // Children reference the parent span id.
    expect(spans[1].parentSpanId).toBe(spans[0].spanId);

    // The failed attempt is marked ERROR (status code 2) with the 429 code.
    const failed = spans.find(
      (s: any) =>
        s.attributes.some(
          (a: any) => a.key === "zintus.attempt.status" && a.value.stringValue === "fail",
        ),
    );
    expect(failed.status.code).toBe(2);
    expect(
      failed.attributes.some(
        (a: any) => a.key === "http.response.status_code" && a.value.intValue === "429",
      ),
    ).toBe(true);
  });

  test("export is a no-op when OTEL endpoint is unset (never throws)", () => {
    const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(isOtelEnabled()).toBe(false);
    expect(() => exportRequestTrace({ trace })).not.toThrow();
    if (prev !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev;
  });
});
