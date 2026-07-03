import type { ProviderId } from "@zintus/types";

/**
 * BILLING-GRADE price table types.
 *
 * This is the counterpart to `@zintus/providers`' static `pricing.ts` catalog,
 * with the OPPOSITE truth standard: `pricing.ts` is display-only reference data
 * ("NOT BILLING TRUTH", guarded out of money paths by
 * `pricing-billing-guard.test.ts`), while a `PriceSnapshot` here IS what burn
 * metering charges against. The two are intentionally separate tables — an
 * estimate must never silently become a charge, and a charge must never be
 * sourced from an unversioned estimate.
 *
 * Snapshots are versioned and immutable: every burn receipt records the
 * snapshot version it was priced at, so any charge can be reconciled against
 * the exact rates in force when it happened.
 */

/**
 * Cost/capability class of a model. Drives the PUBLIC markup multiplier and
 * tier gating — see `markup.ts`. Classes, not per-model hand-tuning.
 *
 *  - "free":     zero-rate routes (local runtimes, `:free` marketplace routes)
 *  - "cheap":    commodity open/small models (Llama, Flash-class, DeepSeek)
 *  - "mid":      workhorse lab models (Sonnet/large-mistral class)
 *  - "frontier": flagship lab models (Opus/GPT-5.5 class)
 *  - "ultra":    premium-priced flagships (GPT-5.5 Pro / Fable class)
 */
export type ModelClass = "free" | "cheap" | "mid" | "frontier" | "ultra";

export const MODEL_CLASSES: readonly ModelClass[] = [
  "free",
  "cheap",
  "mid",
  "frontier",
  "ultra",
];

/** Billing-grade rates for one (provider, model) route. USD per 1M tokens. */
export interface ModelRates {
  provider: ProviderId;
  /** Model id exactly as passed to the provider API. */
  model: string;
  class: ModelClass;
  /** USD per 1M input (prompt) tokens. */
  inPer1M: number;
  /** USD per 1M output (completion) tokens. Reasoning tokens bill at this rate. */
  outPer1M: number;
  /** USD per 1M prompt-cache READ tokens. Absent → billed at `inPer1M`
   *  (conservative: never undercharges when a provider's discount is unknown). */
  cacheReadPer1M?: number;
  /** USD per 1M prompt-cache WRITE tokens. Absent → billed at `inPer1M`. */
  cacheWritePer1M?: number;
  /** ISO date (YYYY-MM-DD) this rate was last verified against `source`. */
  updatedAt: string;
  /** First-party pricing page this rate was read from. */
  source: string;
}

/** A versioned, immutable price table. */
export interface PriceSnapshot {
  /** Monotonically increasing integer. Burn receipts record this. */
  version: number;
  /** ISO timestamp the snapshot was generated. */
  generatedAt: string;
  rates: readonly ModelRates[];
}

/** One rate movement between two snapshots. */
export interface RateMove {
  provider: ProviderId;
  model: string;
  field: "inPer1M" | "outPer1M" | "cacheReadPer1M" | "cacheWritePer1M";
  prev: number;
  next: number;
  /** Signed fractional change, e.g. +0.5 = 50% increase. Infinity when prev=0. */
  pctChange: number;
}

/** Result of diffing two snapshots (drives the >10%-move alert). */
export interface SnapshotDiff {
  moves: RateMove[];
  /** Moves whose |pctChange| meets/exceeds the alert threshold. */
  alerts: RateMove[];
  added: Array<{ provider: ProviderId; model: string }>;
  removed: Array<{ provider: ProviderId; model: string }>;
}

/** Fractional move that triggers a pricing alert (0.10 = 10%). */
export const RATE_ALERT_THRESHOLD = 0.1;

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Structural validation for a snapshot before it is trusted for burn.
 * Returns a list of human-readable problems; empty means valid.
 */
