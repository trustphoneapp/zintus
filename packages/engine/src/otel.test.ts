import { describe, expect, test } from "bun:test";
import type { RequestTrace } from "@zintus/types";
import {
  buildOtlpPayload,
  exportRequestTrace,
  isOtelEnabled,
  nowEpochMs,
} from "./otel.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Nanoseconds between two OTLP span timestamps. */
const durationNs = (span: any): bigint =>
  BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano);

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

describe("otel real (non-synthetic) span timing", () => {
  test("nowEpochMs is monotonic, absolute, and tracks an awaited delay", async () => {
    const a = nowEpochMs();
    await delay(25);
    const b = nowEpochMs();

    // Monotonic: time only moves forward, by the real elapsed amount (timer slack).
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeGreaterThanOrEqual(20);
    // Absolute Unix epoch (well after 2020), i.e. not a relative monotonic origin.
    expect(a).toBeGreaterThan(1_600_000_000_000);
  });

  test("parent span end > start by ~the real awaited delay (measured, not synthetic)", async () => {
    // Capture the SAME monotonic clock the engine uses, around a real delay.
    const startMs = nowEpochMs();
    await delay(50);
    const endMs = nowEpochMs();

    const payload = buildOtlpPayload({
      trace: { ...trace, attempts: [] },
      startMs,
      endMs,
    }) as any;
    const parent = payload.resourceSpans[0].scopeSpans[0].spans[0];

    // The parent span carries the real measured ~50ms window (allow timer slack),
    // not a zero/hardcoded duration.
    const dur = durationNs(parent);
    expect(dur > 0n).toBe(true);
    expect(dur).toBeGreaterThanOrEqual(45_000_000n); // ~>= 45ms
    expect(dur).toBeLessThan(5_000_000_000n); // sanity upper bound
  });

  test("child spans use real measured ends, preserving gaps the old cursor erased", () => {
    const base = trace.startedAt.getTime();
    // Real observed completion instants: the failed attempt finished at +120ms,
    // then there is a real ~30ms gap before the winning attempt finished at +450ms.
    const attemptEndsMs = [base + 120, base + 450];

    const payload = buildOtlpPayload({
      trace,
      startMs: base,
      endMs: base + 450,
      attemptEndsMs,
    }) as any;
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    const [parent, failSpan, okSpan] = spans;

    const nano = (ms: number) => String(BigInt(ms) * 1_000_000n);

    // Each attempt span ENDS at its real observed instant...
    expect(failSpan.endTimeUnixNano).toBe(nano(base + 120));
    expect(okSpan.endTimeUnixNano).toBe(nano(base + 450));
    // ...and STARTS at (real end − real measured latency).
    expect(failSpan.startTimeUnixNano).toBe(nano(base + 0)); // 120 − 120
    expect(okSpan.startTimeUnixNano).toBe(nano(base + 150)); // 450 − 300

    // Non-synthetic proof: the OLD cursor packed attempts back-to-back, so it
    // would have started the winner at +120 and ended it at +420. Real timing
    // starts it at +150 (the 30ms gap is preserved) and ends it at +450 (the
    // true completion instant) — neither matches the synthetic reconstruction.
    expect(okSpan.startTimeUnixNano).not.toBe(nano(base + 120));
    expect(okSpan.endTimeUnixNano).not.toBe(nano(base + 420));

    // Durations equal the real measured latencies.
    expect(durationNs(failSpan)).toBe(BigInt(120) * 1_000_000n);
    expect(durationNs(okSpan)).toBe(BigInt(300) * 1_000_000n);

    // Children nest within the parent window [start, end].
    const pStart = BigInt(parent.startTimeUnixNano);
    const pEnd = BigInt(parent.endTimeUnixNano);
    for (const child of [failSpan, okSpan]) {
      expect(BigInt(child.startTimeUnixNano) >= pStart).toBe(true);
      expect(BigInt(child.endTimeUnixNano) <= pEnd).toBe(true);
    }
  });

  test("sub-millisecond monotonic timing survives into span nanos", () => {
    // Fractional epoch ms (from performance.now) must keep sub-ms precision
    // rather than truncating to whole-millisecond nanos.
    const startMs = 1_700_000_000_000.25;
    const endMs = 1_700_000_000_000.75;
    const payload = buildOtlpPayload({
      trace: { ...trace, attempts: [] },
      startMs,
      endMs,
    }) as any;
    const parent = payload.resourceSpans[0].scopeSpans[0].spans[0];

    // 0.5ms == 500_000ns, and the absolute nanos retain the fractional offset.
    expect(durationNs(parent)).toBe(500_000n);
    expect(parent.startTimeUnixNano).toBe("1700000000000250000");
    expect(parent.endTimeUnixNano).toBe("1700000000000750000");
  });
});
