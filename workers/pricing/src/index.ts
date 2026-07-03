import { BUNDLED_SNAPSHOT, validateSnapshot, type ModelRates } from "@zintus/burn";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  crossCheckOpenRouter,
  KV_LAST_REPORT,
  KV_PENDING,
  readCurrentSnapshot,
  refresh,
  type OpenRouterModel,
  type RefreshReport,
} from "./refresh.js";

interface Env {
  PRICING_KV: KVNamespace;
  /** Optional JSON URL serving `ModelRates[]` (human-maintained). */
  PRICE_SOURCE_URL?: string;
  /** Optional webhook POSTed the report when a refresh raises alerts. */
  ALERT_WEBHOOK_URL?: string;
  /** Bearer token for POST /v1/refresh. Unset → manual refresh disabled. */
  ADMIN_TOKEN?: string;
}

/**
 * Fetch proposed rates from PRICE_SOURCE_URL, falling back to the bundled
 * snapshot's rates. A fetch/parse failure falls back too — a broken source
 * must degrade to "prices unchanged", never to "no prices".
 */
async function loadProposedRates(env: Env): Promise<readonly ModelRates[]> {
  if (!env.PRICE_SOURCE_URL) {
    return BUNDLED_SNAPSHOT.rates;
  }
  try {
    const response = await fetch(env.PRICE_SOURCE_URL, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return BUNDLED_SNAPSHOT.rates;
    }
    const rates = (await response.json()) as ModelRates[];
    // Validate shape by wrapping in a throwaway snapshot.
    const problems = validateSnapshot({
      version: 1,
      generatedAt: new Date().toISOString(),
      rates,
    });
    return problems.length === 0 ? rates : BUNDLED_SNAPSHOT.rates;
  } catch {
    return BUNDLED_SNAPSHOT.rates;
  }
}

async function runRefresh(env: Env, force: boolean): Promise<RefreshReport> {
  const report = await refresh({
    kv: env.PRICING_KV,
    proposedRates: await loadProposedRates(env),
    force,
  });
  if (report.alerts.length > 0 && env.ALERT_WEBHOOK_URL) {
    // Best-effort notification; the report is already durable in KV.
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    }).catch(() => {});
  }
  return report;
}

const app = new Hono<{ Bindings: Env }>();

// The price table IS the public transparency artifact — serve it to anyone.
app.use("/v1/*", cors({ origin: "*", allowMethods: ["GET"] }));

app.get("/health", (c) => c.json({ ok: true }));

/** The currently published, billing-grade price snapshot. */
app.get("/v1/price-table", async (c) => {
  const snapshot = await readCurrentSnapshot(c.env.PRICING_KV);
  return c.json(snapshot);
});

/** The last refresh report (published / blocked_by_alerts / unchanged / invalid). */
app.get("/v1/price-table/report", async (c) => {
  const raw = await c.env.PRICING_KV.get(KV_LAST_REPORT);
  return raw
    ? c.body(raw, 200, { "content-type": "application/json" })
    : c.json({ error: "no refresh has run yet" }, 404);
});

/** A pending snapshot blocked by alerts, if any (awaiting force-approval). */
app.get("/v1/price-table/pending", async (c) => {
  const raw = await c.env.PRICING_KV.get(KV_PENDING);
  return raw
    ? c.body(raw, 200, { "content-type": "application/json" })
    : c.json({ error: "no pending snapshot" }, 404);
});

/** Live market drift check against OpenRouter (warnings only, never billing). */
app.get("/v1/price-table/drift", async (c) => {
  const snapshot = await readCurrentSnapshot(c.env.PRICING_KV);
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    return c.json({ error: `openrouter responded ${response.status}` }, 502);
  }
  const body = (await response.json()) as { data?: OpenRouterModel[] };
  const warnings = crossCheckOpenRouter(snapshot, body.data ?? []);
  return c.json({ snapshotVersion: snapshot.version, warnings });
});

/** Manual refresh; `?force=true` approves a pending alerted snapshot. */
app.post("/v1/refresh", async (c) => {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!c.env.ADMIN_TOKEN || token !== c.env.ADMIN_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const force = c.req.query("force") === "true";
  return c.json(await runRefresh(c.env, force));
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runRefresh(env, false);
  },
};
