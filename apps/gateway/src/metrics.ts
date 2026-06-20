/**
 * Tiny in-process metrics for the gateway. No external deps; survives for the
 * lifetime of the server process. Exposed as JSON at GET /metrics and as
 * Prometheus text via toPrometheus().
 */
export interface MetricsSnapshot {
  uptimeSeconds: number;
  requestsTotal: number;
  requestsByOutcome: { ok: number; clientError: number; serverError: number };
  chatCompletionsTotal: number;
  chatByProvider: Record<string, number>;
  errorsTotal: number;
  latencyMs: { count: number; sum: number; max: number; avg: number };
}

export interface Metrics {
  recordRequest(status: number, latencyMs: number): void;
  recordChat(providerId: string): void;
  recordError(): void;
  snapshot(): MetricsSnapshot;
  toPrometheus(): string;
}

export function createMetrics(now: () => number = Date.now): Metrics {
  const startedAt = now();
  let requestsTotal = 0;
  let ok = 0;
  let clientError = 0;
  let serverError = 0;
  let chatCompletionsTotal = 0;
  const chatByProvider: Record<string, number> = {};
  let errorsTotal = 0;
  let latencyCount = 0;
  let latencySum = 0;
  let latencyMax = 0;

  function snapshot(): MetricsSnapshot {
    return {
      uptimeSeconds: Math.floor((now() - startedAt) / 1000),
      requestsTotal,
      requestsByOutcome: { ok, clientError, serverError },
      chatCompletionsTotal,
      chatByProvider: { ...chatByProvider },
      errorsTotal,
      latencyMs: {
        count: latencyCount,
        sum: latencySum,
        max: latencyMax,
        avg: latencyCount === 0 ? 0 : Math.round(latencySum / latencyCount),
      },
    };
  }

  return {
    recordRequest(status, latencyMs) {
      requestsTotal += 1;
      if (status >= 500) {
        serverError += 1;
      } else if (status >= 400) {
        clientError += 1;
      } else {
        ok += 1;
      }
      latencyCount += 1;
      latencySum += latencyMs;
      if (latencyMs > latencyMax) {
        latencyMax = latencyMs;
      }
    },
    recordChat(providerId) {
      chatCompletionsTotal += 1;
      chatByProvider[providerId] = (chatByProvider[providerId] ?? 0) + 1;
    },
    recordError() {
      errorsTotal += 1;
    },
    snapshot,
    toPrometheus() {
      const s = snapshot();
      const lines = [
        "# HELP zintus_gateway_requests_total Total HTTP requests handled.",
        "# TYPE zintus_gateway_requests_total counter",
        `zintus_gateway_requests_total ${s.requestsTotal}`,
        `zintus_gateway_requests_total{outcome="ok"} ${s.requestsByOutcome.ok}`,
        `zintus_gateway_requests_total{outcome="client_error"} ${s.requestsByOutcome.clientError}`,
        `zintus_gateway_requests_total{outcome="server_error"} ${s.requestsByOutcome.serverError}`,
        "# HELP zintus_gateway_chat_completions_total Total chat completions.",
        "# TYPE zintus_gateway_chat_completions_total counter",
        `zintus_gateway_chat_completions_total ${s.chatCompletionsTotal}`,
        ...Object.entries(s.chatByProvider).map(
          ([provider, count]) =>
            `zintus_gateway_chat_completions_total{provider="${provider}"} ${count}`,
        ),
        "# HELP zintus_gateway_errors_total Total request errors.",
        "# TYPE zintus_gateway_errors_total counter",
        `zintus_gateway_errors_total ${s.errorsTotal}`,
        "# HELP zintus_gateway_request_latency_ms_max Max request latency (ms).",
        "# TYPE zintus_gateway_request_latency_ms_max gauge",
        `zintus_gateway_request_latency_ms_max ${s.latencyMs.max}`,
        "# HELP zintus_gateway_request_latency_ms_avg Avg request latency (ms).",
        "# TYPE zintus_gateway_request_latency_ms_avg gauge",
        `zintus_gateway_request_latency_ms_avg ${s.latencyMs.avg}`,
      ];
      return lines.join("\n") + "\n";
    },
  };
}
