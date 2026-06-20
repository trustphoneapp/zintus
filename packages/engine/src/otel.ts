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

/** Build the OTLP/HTTP JSON ResourceSpans payload for a completed request. Pure. */
export function buildOtlpPayload(info: OtelRequestInfo): Record<string, unknown> {
    const { trace } = info;
    const otTraceId = randomHex(16);
    const parentSpanId = randomHex(8);
    const startNano = String(BigInt(trace.startedAt.getTime()) * 1_000_000n);
    const endMs = trace.completedAt?.getTime() ?? Date.now();
    const endNano = String(BigInt(endMs) * 1_000_000n);

    const parentSpan = {
      traceId: otTraceId,
      spanId: parentSpanId,
      name: "chat.request",
      kind: 2, // SERVER
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
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

    let cursorMs = trace.startedAt.getTime();
    const childSpans = trace.attempts.map((attempt) => {
      const aStart = String(BigInt(cursorMs) * 1_000_000n);
      cursorMs += Math.max(0, attempt.latencyMs);
      const aEnd = String(BigInt(cursorMs) * 1_000_000n);
      return {
        traceId: otTraceId,
        spanId: randomHex(8),
        parentSpanId,
        name: "provider.attempt",
        kind: 3, // CLIENT
        startTimeUnixNano: aStart,
        endTimeUnixNano: aEnd,
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
