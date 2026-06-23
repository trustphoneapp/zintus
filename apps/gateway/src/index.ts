export { startCloudConnection, type CloudOptions, type CloudConnection } from "./cloud.js";
import { createEngine } from "@zintus/engine";
import { loadPolicy, watchPolicy } from "@zintus/router";
import { DEFAULT_CONFIG } from "@zintus/types";
import { buildGatewayConfig, type GatewayConfig } from "./auth.js";
import { createGatewayHandler, type LogFn } from "./handler.js";

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
}

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

  const log: LogFn = (level, message, fields = {}) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: "gateway",
      message,
      ...fields,
    });
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createGatewayHandler({
      engine,
      config,
      log,
      // Feed real free-tier quota into Tokzen's quota-aware compression dial.
      getQuotaRemaining: (provider) => engine.getQuotaRemaining(provider),
    }),
  });

  watchPolicy((next) => {
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
    const probeTimer = setInterval(runProbe, probeIntervalMs);
    probeTimer.unref?.();
    runProbe(); // prime immediately on boot
  }

  const url = `http://${config.host}:${server.port}`;
  log("info", "gateway.listening", {
    url,
    auth: config.token ? "required" : "disabled",
    cors: config.corsOrigins === "*" ? "*" : config.corsOrigins.join(","),
  });
  if (!config.token) {
    log("warn", "gateway.auth_disabled", {
      hint: "Set GATEWAY_TOKEN to require a bearer token on API requests.",
    });
  }

  return { server, config, url };
}

// Run directly (`bun run src/index.ts` / `zintus`'s `dev:gateway`).
if (import.meta.main) {
  startGateway();
}
