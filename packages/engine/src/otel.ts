import type { RequestTrace } from "@zintus/types";

/**
 * Dependency-free OpenTelemetry export (Phase 4.1, "Helicone-lite").
 *
 * When OTEL_EXPORTER_OTLP_ENDPOINT is set, each completed request is exported as
 * an OTLP/HTTP JSON trace: a parent `chat.request` span with one child
 * `provider.attempt` span per routing attempt (carrying provider, model,
 * latency, status, error, cache tier, tokens, and failover count). We emit the
 * standard OTLP wire format directly so there is no SDK dependency and nothing
 * leaks into the web bundle. Fully no-op (and never throws) when the env var is
 * absent.
 */

export interface OtelRequestInfo {
  trace: RequestTrace;
  cacheHit?: "L1" | "L2" | "miss";
  compileTokens?: number;
  failoverCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * REAL measured span timing (monotonic epoch ms, captured via {@link nowEpochMs}),
   * so exported spans reflect actual durations instead of synthetic offsets.
   *
   * - `startMs` / `endMs` bound the parent `chat.request` span.
   * - `attemptEndsMs[i]` is the real instant the engine observed
   *   `trace.attempts[i]` complete; that attempt's span start is derived as
   *   `attemptEndsMs[i] − attempt.latencyMs` (its real measured latency), which
   *   preserves true gaps between attempts.
   *
   * All optional: when omitted, timing falls back to the trace's wall-clock
   * `startedAt` / `completedAt` (still real, never fabricated forward offsets).
   */
  startMs?: number;
  endMs?: number;
  attemptEndsMs?: number[];
}

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "zintus-gateway";

