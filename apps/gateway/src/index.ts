import { createEngine } from "@multipleai/engine";
import { loadPolicy, watchPolicy } from "@multipleai/router";
import { DEFAULT_CONFIG } from "@multipleai/types";
import { buildGatewayConfig } from "./auth.js";
import { createGatewayHandler, type LogFn } from "./handler.js";

const config = buildGatewayConfig(process.env);

// Declarative routing policy (policy.json) is loaded at startup and hot-reloaded
// on change — no restart needed to retune weights, model groups, or limits.
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
  fetch: createGatewayHandler({ engine, config, log }),
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

log("info", "gateway.listening", {
  url: `http://${config.host}:${server.port}`,
  auth: config.token ? "required" : "disabled",
  cors: config.corsOrigins === "*" ? "*" : config.corsOrigins.join(","),
});
if (!config.token) {
  log("warn", "gateway.auth_disabled", {
    hint: "Set GATEWAY_TOKEN to require a bearer token on API requests.",
  });
}
