import { getModelPricing, listProviders } from "@zintus/providers";
import type { ProviderId } from "@zintus/types";
import type { LocalRuntimes } from "./local-runtimes.js";

/**
 * BYOK-only quota-exhaustion decision logic, extracted from the /v1/route/
 * options handler so the CLI (which runs the engine in-process and never sees
 * the HTTP route) computes THE SAME answer — matrix #14 without forking the
 * decision rules. Pure: all inputs are passed in, nothing is fetched.
 *
 * Honesty invariants carried over verbatim:
 * - quotaRemaining prefers the server ledger (keyed providers), falls back to
 *   the caller's hint, else null — never fabricated.
 * - resetIn comes ONLY from a tracked cooldownUntil; daily quotas reset lazily
 *   at the UTC boundary so we report null + a reason, never a made-up time.
 * - There is intentionally NO use_credits / paid-overflow option.
 */

/** BYOK-only fallback actions when a provider's quota is low/exhausted. */
export type RouteOption =
  | "compress_harder"
  | "switch_provider"
  | "use_local"
  | "wait";

/** Below this remaining ratio a provider is treated as quota-constrained. */
export const LOW_QUOTA_THRESHOLD = 0.2;

/** The slice of engine.getProviderStatus() rows this decision consumes. */
export interface RouteOptionsProviderStatus {
  id: ProviderId;
  name: string;
  available: boolean;
  hasKey: boolean;
  inCooldown: boolean;
  cooldownUntil: Date | null;
}

export interface RouteOptionsInputs {
  provider: ProviderId;
  statuses: RouteOptionsProviderStatus[];
  /** Ledger remaining ratio 0..1 for `provider` — null when it has no key
   *  (the ledger doesn't genuinely track it). */
  ledgerQuotaRemaining: number | null;
  /** Optional client-supplied remaining ratio 0..1 (already validated). */
  clientHint?: number | null;
  runtimes: LocalRuntimes;
  /** Injectable clock for tests. */
  now?: number;
}

export interface RouteOptionsResult {
  provider: ProviderId;
  quotaRemaining: number | null;
  resetIn: number | null;
  resetReason?: string;
  best: RouteOption;
  options: RouteOption[];
  reason: string;
  alternatives: Array<{
    provider: ProviderId;
    model: string;
    estInputPer1M: number;
    estOutputPer1M: number;
  }>;
  localAvailable: boolean;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function computeRouteOptions(inputs: RouteOptionsInputs): RouteOptionsResult {
  const { provider, statuses, runtimes } = inputs;
  const now = inputs.now ?? Date.now();
  const known = listProviders();
  const self = statuses.find((s) => s.id === provider);

  const serverQuota =
    inputs.ledgerQuotaRemaining != null ? clamp01(inputs.ledgerQuotaRemaining) : null;
  const quotaRemaining = serverQuota ?? inputs.clientHint ?? null;
  const effectiveQuota = quotaRemaining ?? 1;

  // resetIn: ONLY from the ledger's tracked cooldownUntil (real 429/reset
  // header or router backoff); otherwise null + reason (HARD rule #3).
  let resetIn: number | null = null;
  let resetReason: string | undefined;
  const cooldownUntilMs = self?.cooldownUntil ? self.cooldownUntil.getTime() : null;
  if (cooldownUntilMs != null && cooldownUntilMs > now) {
    resetIn = Math.ceil((cooldownUntilMs - now) / 1000);
  } else {
    resetReason = "Reset time unavailable";
  }

  const localAvailable = runtimes.ollama.detected || runtimes.lmstudio.detected;

  // alternatives: cheapest HEALTHY cloud BYOK providers, ESTIMATES ONLY (from
  // the static pricing catalog). Excludes the target and the local runtimes.
  const defaultModelById = new Map(known.map((p) => [p.id, p.defaultModel]));
  const alternatives = statuses
    .filter(
      (s) =>
        s.id !== provider && s.available && s.id !== "ollama" && s.id !== "lmstudio",
    )
    .map((s) => {
      const model = defaultModelById.get(s.id) ?? "";
      const pricing = getModelPricing(s.id, model);
      return pricing
        ? {
            provider: s.id,
            model,
            estInputPer1M: pricing.inputPer1M,
            estOutputPer1M: pricing.outputPer1M,
          }
        : null;
    })
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .sort(
      (a, b) => a.estInputPer1M + a.estOutputPer1M - (b.estInputPer1M + b.estOutputPer1M),
    );

  // Is the cheapest healthy alternative actually cheaper than staying put?
  const selfModel = defaultModelById.get(provider) ?? "";
  const selfPricing = getModelPricing(provider, selfModel);
  const selfCost = selfPricing
    ? selfPricing.inputPer1M + selfPricing.outputPer1M
    : Number.POSITIVE_INFINITY;
  const cheapest = alternatives[0];
  const cheaperAltExists =
    cheapest != null && cheapest.estInputPer1M + cheapest.estOutputPer1M <= selfCost;

  // Options offered — BYOK ONLY (no use_credits/paid/overflow, ever).
  const options: RouteOption[] = ["compress_harder"];
  if (alternatives.length > 0) options.push("switch_provider");
  if (localAvailable) options.push("use_local");
  options.push("wait");

  const knownSelf = known.find((p) => p.id === provider);
  const name = self?.name ?? knownSelf?.name ?? provider;
  const low = effectiveQuota <= LOW_QUOTA_THRESHOLD;
  const exhausted = effectiveQuota <= 0 || self?.inCooldown === true;

  let best: RouteOption;
  let reason: string;
  if (!low) {
    best = "compress_harder";
    reason = `${name} quota is healthy; compress harder to conserve your free-tier budget`;
  } else if (alternatives.length > 0) {
    best = "switch_provider";
    reason = cheaperAltExists
      ? `${name} quota low; a cheaper healthy provider is available`
      : `${name} quota low; another healthy provider is available`;
  } else if (localAvailable) {
    best = "use_local";
    reason = `${name} quota low; a local runtime is available to take over at no API cost`;
  } else if (exhausted) {
    best = "wait";
    reason =
      resetIn != null
        ? `${name} is exhausted with no healthy alternatives; wait ~${resetIn}s for it to reset`
        : `${name} is exhausted and no healthy alternatives are available; wait for quota to recover`;
  } else {
    best = "compress_harder";
    reason = `${name} quota low; compress harder to stretch the remaining budget`;
  }

  return {
    provider,
    quotaRemaining,
    resetIn,
    ...(resetReason ? { resetReason } : {}),
    best,
    options,
    reason,
    alternatives,
    localAvailable,
  };
}