export function isOtelEnabled(): boolean {
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

function tracesUrl(): string {
  const base = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").replace(/\/$/, "");
  // Accept either the signal-specific endpoint or the base endpoint.
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Attr = { key: string; value: Record<string, unknown> };

function str(key: string, value: string | undefined): Attr | null {
  return value == null ? null : { key, value: { stringValue: value } };
}
function int(key: string, value: number | undefined): Attr | null {
  return value == null
    ? null
    : { key, value: { intValue: String(Math.round(value)) } };
}
function attrs(list: Array<Attr | null>): Attr[] {
  return list.filter((a): a is Attr => a !== null);
}

/**
 * Whether a monotonic high-resolution clock is available. `performance.now()`
 * is monotonic and sub-millisecond, and `performance.timeOrigin` pins it to the
 * Unix epoch, so the two together give absolute timestamps whose intervals
 * reflect REAL elapsed time and never jump backward with NTP/DST corrections.
 */
const SUPPORTS_MONOTONIC =
  typeof performance !== "undefined" &&
  typeof performance.now === "function" &&
  typeof performance.timeOrigin === "number";

/**
 * Absolute Unix-epoch milliseconds (fractional) read from the monotonic clock
 * where supported, falling back to `Date.now()`. This is the single timing
 * source for OTel spans: capture it when a span opens and again when it closes,
 * so start/end/duration are measured, not synthesized.
 */
export function nowEpochMs(): number {
  return SUPPORTS_MONOTONIC
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

/**
 * Convert (possibly fractional) epoch milliseconds to a Unix-nanosecond string.
 * Keeps the integer-ms part exact via BigInt (the product overflows a double's
 * 53-bit mantissa) while still carrying sub-millisecond precision.
 */
function msToUnixNano(ms: number): string {
  const whole = Math.floor(ms);
  const fracNanos = Math.round((ms - whole) * 1_000_000);
  return String(BigInt(whole) * 1_000_000n + BigInt(fracNanos));
}

/** Build the OTLP/HTTP JSON ResourceSpans payload for a completed request. Pure. */
export function buildOtlpPayload(info: OtelRequestInfo): Record<string, unknown> {
    const { trace } = info;
    const otTraceId = randomHex(16);
    const parentSpanId = randomHex(8);

    // Parent `chat.request` span: REAL measured start/end. Prefer the monotonic
    // samples the engine captured around the request; fall back to the trace's
    // wall-clock timestamps. Either way these are observed, not synthetic.
    const parentStartMs = info.startMs ?? trace.startedAt.getTime();
    const parentEndMs =
      info.endMs ?? trace.completedAt?.getTime() ?? nowEpochMs();

    const parentSpan = {
      traceId: otTraceId,
      spanId: parentSpanId,
      name: "chat.request",
      kind: 2, // SERVER
      startTimeUnixNano: msToUnixNano(parentStartMs),
      endTimeUnixNano: msToUnixNano(parentEndMs),
      attributes: attrs([
        str("gen_ai.system", "zintus"),
        str("gen_ai.request.model", trace.winner?.model),
        str("zintus.winner.provider", trace.winner?.providerId),
        str("zintus.cache.hit", info.cacheHit),
        int("zintus.failover.count", info.failoverCount),
        int("zintus.compile.tokens", info.compileTokens),
        int("gen_ai.usage.input_tokens", info.inputTokens),
        int("gen_ai.usage.output_tokens", info.outputTokens),
        int("zintus.total.latency_ms", trace.totalLatencyMs),
      ]),
      status: { code: 1 }, // OK
    };

    // Child `provider.attempt` spans anchored to the REAL instant the engine
    // observed each attempt complete (`attemptEndsMs[i]`); the start is that
    // real end minus the attempt's real measured `latencyMs`. This preserves
    // true gaps/overlap between attempts — unlike the previous synthetic cursor,
    // which packed attempts back-to-back from the request start and so neither
    // matched real completion instants nor reflected waits between attempts.
    //
    // When ends are not supplied we reconstruct backward from the real parent
    // end (so the chain terminates at the true completion instant rather than
    // drifting forward from the start); a partially-filled array is honored
    // per-index and the gaps are filled from the nearest known real end.
    const attemptEnds = new Array<number>(trace.attempts.length);
    let cursorMs = parentEndMs;
    for (let i = trace.attempts.length - 1; i >= 0; i--) {
      const latency = Math.max(0, trace.attempts[i]?.latencyMs ?? 0);
      const endMs = info.attemptEndsMs?.[i] ?? cursorMs;
      attemptEnds[i] = endMs;
      cursorMs = endMs - latency;
    }

    const childSpans = trace.attempts.map((attempt, i) => {
      const aEndMs = attemptEnds[i] ?? parentEndMs;
      const aStartMs = aEndMs - Math.max(0, attempt.latencyMs);
      return {
        traceId: otTraceId,
        spanId: randomHex(8),
        parentSpanId,
        name: "provider.attempt",
        kind: 3, // CLIENT
        startTimeUnixNano: msToUnixNano(aStartMs),
        endTimeUnixNano: msToUnixNano(aEndMs),
        attributes: attrs([
          str("gen_ai.system", attempt.providerId),
          str("gen_ai.request.model", attempt.model),
          str("zintus.attempt.status", attempt.status),
          int("http.response.status_code", attempt.errorCode),
          str("error.message", attempt.errorMessage),
          int("zintus.attempt.latency_ms", attempt.latencyMs),
        ]),
        status: { code: attempt.status === "fail" ? 2 : 1 }, // ERROR : OK
      };
    });

    return {
      resourceSpans: [
        {
          resource: {
            attributes: attrs([str("service.name", SERVICE_NAME)]),
          },
          scopeSpans: [
            {
              scope: { name: "@zintus/engine" },
              spans: [parentSpan, ...childSpans],
            },
          ],
        },
      ],
    };
}

/**
 * Build + POST the OTLP payload. Fire-and-forget; swallows all errors so
 * telemetry can never affect or delay a chat response. No-op unless
 * OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */
export function exportRequestTrace(info: OtelRequestInfo): void {
  if (!isOtelEnabled()) {
    return;
  }
  try {
    void fetch(tracesUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOtlpPayload(info)),
    }).catch(() => {
      // Telemetry must never affect the request path.
    });
  } catch {
    // Never throw from the telemetry path.
  }
}
