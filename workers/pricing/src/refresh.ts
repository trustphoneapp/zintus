import {
  BUNDLED_SNAPSHOT,
  diffSnapshots,
  validateSnapshot,
  type ModelRates,
  type PriceSnapshot,
  type RateMove,
  type SnapshotDiff,
} from "@zintus/burn";

/**
 * The refresh pipeline, as pure logic over an injected KV.
 *
 * Design rule (do not weaken): rates are NEVER auto-scraped into billing.
 * Proposed rates come from a human-maintained JSON source (or the bundled
 * snapshot); this pipeline versions, validates, diffs, and — when any rate
 * moved >= the alert threshold — BLOCKS publication until a human forces it.
 * A scraper bug and a real 30% provider hike look identical to a ledger, so
 * both get eyes before they change what users are charged.
 */

/** Minimal KV surface, injectable for tests. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export const KV_CURRENT = "price-table:current";
export const KV_PENDING = "price-table:pending";
export const KV_LAST_REPORT = "price-table:last-report";
export const kvHistoryKey = (version: number): string => `price-table:v${version}`;

export interface RefreshReport {
  outcome: "published" | "blocked_by_alerts" | "unchanged" | "invalid";
  /** Version published, or the pending candidate's version when blocked. */
  version: number;
  generatedAt: string;
  moves: RateMove[];
  alerts: RateMove[];
  added: SnapshotDiff["added"];
  removed: SnapshotDiff["removed"];
  /** validateSnapshot problems when outcome === "invalid". */
  problems: string[];
  forced: boolean;
}

/** Read the currently published snapshot, falling back to the bundled one. */
export async function readCurrentSnapshot(kv: KvLike): Promise<PriceSnapshot> {
  const raw = await kv.get(KV_CURRENT);
  if (!raw) {
    return BUNDLED_SNAPSHOT;
  }
  try {
    const parsed = JSON.parse(raw) as PriceSnapshot;
    return validateSnapshot(parsed).length === 0 ? parsed : BUNDLED_SNAPSHOT;
  } catch {
    return BUNDLED_SNAPSHOT;
  }
}

export interface RefreshOptions {
  kv: KvLike;
  /** Proposed rates (from PRICE_SOURCE_URL or the bundled snapshot). */
  proposedRates: readonly ModelRates[];
  /** Publish even when alerts fire (human approval path). */
  force?: boolean;
  now?: () => Date;
}

/**
 * Run one refresh: build a candidate snapshot from the proposed rates,
 * validate, diff against current, and publish / block / no-op accordingly.
 * Every outcome writes KV_LAST_REPORT; published versions also write an
 * immutable history entry so any receipt's `snapshotVersion` stays auditable.
 */
export async function refresh(options: RefreshOptions): Promise<RefreshReport> {
  const { kv, proposedRates, force = false } = options;
  const now = options.now?.() ?? new Date();
  const current = await readCurrentSnapshot(kv);

  const candidate: PriceSnapshot = {
    version: current.version + 1,
    generatedAt: now.toISOString(),
    rates: proposedRates,
  };

  const problems = validateSnapshot(candidate);
  if (problems.length > 0) {
    const report: RefreshReport = {
      outcome: "invalid",
      version: current.version,
      generatedAt: now.toISOString(),
      moves: [],
      alerts: [],
      added: [],
      removed: [],
      problems,
      forced: force,
    };
    await kv.put(KV_LAST_REPORT, JSON.stringify(report));
    return report;
  }

  const diff = diffSnapshots(current, candidate);
  const changed =
    diff.moves.length > 0 || diff.added.length > 0 || diff.removed.length > 0;

  if (!changed) {
    const report: RefreshReport = {
      outcome: "unchanged",
      version: current.version,
      generatedAt: now.toISOString(),
      moves: [],
      alerts: [],
      added: [],
      removed: [],
      problems: [],
      forced: force,
    };
    await kv.put(KV_LAST_REPORT, JSON.stringify(report));
    return report;
  }

  if (diff.alerts.length > 0 && !force) {
    await kv.put(KV_PENDING, JSON.stringify(candidate));
    const report: RefreshReport = {
      outcome: "blocked_by_alerts",
      version: candidate.version,
      generatedAt: now.toISOString(),
      moves: diff.moves,
      alerts: diff.alerts,
      added: diff.added,
      removed: diff.removed,
      problems: [],
      forced: false,
    };
    await kv.put(KV_LAST_REPORT, JSON.stringify(report));
    return report;
  }

  await kv.put(KV_CURRENT, JSON.stringify(candidate));
  await kv.put(kvHistoryKey(candidate.version), JSON.stringify(candidate));
  const report: RefreshReport = {
    outcome: "published",
    version: candidate.version,
    generatedAt: now.toISOString(),
    moves: diff.moves,
    alerts: diff.alerts,
    added: diff.added,
    removed: diff.removed,
    problems: [],
    forced: force,
  };
  await kv.put(KV_LAST_REPORT, JSON.stringify(report));
  return report;
}

