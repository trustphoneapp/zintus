export { startCloudConnection, type CloudOptions, type CloudConnection } from "./cloud.js";
export {
  getOrCreateGatewayKeypair,
  decryptKeyPayload,
  type GatewayKeypair,
} from "./crypto.js";
export { detectLocalRuntimes, type LocalRuntimes } from "./local-runtimes.js";
export { MCPRegistry, type MCPRegistryOptions } from "./mcp-registry.js";
// Re-exported so integration tests (and @zintus/test-utils) can build a handler
// against a custom engine without reaching into ./handler.js internals.
export {
  createGatewayHandler,
  type GatewayHandlerDeps,
  type ErrorHook,
  type LogFn as GatewayLogFn,
} from "./handler.js";
import { createEngine } from "@zintus/engine";
import { loadPolicy, watchPolicy, redactSecrets } from "@zintus/router";
import { DEFAULT_CONFIG } from "@zintus/types";
import { ActivityStore } from "./activity-store.js";
import { buildGatewayConfig, type GatewayConfig } from "./auth.js";
import { createGatewayHandler, type LogFn } from "./handler.js";
import { createErrorSink } from "./observability.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import { MCPRegistry } from "./mcp-registry.js";

export interface StartGatewayOptions {
  /** Override GATEWAY_HOST (e.g. from a CLI flag). */
  host?: string;
  /** Override GATEWAY_PORT (e.g. from a CLI flag). */
  port?: number;
}

export interface RunningGateway {
  server: ReturnType<typeof Bun.serve>;
  config: GatewayConfig;
  url: string;
  /**
   * Begin graceful shutdown: flip /health to draining (503), stop accepting new
   * connections, let in-flight streams finish, and clear background timers.
   * Idempotent. `extraCleanup` runs first (e.g. closing the cloud relay WS).
   */
  shutdown(extraCleanup?: () => void | Promise<void>): Promise<void>;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Boot the gateway HTTP server and return a handle. Overrides are applied via
 * the environment first so all of buildGatewayConfig's validation still runs
 * (notably: refusing a public bind without GATEWAY_TOKEN). Used by both the
 * standalone entry below and the `zintus serve` CLI command.
 */
export function startGateway(options: StartGatewayOptions = {}): RunningGateway {
  if (options.host) {
    process.env.GATEWAY_HOST = options.host;
  }
  if (options.port != null) {
    process.env.GATEWAY_PORT = String(options.port);
  }

  const config = buildGatewayConfig(process.env);

  // Declarative routing policy (policy.json) is loaded at startup and
  // hot-reloaded on change — no restart needed to retune weights, model
  // groups, or limits.
  const policy = loadPolicy();

  const engine = createEngine({
    strategy: DEFAULT_CONFIG.routingStrategy,
    providerPriority: DEFAULT_CONFIG.providerPriority,
    policy,
  });

  // Durable, machine-local usage history (~/.zintus/activity.db, beside the
  // quota ledger) so GET /v1/activity is a real persistent 30-day feed. Opened
  // once and pruned on open; local-only, never sent anywhere.
  const activityStore = new ActivityStore();

  // MCP connection registry — the gateway HOSTS the MCP clients (server-side;
  // the browser can't spawn stdio). Connections are reused across requests and
  // drained on shutdown. Local-first / no-custody: MCP traffic never touches the
  // relay.
  const mcpRegistry = new MCPRegistry();

  const log: LogFn = (level, message, fields = {}) => {
    // Redact any provider/secret token before the structured line is emitted —
    // an upstream error echoed into `fields` (e.g. a 401 body) can carry a key.
    const line = redactSecrets(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        service: "gateway",
        message,
        ...fields,
      }),
    );
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  // Graceful-shutdown state. `draining` is read by the handler's /health so
  // load balancers/clients stop routing new traffic here once shutdown begins.
  let draining = false;

  // Optional per-client rate limiter on the expensive POST endpoints. Disabled
  // unless GATEWAY_RATELIMIT_RPM is set to a positive value, so default
  // behaviour is unchanged for existing self-hosters.
  const rpm = Number(process.env.GATEWAY_RATELIMIT_RPM);
  const rateLimiter: RateLimiter | undefined =
    Number.isFinite(rpm) && rpm > 0
      ? createRateLimiter({
          limit: Math.floor(rpm),
          windowMs: 60_000,
          // Only trust X-Forwarded-For behind a known reverse proxy.
          trustProxy: /^(1|true)$/i.test(process.env.GATEWAY_TRUST_PROXY ?? ""),
        })
      : undefined;

