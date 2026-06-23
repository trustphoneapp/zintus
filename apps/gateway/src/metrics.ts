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

export interface TokzenMetricsSnapshot {
  tokensSavedTotal: number;
  avgCompressionRatio: number;
  cacheHitRate: number;
  compressionsByProvider: Record<string, number>;
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  requestsTotal: number;
  requestsByOutcome: { ok: number; clientError: number; serverError: number };
  chatCompletionsTotal: number;
  chatByProvider: Record<string, number>;
  errorsTotal: number;
  latencyMs: { count: number; sum: number; max: number; avg: number };
  tokzen: TokzenMetricsSnapshot;
  searchByStrategy: Record<string, number>;
}

export interface Metrics {
  recordRequest(status: number, latencyMs: number): void;
  recordChat(providerId: string): void;
  recordError(): void;
  recordTokzenSavings(originalTokens: number, compressedTokens: number, ratio: number, provider?: string): void;
  recordSearch(strategy: string): void;
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

  // Tokzen metrics
  let tokzenTokensSaved = 0;
  let tokzenRatioSum = 0;
  let tokzenRatioCount = 0;
  let tokzenCacheHits = 0;
  let tokzenRequests = 0;
  const tokzenByProvider: Record<string, number> = {};
  const searchByStrategy: Record<string, number> = {};

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
      tokzen: {
        tokensSavedTotal: tokzenTokensSaved,
        avgCompressionRatio: tokzenRatioCount === 0 ? 1 : tokzenRatioSum / tokzenRatioCount,
        cacheHitRate: tokzenRequests === 0 ? 0 : tokzenCacheHits / tokzenRequests,
        compressionsByProvider: { ...tokzenByProvider },
      },
      searchByStrategy: { ...searchByStrategy },
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
    recordTokzenSavings(originalTokens, compressedTokens, ratio, provider) {
      tokzenRequests += 1;
      tokzenTokensSaved += Math.max(0, originalTokens - compressedTokens);
      tokzenRatioSum += ratio;
      tokzenRatioCount += 1;
      if (ratio < 1) {
        tokzenCacheHits += 1;
      }
      if (provider) {
        tokzenByProvider[provider] = (tokzenByProvider[provider] ?? 0) + 1;
      }
    },
    recordSearch(strategy) {
      searchByStrategy[strategy] = (searchByStrategy[strategy] ?? 0) + 1;
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
        "# HELP tokzen_tokens_saved_total Total input tokens saved by Tokzen compression.",
        "# TYPE tokzen_tokens_saved_total counter",
        `tokzen_tokens_saved_total ${s.tokzen.tokensSavedTotal}`,
        "# HELP tokzen_compression_ratio Average compression ratio (lower = more compressed).",
        "# TYPE tokzen_compression_ratio gauge",
        `tokzen_compression_ratio ${s.tokzen.avgCompressionRatio.toFixed(4)}`,
        "# HELP tokzen_cache_hit_rate Fraction of requests where compression reduced tokens.",
        "# TYPE tokzen_cache_hit_rate gauge",
        `tokzen_cache_hit_rate ${s.tokzen.cacheHitRate.toFixed(4)}`,
        "# HELP zintus_gateway_search_total Web searches by strategy.",
        "# TYPE zintus_gateway_search_total counter",
        ...Object.entries(s.searchByStrategy).map(
          ([strategy, count]) =>
            `zintus_gateway_search_total{strategy="${strategy}"} ${count}`,
        ),
      ];
      return lines.join("\n") + "\n";
    },
  };
}
