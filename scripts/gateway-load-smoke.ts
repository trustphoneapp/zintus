#!/usr/bin/env bun
/**
 * Gateway load smoke test.
 *
 * Fires 50 concurrent `GET /health` requests, then 10 sequential
 * `POST /v1/chat/completions` requests at a running gateway, and prints
 * p50/p95/p99 latency for the health checks.
 *
 * PERFORMANCE TARGET: /health p95 < 500ms. The endpoint reports either 200
 * (all configured capabilities ready) or 503 (the gateway is live but its
 * optional Engineer capability is unavailable), and both prove liveness.
 *
 * Usage:
 *   bun run scripts/gateway-load-smoke.ts
 *   GATEWAY_URL=http://192.168.1.20:8788 GATEWAY_TOKEN=secret bun run scripts/gateway-load-smoke.ts
 *
 * Environment:
 *   GATEWAY_URL    Base URL of the gateway (default http://localhost:8788).
 *   GATEWAY_TOKEN  Bearer token sent on /v1/chat/completions (omit if the
 *                  gateway runs without auth).
 *
 * This script never requires real provider API keys. If chat completions fail
 * (e.g. no keys configured on the gateway), it reports success/failure counts
 * rather than crashing. If the gateway is unreachable it prints a clear message
 * and exits non-zero without an unhandled rejection.
 */

const GATEWAY_URL = (process.env.GATEWAY_URL ?? "http://localhost:8788").replace(
  /\/+$/,
  "",
);
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN?.trim();

const HEALTH_CONCURRENCY = 50;
const CHAT_REQUESTS = 10;
const HEALTH_P95_TARGET_MS = 500;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const weight = rank - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function authHeaders(): Record<string, string> {
  return GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {};
}

async function preflight(): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    // Any HTTP response (even non-200) means the gateway is reachable.
    void res.status;
    await res.body?.cancel().catch(() => {});
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `\nCannot reach the gateway at ${GATEWAY_URL}/health: ${reason}`,
    );
    console.error("Is the gateway running? Set GATEWAY_URL to override.\n");
    return false;
  }
}

async function timedHealth(): Promise<number | null> {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => {});
    // A failed optional Engineer preflight intentionally makes /health 503.
    // Count that as a response for this liveness/latency probe; the dedicated
    // Engineer suite owns readiness correctness.
    if (res.status !== 200 && res.status !== 503) return null;
    return performance.now() - start;
  } catch {
    return null;
  }
}

async function runHealthLoad(): Promise<void> {
  console.log(
    `Firing ${HEALTH_CONCURRENCY} concurrent GET /health requests...`,
  );
  const results = await Promise.all(
    Array.from({ length: HEALTH_CONCURRENCY }, () => timedHealth()),
  );

  const latencies = results.filter((r): r is number => r !== null).sort(
    (a, b) => a - b,
  );
  const failures = results.length - latencies.length;

  if (latencies.length === 0) {
    console.error(
      `All ${HEALTH_CONCURRENCY} /health requests failed; no latency to report.`,
    );
    return;
  }

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);

  console.log(
    `  ok=${latencies.length} failed=${failures} ` +
      `min=${latencies[0].toFixed(1)}ms max=${latencies[latencies.length - 1].toFixed(1)}ms`,
  );
  console.log(
    `  p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms`,
  );
  console.log(
    `  /health p95 target < ${HEALTH_P95_TARGET_MS}ms -> ` +
      (p95 < HEALTH_P95_TARGET_MS ? "PASS" : "MISS"),
  );
}

async function runChatLoad(): Promise<void> {
  console.log(
    `\nFiring ${CHAT_REQUESTS} sequential POST /v1/chat/completions requests...`,
  );
  let ok = 0;
  let failed = 0;
  const statusCounts = new Map<string, number>();

  for (let i = 0; i < CHAT_REQUESTS; i++) {
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Reply with: pong" }],
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      await res.body?.cancel().catch(() => {});
      statusCounts.set(
        String(res.status),
        (statusCounts.get(String(res.status)) ?? 0) + 1,
      );
      if (res.ok) ok++;
      else failed++;
    } catch (error) {
      const reason = error instanceof Error ? error.name : "error";
      statusCounts.set(reason, (statusCounts.get(reason) ?? 0) + 1);
      failed++;
    }
  }

  console.log(`  ok=${ok} failed=${failed}`);
  const breakdown = [...statusCounts.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`  status breakdown: ${breakdown}`);
  if (failed > 0) {
    console.log(
      "  note: chat failures are expected if the gateway has no provider keys or auth token.",
    );
  }
}

async function main(): Promise<void> {
  console.log(`Gateway load smoke test -> ${GATEWAY_URL}`);
  console.log(`Auth: ${GATEWAY_TOKEN ? "bearer token set" : "none"}\n`);

  if (!(await preflight())) {
    process.exit(1);
  }

  await runHealthLoad();
  await runChatLoad();
  console.log("\nDone.");
}

main().catch((error) => {
  // Last-resort guard: never surface an unhandled rejection.
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`\nUnexpected error: ${reason}`);
  process.exit(1);
});