  // Optional error sink (Sentry when SENTRY_DSN is set; otherwise undefined and
  // errors continue to flow only to the structured JSON log).
  const onError = createErrorSink(process.env, log);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createGatewayHandler({
      engine,
      config,
      log,
      onError,
      rateLimiter,
      activityStore,
      mcpRegistry,
      getDraining: () => draining,
      // Real, in-flight-aware free-tier quota signal for Tokzen's quota-aware
      // compression dial (was always the hardcoded 1.0 default before wiring).
      getQuotaRemaining: (provider) => engine.getQuotaRemaining(provider),
    }),
  });

  const unwatchPolicy = watchPolicy((next) => {
    engine.updatePolicy(next);
    log("info", "gateway.policy_reloaded", {
      modelGroups: Object.keys(next.modelGroups ?? {}).length,
      hasWeights: Boolean(next.providerWeights),
    });
  });

  // Optional background provider health probe (Phase 5.3). When
  // PROVIDER_PROBE_INTERVAL_MS is set, periodically validate each keyed provider
  // so an unreachable provider is demoted by health-aware routing before a real
  // request hits it. Off by default.
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  const probeIntervalMs = Number(process.env.PROVIDER_PROBE_INTERVAL_MS);
  if (Number.isFinite(probeIntervalMs) && probeIntervalMs >= 1000) {
    const runProbe = () => {
      engine
        .probeProviders()
        .then((results) => {
          const down = results.filter((r) => !r.ok).map((r) => r.providerId);
          log("info", "gateway.provider_probe", {
            checked: results.length,
            down: down.length ? down.join(",") : "none",
          });
        })
        .catch((error) => {
          log("warn", "gateway.provider_probe_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };
    probeTimer = setInterval(runProbe, probeIntervalMs);
    probeTimer.unref?.();
    runProbe(); // prime immediately on boot
  }

  const url = `http://${config.host}:${server.port}`;
  log("info", "gateway.listening", {
    url,
    auth: config.token ? "required" : "disabled",
    cors:
      config.corsOrigins === "*"
        ? "*"
        : config.corsOrigins === "loopback"
          ? "loopback (localhost + desktop + zintus.ai)"
          : config.corsOrigins.join(","),
  });
  if (!config.token) {
    log("warn", "gateway.auth_disabled", {
      hint:
        "No GATEWAY_TOKEN: API auth is disabled and CORS is restricted to " +
        "localhost / the desktop app / zintus.ai so other websites can't reach " +
        "this gateway. Set GATEWAY_TOKEN to require a bearer token (and allow any origin).",
    });
  }

  let shuttingDown: Promise<void> | null = null;
  async function shutdown(
    extraCleanup?: () => void | Promise<void>,
  ): Promise<void> {
    // Idempotent: a second signal during drain joins the in-flight shutdown.
    if (shuttingDown) {
      return shuttingDown;
    }
    shuttingDown = (async () => {
      draining = true; // /health -> 503 so clients stop routing here
      log("info", "gateway.draining", {});
      try {
        await extraCleanup?.();
      } catch (error) {
        log("warn", "gateway.cleanup_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
      }
      // Drain hosted MCP connections (stop the idle sweep + disconnect every
      // cached client, killing any stdio children) so a deploy doesn't leak them.
      try {
        await mcpRegistry.disconnectAll();
      } catch (error) {
        log("warn", "gateway.mcp_drain_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      unwatchPolicy();
      // Stop accepting new connections; let in-flight requests/streams finish,
      // but force-close after a bounded grace period so deploys don't hang.
      const drainMs = Number(process.env.GATEWAY_DRAIN_TIMEOUT_MS);
      const grace = Number.isFinite(drainMs) && drainMs >= 0 ? drainMs : DEFAULT_DRAIN_TIMEOUT_MS;
      const graceful = server.stop(false);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const forced = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log("warn", "gateway.drain_timeout", { graceMs: grace });
          void server.stop(true).finally(resolve);
        }, grace);
        timer.unref?.();
      });
      await Promise.race([graceful, forced]);
      if (timer) {
        clearTimeout(timer);
      }
      log("info", "gateway.stopped", {});
    })();
    return shuttingDown;
  }

  return { server, config, url, shutdown };
}

/**
 * Install SIGTERM/SIGINT handlers that drive a graceful drain of the gateway
 * (and any extra cleanup, e.g. the cloud relay connection). A second signal
 * forces an immediate exit. Used by both the standalone entry below and the
 * `zintus serve` CLI command.
 */
export function installShutdownHandlers(
  running: RunningGateway,
  extraCleanup?: () => void | Promise<void>,
): void {
  let signalled = false;
  const handle = () => {
    if (signalled) {
      // Second signal: don't wait for the drain, exit now.
      process.exit(130);
    }
    signalled = true;
    void running
      .shutdown(extraCleanup)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", handle);
  process.on("SIGINT", handle);
}

// Run directly (`bun run src/index.ts` / `zintus`'s `dev:gateway`).
if (import.meta.main) {
  const running = startGateway();
  installShutdownHandlers(running);
}