// ── OpenRouter cross-check ─────────────────────────────────────────────────
// OpenRouter's public /api/v1/models is machine-readable market pricing. It is
// NOT billing truth for non-OpenRouter routes (their marketplace price is not
// Groq's or DeepSeek's first-party price), so drift here only WARNS — it never
// edits a snapshot.

/** One OpenRouter model entry (fields we read). Prices are USD per TOKEN. */
export interface OpenRouterModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
}

/** Map our (provider, model) routes to OpenRouter model ids for cross-check. */
export const OPENROUTER_CROSSCHECK_MAP: Readonly<Record<string, string>> = {
  "deepseek/deepseek-chat": "deepseek/deepseek-chat",
  "mistral/mistral-large-latest": "mistralai/mistral-large",
  "cohere/command-r-plus-08-2024": "cohere/command-r-plus-08-2024",
  "xai/grok-2-latest": "x-ai/grok-2-1212",
  "openrouter/meta-llama/llama-3.3-70b-instruct:free":
    "meta-llama/llama-3.3-70b-instruct:free",
};

export interface DriftWarning {
  provider: string;
  model: string;
  openrouterId: string;
  field: "inPer1M" | "outPer1M";
  ours: number;
  market: number;
  /** |market − ours| / max(ours, tiny) — fractional drift. */
  drift: number;
}

/** Fractional our-price-vs-market divergence that raises a warning. */
export const DRIFT_WARN_THRESHOLD = 0.25;

/**
 * Compare a snapshot against OpenRouter market prices for the mapped routes.
 * Returns warnings only — see the module comment for why this never mutates.
 */
export function crossCheckOpenRouter(
  snapshot: PriceSnapshot,
  models: readonly OpenRouterModel[],
  threshold: number = DRIFT_WARN_THRESHOLD,
): DriftWarning[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const warnings: DriftWarning[] = [];

  for (const rate of snapshot.rates) {
    const mapped = OPENROUTER_CROSSCHECK_MAP[`${rate.provider}/${rate.model}`];
    if (!mapped) {
      continue;
    }
    const market = byId.get(mapped);
    if (!market?.pricing) {
      continue;
    }
    const marketIn = perTokenToPer1M(market.pricing.prompt);
    const marketOut = perTokenToPer1M(market.pricing.completion);
    if (marketIn !== null) {
      pushDrift(warnings, rate, mapped, "inPer1M", rate.inPer1M, marketIn, threshold);
    }
    if (marketOut !== null) {
      pushDrift(warnings, rate, mapped, "outPer1M", rate.outPer1M, marketOut, threshold);
    }
  }
  return warnings;
}

function perTokenToPer1M(perToken: string | undefined): number | null {
  if (perToken === undefined) {
    return null;
  }
  const parsed = Number.parseFloat(perToken);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : null;
}

function pushDrift(
  warnings: DriftWarning[],
  rate: PriceSnapshot["rates"][number],
  openrouterId: string,
  field: DriftWarning["field"],
  ours: number,
  market: number,
  threshold: number,
): void {
  if (ours === market) {
    return;
  }
  // Both zero-vs-nonzero and plain divergence use the larger side as the base
  // so a free route gaining a market price still reports finite drift.
  const base = Math.max(ours, market);
  if (base === 0) {
    return;
  }
  const drift = Math.abs(market - ours) / base;
  if (drift >= threshold) {
    warnings.push({
      provider: rate.provider,
      model: rate.model,
      openrouterId,
      field,
      ours,
      market,
      drift,
    });
  }
}