export function validateSnapshot(snapshot: PriceSnapshot): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
    problems.push(`version must be a positive integer, got ${snapshot.version}`);
  }
  if (Number.isNaN(Date.parse(snapshot.generatedAt))) {
    problems.push(`generatedAt is not a parseable timestamp: ${snapshot.generatedAt}`);
  }
  if (snapshot.rates.length === 0) {
    problems.push("rates is empty");
  }
  const seen = new Set<string>();
  for (const rate of snapshot.rates) {
    const key = `${rate.provider}/${rate.model}`;
    if (seen.has(key)) {
      problems.push(`duplicate rate entry: ${key}`);
    }
    seen.add(key);
    if (!rate.model) {
      problems.push(`empty model id under provider ${rate.provider}`);
    }
    if (!MODEL_CLASSES.includes(rate.class)) {
      problems.push(`${key}: unknown class ${String(rate.class)}`);
    }
    if (!isFiniteNonNegative(rate.inPer1M)) {
      problems.push(`${key}: inPer1M must be a finite number >= 0`);
    }
    if (!isFiniteNonNegative(rate.outPer1M)) {
      problems.push(`${key}: outPer1M must be a finite number >= 0`);
    }
    if (rate.cacheReadPer1M !== undefined && !isFiniteNonNegative(rate.cacheReadPer1M)) {
      problems.push(`${key}: cacheReadPer1M must be a finite number >= 0`);
    }
    if (rate.cacheWritePer1M !== undefined && !isFiniteNonNegative(rate.cacheWritePer1M)) {
      problems.push(`${key}: cacheWritePer1M must be a finite number >= 0`);
    }
    if (Number.isNaN(Date.parse(rate.updatedAt))) {
      problems.push(`${key}: updatedAt is not a parseable date: ${rate.updatedAt}`);
    }
  }
  return problems;
}

/** Look up the rates for a (provider, model) pair, or null when unlisted. */
export function findRates(
  snapshot: PriceSnapshot,
  provider: ProviderId,
  model: string,
): ModelRates | null {
  return (
    snapshot.rates.find((r) => r.provider === provider && r.model === model) ??
    null
  );
}

const DIFF_FIELDS = [
  "inPer1M",
  "outPer1M",
  "cacheReadPer1M",
  "cacheWritePer1M",
] as const;

/**
 * Diff two snapshots: every changed rate, plus added/removed routes.
 * `alerts` holds moves at/above `threshold` (default {@link RATE_ALERT_THRESHOLD})
 * — the pricing worker refuses to auto-publish a snapshot with alerts unless
 * explicitly forced, so a scraping bug or a real >10% provider move always
 * gets a human look before it changes what users are charged.
 */
export function diffSnapshots(
  prev: PriceSnapshot,
  next: PriceSnapshot,
  threshold: number = RATE_ALERT_THRESHOLD,
): SnapshotDiff {
  const moves: RateMove[] = [];
  const added: SnapshotDiff["added"] = [];
  const removed: SnapshotDiff["removed"] = [];

  const prevByKey = new Map(prev.rates.map((r) => [`${r.provider}/${r.model}`, r]));
  const nextByKey = new Map(next.rates.map((r) => [`${r.provider}/${r.model}`, r]));

  for (const [key, nextRate] of nextByKey) {
    const prevRate = prevByKey.get(key);
    if (!prevRate) {
      added.push({ provider: nextRate.provider, model: nextRate.model });
      continue;
    }
    for (const field of DIFF_FIELDS) {
      const before = prevRate[field];
      const after = nextRate[field];
      if (before === after) {
        continue;
      }
      // A cache field appearing/disappearing is a change from/to the implicit
      // input-rate fallback — compare against that real billed value.
      const prevBilled = before ?? prevRate.inPer1M;
      const nextBilled = after ?? nextRate.inPer1M;
      if (prevBilled === nextBilled) {
        continue;
      }
      moves.push({
        provider: nextRate.provider,
        model: nextRate.model,
        field,
        prev: prevBilled,
        next: nextBilled,
        pctChange:
          prevBilled === 0
            ? Number.POSITIVE_INFINITY
            : (nextBilled - prevBilled) / prevBilled,
      });
    }
  }

  for (const [key, prevRate] of prevByKey) {
    if (!nextByKey.has(key)) {
      removed.push({ provider: prevRate.provider, model: prevRate.model });
    }
  }

  const alerts = moves.filter((m) => Math.abs(m.pctChange) >= threshold);
  return { moves, alerts, added, removed };
}
