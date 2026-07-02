#!/usr/bin/env bun
/**
 * Model-catalog drift check (P1 of docs/audit/2026-07-02/openrouter-manus-plan.md).
 *
 * For every provider whose key is available (OS keychain via @zintus/keychain,
 * falling back to `<PROVIDER>_API_KEY` env), fetches the provider's live
 * `GET /models` and diffs the returned ids against the curated MODEL_CATALOG.
 *
 * DELIBERATELY REPORT-ONLY: the catalog is hand-curated with conservative
 * capability flags (see catalog.ts's honesty contract), so live data is never
 * auto-applied — a human promotes entries after verifying flags. This script
 * makes the drift visible so the curation never silently rots.
 *
 * Usage:
 *   bun run scripts/sync-model-catalog.ts             # all keyed providers
 *   bun run scripts/sync-model-catalog.ts groq gemini # subset
 *   bun run scripts/sync-model-catalog.ts --json      # machine-readable
 */
// scripts/ is not a workspace package — import sources relatively.
import {
  PROVIDER_IDS,
  isProviderId,
  type ProviderId,
} from "../packages/types/src/index.js";
import { MODEL_CATALOG } from "../packages/providers/src/catalog.js";
import { EXTENDED_PROVIDERS } from "../packages/providers/src/manifest.js";
import { getKey } from "../packages/keychain/src/storage.js";

/** OpenAI-compat `GET /models` endpoints. Manifest providers contribute their
 *  baseUrl automatically; the original 12 are listed here (the runtime impls
 *  don't export their base URLs). `null` = provider has no usable /models
 *  surface (or a non-OpenAI-compat one) — skipped with a note. */
const MODELS_ENDPOINTS: Record<ProviderId, string | null> = {
  cerebras: "https://api.cerebras.ai/v1/models",
  groq: "https://api.groq.com/openai/v1/models",
  // Gemini's native surface (?key= auth), handled specially below.
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  openrouter: "https://openrouter.ai/api/v1/models",
  cohere: "https://api.cohere.com/compatibility/v1/models",
  mistral: "https://api.mistral.ai/v1/models",
  deepseek: "https://api.deepseek.com/v1/models",
  fireworks: "https://api.fireworks.ai/inference/v1/models",
  xai: "https://api.x.ai/v1/models",
  huggingface: "https://router.huggingface.co/v1/models",
  lmstudio: null, // local; model list is whatever the user loaded
  ollama: null, // local; native /api/tags, not part of the curated catalog
  ...Object.fromEntries(
    Object.entries(EXTENDED_PROVIDERS).map(([id, entry]) => [
      id,
      // A provider validated via /chat/completions has no /models surface.
      entry.runtime.validatePath === "/chat/completions"
        ? null
        : `${entry.runtime.baseUrl}/models`,
    ]),
  ),
} as Record<ProviderId, string | null>;

interface Drift {
  provider: ProviderId;
  status: "ok" | "no-key" | "no-endpoint" | "error";
  error?: string;
  /** Curated ids the live API no longer lists (stale — retire or re-verify). */
  missingLive: string[];
  /** Live ids not curated (candidates — verify flags before promoting). */
  uncurated: string[];
  liveCount: number;
}

async function fetchLiveModels(
  id: ProviderId,
  url: string,
  key: string,
): Promise<string[]> {
  const isGemini = id === "gemini";
  const target = isGemini ? `${url}?key=${encodeURIComponent(key)}&pageSize=200` : url;
  const res = await fetch(target, {
    headers: isGemini ? {} : { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{ id?: string }>;
    models?: Array<{ name?: string }>;
  };
  if (isGemini) {
    return (body.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
  }
  return (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
}

async function checkProvider(id: ProviderId): Promise<Drift> {
  const curated = MODEL_CATALOG.filter((m) => m.provider === id).map((m) => m.id);
  const base: Drift = {
    provider: id,
    status: "ok",
    missingLive: [],
    uncurated: [],
    liveCount: 0,
  };
  const url = MODELS_ENDPOINTS[id];
  if (!url) return { ...base, status: "no-endpoint" };
  const key = (await getKey(id)) ?? process.env[`${id.toUpperCase()}_API_KEY`] ?? null;
  if (!key) return { ...base, status: "no-key" };
  try {
    const live = await fetchLiveModels(id, url, key);
    const liveSet = new Set(live);
    return {
      ...base,
      liveCount: live.length,
      missingLive: curated.filter((m) => !liveSet.has(m)),
      // Report only a bounded, sorted sample — some providers list hundreds.
      uncurated: live.filter((m) => !curated.includes(m)).sort().slice(0, 25),
    };
  } catch (err) {
    return {
      ...base,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const requested = args.filter((a) => a !== "--json");
for (const r of requested) {
  if (!isProviderId(r)) {
    console.error(`Unknown provider: ${r}`);
    process.exit(2);
  }
}
const targets = (requested.length ? requested : [...PROVIDER_IDS]) as ProviderId[];

const results = await Promise.all(targets.map(checkProvider));

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  let drift = 0;
  for (const r of results) {
    if (r.status === "no-endpoint") {
      console.log(`— ${r.provider}: skipped (no /models surface)`);
      continue;
    }
    if (r.status === "no-key") {
      console.log(`— ${r.provider}: skipped (no key in keychain or ${r.provider.toUpperCase()}_API_KEY)`);
      continue;
    }
    if (r.status === "error") {
      console.log(`✗ ${r.provider}: ${r.error}`);
      continue;
    }
    const stale = r.missingLive.length;
    drift += stale;
    console.log(
      `✓ ${r.provider}: ${r.liveCount} live models · ` +
        `${stale ? `STALE curated ids: ${r.missingLive.join(", ")}` : "curated ids all live"}` +
        (r.uncurated.length ? ` · ${r.uncurated.length}+ uncurated (sample: ${r.uncurated.slice(0, 5).join(", ")})` : ""),
    );
  }
  console.log(
    drift
      ? `\n${drift} curated id(s) no longer served — re-verify or retire them in catalog.ts / manifest.ts.`
      : "\nNo stale curated ids among keyed providers.",
  );
  // Stale curated ids are a real catalog bug; uncurated live models are not.
  process.exit(drift ? 1 : 0);
}
