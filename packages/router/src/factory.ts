import { homedir } from "node:os";
import { join } from "node:path";
import type {
  PolicyConfig,
  PolicyLimits,
  Provider,
  ProviderId,
  ProviderStatus,
  RouteRequest,
  RouteStreamResult,
  RoutingStrategy,
  ToolCallContentBlock,
} from "@zintus/types";
import {
  estimateUsage,
  listProviders,
  mayTrainOnUserData,
  ProviderHttpError,
} from "@zintus/providers";
import { supportsVision, supportsTools, structuredOutputLevel } from "@zintus/providers";
import {
  requiresVision,
  requiresTools,
  requiresGuaranteedSchema,
} from "@zintus/types";
import type { ResponseFormat, ResolvedResponseFormat } from "@zintus/types";

/** Resolve the caller's `ResponseFormat` to the strongest level a given
 *  provider+model can actually serve. Returns undefined for a text/absent request.
 *  `json_schema` request → json_schema if the model guarantees it, else json_object
 *  if it has json-mode, else prompt (emulated). `json_object` request → json_object
 *  unless the model has no native JSON mode (then prompt). The schema rides along
 *  for json_schema and prompt so the engine can validate/coerce. */
function resolveResponseFormat(
  rf: ResponseFormat | undefined,
  providerId: ProviderId,
  model: string,
): ResolvedResponseFormat | undefined {
  if (!rf || rf.type === "text") return undefined;
  const providerLevel = structuredOutputLevel(providerId, model);
  const name = rf.name ?? "response";
  let level: ResolvedResponseFormat["level"];
  if (rf.type === "json_schema") {
    level =
      providerLevel === "json_schema"
        ? "json_schema"
        : providerLevel === "json_object"
          ? "json_object"
          : "prompt";
  } else {
    level = providerLevel === "none" ? "prompt" : "json_object";
  }
  return { level, schema: rf.schema, name };
}
import type { TokenUsage } from "@zintus/types";
import { isInCooldown } from "./cooldown.js";
import { redactSecrets } from "./redact.js";
import { InFlightReservations } from "./inflight.js";
import { sortProviders } from "./priority.js";
import { QuotaLedger } from "./quota-ledger.js";
import {
  GROQ_MODEL_70B,
  GROQ_MODEL_8B,
  paidEquivalentUsdPerMTok,
} from "./limits.js";

export interface RouteAttemptEvent {
  providerId: ProviderId;
  model: string;
  status: "success" | "fail";
  latencyMs: number;
  errorCode?: number;
  errorMessage?: string;
}

export interface RouterConfig {
  dbPath?: string;
  strategy?: RoutingStrategy | "weighted";
  providerPriority?: ProviderId[];
  defaultProvider?: ProviderId;
  getApiKey?: (providerId: ProviderId) => Promise<string | null>;
  /**
   * BYOK fallback keys: the ORDERED key list (primary first) for a provider. When
   * supplied, the router tries the next key on a pre-stream AUTH failure (401/403)
   * before abandoning the provider. Defaults to wrapping {@link getApiKey} as a
   * 0/1-element list, so existing single-key construction is unchanged.
   */
  getApiKeys?: (providerId: ProviderId) => Promise<string[]>;
  onAttempt?: (event: RouteAttemptEvent) => void;
  providerWeights?: Record<ProviderId, number>;
  virtualKey?: string;
  /**
   * Declarative policy (model groups, weights, limits, fallbacks). Explicit
   * top-level config fields take precedence over the same field in `policy`.
   */
  policy?: PolicyConfig;
  /** Logical model -> ordered provider list for same-model failover. */
  modelGroups?: Record<string, ProviderId[]>;
  /** Fallback actions on 429 / 5xx. Defaults to next_provider for both. */
  fallbacks?: PolicyConfig["fallbacks"];
  /** Per-provider quota limit overrides (forwarded to the ledger). */
  limits?: Partial<Record<ProviderId, PolicyLimits>>;
  /**
   * Output-token budget reserved up-front for a request that sets NO explicit
   * `maxTokens`. Defaults to {@link DEFAULT_OUTPUT_RESERVE_TOKENS}. A caller's
   * explicit `maxTokens` is always honored EXACTLY and is unaffected by this.
   */
  outputReserveTokens?: number;
}

/** A provider with a recent error streak this large is treated as unhealthy. */
const ERROR_STREAK_THRESHOLD = 3;
const ERROR_STREAK_WINDOW_MS = 5 * 60_000;

/**
 * Honest, MEASURED per-provider stats for the public `/v1/models` feed. Every
 * metric is `null` when there are too few samples to be truthful (see
 * {@link QuotaLedger.recentStats}). Never a fabricated 0 or guess.
 */
export interface ProviderStats {
  /** p95 latency (ms) over recent successes; null when < minSamples. */
  latencyP95Ms: number | null;
  /** successes / total attempts (0..1); null when < minSamples attempts. */
  successRate: number | null;
  /** median output tokens/sec; null when < minSamples rows recorded both. */
  throughputTps: number | null;
  /** total attempts observed in the recent window (0 when none). */
  samples: number;
}

export interface SavingsReport {
  /** Estimated USD avoided per provider by serving free-tier tokens. */
  byProvider: Record<string, number>;
  /** Total estimated USD avoided across all providers. */
  total: number;
}

export interface Router {
  routeAndStream(request: RouteRequest): Promise<RouteStreamResult>;
  getProviderStatus(): Promise<ProviderStatus[]>;
  /** Estimated "provable savings": $ a paid API would have charged for the
   *  free-tier tokens served. An estimate (see PAID_EQUIVALENT_USD_PER_MTOK). */
  getSavings(): SavingsReport;
  /** Re-apply a policy at runtime (policy.json hot-reload). Explicit config
   *  fields passed at construction still take precedence. */
  updatePolicy(policy: PolicyConfig): void;
  /** Background health probe: validate each keyed provider's key and record a
   *  failure (feeding health-aware routing) when a provider is unreachable. */
  probeProviders(): Promise<Array<{ providerId: ProviderId; ok: boolean }>>;
  /** Remaining free-tier quota ratio (0..1) for a provider — the tightest of
   *  the daily budget and the rolling-minute window, the latter INCLUDING
   *  currently in-flight reservations. Feeds Tokzen's quota-aware compression
   *  dial (replaces the previously-hardcoded 1.0). */
  getQuotaRemaining(provider: ProviderId): number;
  /** Honest, MEASURED per-provider stats (p95 latency, success-rate,
   *  throughput) over a recent window, for the public `/v1/models` feed. Metrics
   *  are null when there are too few samples to be truthful. Optional so
   *  lightweight Router fakes (e.g. memory/test stubs) need not implement it; the
   *  real `createRouter` always provides it. */
  getProviderStats?(provider: ProviderId): ProviderStats;
}

const DEFAULT_DB_PATH = join(homedir(), ".zintus", "quota.db");
const OPENROUTER_FREE_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-7b-instruct:free",
] as const;

/**
 * Default output-token budget reserved up-front for a request with NO explicit
 * `maxTokens`. The pre-dispatch reservation gate (inflight.ts) has to estimate a
 * request's output BEFORE the model has produced a single token. The old fixed
 * 1024 UNDER-counted any substantive completion, so a concurrent burst of
 * unbounded requests could overshoot a provider's `tokensPerMinute` cap by
 * `(actual − 1024) × concurrency` before `recordUsage` reconciled it — real for
 * TPM-bound providers (Cerebras / Mistral / DeepSeek).
 *
 * 4096 covers the bulk of real completions for the free-tier chat models Zintus
 * routes to, while staying a small fraction of any realistic per-minute token cap
 * so it does not needlessly reject admissions (throttle throughput). It is NOT
 * the model's context window — that (64k–1M, see capabilities.ts `contextWindow`)
 * is input+output capacity, not an output cap, and reserving it would over-count
 * by orders of magnitude and starve the gate. `recordUsage` still reconciles the
 * reservation against real usage on completion (briefly double-counting, the safe
 * direction), so this only has to SHRINK the under-reserve window, not erase it.
 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 4096;

/**
 * Output tokens to reserve for one request before dispatch. A positive explicit
 * `maxTokens` is honored EXACTLY (the caller capped their own output); a
 * non-positive or unset `maxTokens` counts as "no cap given" and falls back to
 * `defaultReserve`.
 */
export function reservedOutputTokens(
  maxTokens: number | undefined,
  defaultReserve: number = DEFAULT_OUTPUT_RESERVE_TOKENS,
): number {
  return maxTokens && maxTokens > 0 ? maxTokens : defaultReserve;
}

export function createRouter(config: RouterConfig = {}): Router {
  const strategy = config.strategy ?? "fastest";

  // Policy-derived values are mutable so policy.json hot-reload (updatePolicy)
  // re-applies them live. Explicit top-level config always wins over policy.
  let providerPriority: ProviderId[] | undefined;
  let providerWeights: Partial<Record<ProviderId, number>> | undefined;
  let modelGroups: Record<string, ProviderId[]>;
  let on429: "next_provider" | "fail";
  let on5xx: "next_provider" | "fail";

  const ledger = new QuotaLedger(
    config.dbPath ?? DEFAULT_DB_PATH,
    config.limits ?? config.policy?.limits,
  );

  function applyPolicy(policy: PolicyConfig): void {
    providerPriority = config.providerPriority ?? policy.providerPriority;
    providerWeights = config.providerWeights ?? policy.providerWeights;
    modelGroups = config.modelGroups ?? policy.modelGroups ?? {};
    const fallbacks = config.fallbacks ?? policy.fallbacks;
    on429 = fallbacks?.on_429 ?? "next_provider";
    on5xx = fallbacks?.on_5xx ?? "next_provider";
    ledger.setLimits(config.limits ?? policy.limits);
  }

  applyPolicy(config.policy ?? {});
  const resolveKey =
    config.getApiKey ??
    (async (providerId: ProviderId) => {
      if (providerId === "ollama" || providerId === "lmstudio") {
        return null;
      }
      return null;
    });
  // Ordered BYOK keys (primary first). Defaults to wrapping resolveKey as a
  // 0/1-element list so a router built with only `getApiKey` behaves exactly as
  // before (single-key path, one streamChat attempt).
  const resolveKeys =
    config.getApiKeys ??
    (async (providerId: ProviderId) => {
      const k = await resolveKey(providerId);
      return k ? [k] : [];
    });

  const cooldownRetries = new Map<ProviderId, number>();
  const stickySessions = new Map<string, ProviderId>();
  // Circuit-breaker half-open gate. A provider with recent errors (recovering,
  // but still below ERROR_STREAK_THRESHOLD so it remains eligible) admits only
  // ONE in-flight probe at a time — a concurrent burst can't all rush a
  // provider that may still be down. Healthy providers (zero recent errors) are
  // never gated. Membership = "a probe is currently in flight to this provider".
  const halfOpenProbes = new Set<ProviderId>();

  // In-flight reservation tracker — closes the concurrent-overshoot race: the
  // ledger only records usage after a response drains, so a burst of concurrent
  // requests would otherwise all pass the pre-dispatch check before any of them
  // debits the counters. See inflight.ts.
  const reservations = new InFlightReservations();
  // Output budget reserved up-front when the caller sets no maxTokens. Higher
  // than the old fixed 1024 so a concurrent burst of unbounded requests can't
  // overshoot a provider's tokensPerMinute cap before recordUsage reconciles it
  // (see DEFAULT_OUTPUT_RESERVE_TOKENS). Overridable per-router via config.
  const outputReserveDefault =
    config.outputReserveTokens && config.outputReserveTokens > 0
      ? config.outputReserveTokens
      : DEFAULT_OUTPUT_RESERVE_TOKENS;

  /** Estimated tokens a request will consume (input estimate + output budget). */
  function estimateReserveTokens(request: RouteRequest): number {
    const { inputTokens } = estimateUsage(request.messages, "");
    return (
      inputTokens + reservedOutputTokens(request.maxTokens, outputReserveDefault)
    );
  }

  /**
   * Synchronous admit-or-reject for one dispatch against a provider, gating on
   * completed (daily + rolling 60s) usage plus currently in-flight reservations.
   * No `await` inside, so the read-decide-reserve is atomic on the event loop.
   */
  function tryReserveProvider(
    id: ProviderId,
    estTokens: number,
    now: number,
  ): boolean {
    const limits = ledger.getLimits(id);
    const row = ledger.maybeResetDailyCounters(id, now);
    const recent =
      limits.requestsPerMinute != null || limits.tokensPerMinute != null
        ? ledger.countRecentUsage(id, 60_000, now)
        : { requests: 0, tokens: 0 };
    return reservations.tryReserve(
      id,
      estTokens,
      {
        dailyRequests: row.requestsToday,
        dailyTokens: row.tokensToday,
        minuteRequests: recent.requests,
        minuteTokens: recent.tokens,
      },
      limits,
    );
  }

  // BYOK: a per-request key (provider -> key) takes precedence over the
  // gateway's configured key for this request only. Local providers need none.
  // Memoized per request so eligibility checks and the winning stream call
  // don't hit the OS keychain twice for the same provider.
  const keyResolutionCache = new WeakMap<
    RouteRequest,
    Map<ProviderId, Promise<string[]>>
  >();
  // Ordered keys to try for a provider on THIS request: the per-request BYOK key
  // (if any) takes precedence, then the keychain's ordered list (primary +
  // fallbacks), deduped, order preserved. Memoized per request so eligibility and
  // the winning stream call don't hit the OS keychain twice for one provider.
  function keysFor(
    providerId: ProviderId,
    request: RouteRequest,
  ): Promise<string[]> {
    let cache = keyResolutionCache.get(request);
    if (!cache) {
      cache = new Map();
      keyResolutionCache.set(request, cache);
    }
    let pending = cache.get(providerId);
    if (!pending) {
      pending = (async () => {
        const out: string[] = [];
        const requestKey = request.keys?.[providerId];
        if (requestKey) {
          out.push(requestKey);
        }
        for (const key of await resolveKeys(providerId)) {
          if (key) {
            out.push(key);
          }
        }
        return Array.from(new Set(out));
      })();
      cache.set(providerId, pending);
    }
    return pending;
  }
  // The primary key (eligibility + back-compat). Identical to the old keyFor: for
  // a request key it returns that; otherwise the first resolved key, else null.
  async function keyFor(
    providerId: ProviderId,
    request: RouteRequest,
  ): Promise<string | null> {
    return (await keysFor(providerId, request))[0] ?? null;
  }

  async function buildStatus(): Promise<ProviderStatus[]> {
    const now = Date.now();
    const allProviders = listProviders();

    return Promise.all(
      allProviders.map(async (provider: Provider) => {
        const row = ledger.maybeResetDailyCounters(provider.id, now);
        const limits = ledger.getLimits(provider.id);
        const apiKey = await resolveKey(provider.id);
        const hasKey =
          provider.id === "ollama" || provider.id === "lmstudio"
            ? true
            : Boolean(apiKey);
        const inCooldown = isInCooldown(row.cooldownUntil, now);
        const quotaAvailable = ledger.isQuotaAvailable(provider.id, now);

        return {
          id: provider.id,
          name: provider.name,
          color: provider.color,
          priority: provider.priority,
          hasKey,
          inCooldown,
          cooldownUntil:
            row.cooldownUntil != null ? new Date(row.cooldownUntil) : null,
          requestsToday: row.requestsToday,
          tokensToday: row.tokensToday,
          lastReset: row.lastReset != null ? new Date(row.lastReset) : null,
          requestsLimit: limits.requestsPerDay,
          tokensLimit: limits.tokensPerDay,
          available: hasKey && quotaAvailable && !inCooldown,
        };
      }),
    );
  }

  /**
   * Whether a provider can serve right now: has a key, has quota (daily +
   * rolling minute windows), is not in formal cooldown, and is not in a recent
   * error streak (health-aware routing — Phase 1.3).
   */
  async function isEligible(
    provider: Provider,
    now: number,
    request: RouteRequest,
  ): Promise<boolean> {
    const hasKey =
      provider.id === "ollama" || provider.id === "lmstudio"
        ? true
        : Boolean(await keyFor(provider.id, request));
    if (!hasKey) {
      return false;
    }
    if (!ledger.isQuotaAvailable(provider.id, now)) {
      return false;
    }
    if (
      isInCooldown(
        ledger.maybeResetDailyCounters(provider.id, now).cooldownUntil,
        now,
      )
    ) {
      return false;
    }
    if (
      ledger.recentErrorCount(provider.id, ERROR_STREAK_WINDOW_MS, now) >=
      ERROR_STREAK_THRESHOLD
    ) {
      return false;
    }
    return true;
  }

  async function selectCandidates(
    request: RouteRequest,
    groupOrder?: ProviderId[],
  ): Promise<Provider[]> {
    const allProviders = listProviders();
    const remainingRatio = (id: ProviderId) => ledger.remainingRatio(id);
    const latencyP95 = (id: ProviderId) => ledger.recentLatencyP95(id);

    if (request.provider) {
      const forced = allProviders.find(
        (provider: Provider) => provider.id === request.provider,
      );
      return forced ? [forced] : [];
    }

    const now = Date.now();
    // Per-request strategy override (e.g. a GUI strategy picker) falls back to
    // the router's configured default.
    const effStrategy = request.strategy ?? strategy;

    // Same-model multi-provider failover (Phase 1.2): a logical model maps to an
    // ordered provider list; we try them in that order, skipping ineligible ones
    // and cooling the whole group down only once every member has failed.
    if (groupOrder?.length) {
      const byId = new Map(allProviders.map((p) => [p.id, p]));
      const candidates: Provider[] = [];
      for (const id of groupOrder) {
        const provider = byId.get(id);
        if (provider && (await isEligible(provider, now, request))) {
          candidates.push(provider);
        }
      }
      return candidates;
    }

    const weightMap = request.providerWeights ?? providerWeights;

    if (effStrategy === "weighted" || weightMap) {
      const eligible: Provider[] = [];
      for (const provider of allProviders) {
        if (await isEligible(provider, now, request)) {
          eligible.push(provider);
        }
      }

      const scored = eligible.map((p) => {
        const w = weightMap?.[p.id] ?? 1;
        return {
          provider: p,
          score: w > 0 ? Math.random() ** (1 / w) : 0,
        };
      });
      return scored.sort((a, b) => b.score - a.score).map((s) => s.provider);
    }

    // economy ranks by the cost of the model each provider would actually serve
    // (the requested model, else the provider's default — which for Groq is the
    // 70B tier it tries first), so per-model anchors like Groq 8B vs 70B count.
    const defaultModelById = new Map(
      allProviders.map((p) => [p.id, p.defaultModel]),
    );
    const ordered = sortProviders(allProviders, effStrategy, {
      remainingRatio,
      providerPriority,
      latencyP95,
      costPerMillion: (id) =>
        paidEquivalentUsdPerMTok(id, request.model ?? defaultModelById.get(id)),
    });

    if (config.defaultProvider) {
      const preferred = ordered.find((p) => p.id === config.defaultProvider);
      if (preferred && (await isEligible(preferred, now, request))) {
        return [preferred];
      }
    }

    const candidates = [];
    for (const provider of ordered) {
      if (await isEligible(provider, now, request)) {
        candidates.push(provider);
      }
    }

    return candidates;
  }

  return {
    async getProviderStatus() {
      return buildStatus();
    },

    getSavings() {
      return ledger.savingsUsd();
    },

    getQuotaRemaining(provider) {
      const now = Date.now();
      // Daily budget remaining (0..1), the tightest of request/token ratios.
      const base = ledger.remainingRatio(provider, now);
      // Also factor rolling-minute pressure INCLUDING in-flight reservations, so
      // the signal drops during a burst before the daily counter would notice.
      const limits = ledger.getLimits(provider);
      const inflight = reservations.current(provider);
      let minuteRatio = 1;
      if (limits.requestsPerMinute != null) {
        const recent = ledger.countRecentUsage(provider, 60_000, now);
        const used = recent.requests + inflight.requests;
        minuteRatio = Math.max(0, 1 - used / limits.requestsPerMinute);
      }
      if (limits.tokensPerMinute != null) {
        const recent = ledger.countRecentUsage(provider, 60_000, now);
        const used = recent.tokens + inflight.tokens;
        minuteRatio = Math.min(
          minuteRatio,
          Math.max(0, 1 - used / limits.tokensPerMinute),
        );
      }
      return Math.max(0, Math.min(base, minuteRatio));
    },

    getProviderStats(provider) {
      return ledger.recentStats(provider);
    },

    updatePolicy(policy) {
      applyPolicy(policy);
    },

    async probeProviders() {
      const results: Array<{ providerId: ProviderId; ok: boolean }> = [];
      for (const provider of listProviders()) {
        // Local providers have no remote key to probe.
        if (provider.id === "ollama" || provider.id === "lmstudio") {
          continue;
        }
        const apiKey = await resolveKey(provider.id);
        if (!apiKey) {
          continue;
        }
        let ok = false;
        try {
          ok = await provider.validateKey(apiKey);
        } catch {
          ok = false;
        }
        if (!ok) {
          // Record a failure so recentErrorCount demotes this provider until it
          // recovers, exactly like a live request error would.
          ledger.recordUsage(provider.id, { status: "error" });
        }
        results.push({ providerId: provider.id, ok });
      }
      return results;
    },

    async routeAndStream(request) {
      const now = Date.now();
      const vKey = request.virtualKey ?? config.virtualKey;
      if (vKey) {
        if (!ledger.validateVirtualKey(vKey, now)) {
          throw new Error(`Virtual key quota or rate limit exceeded for key: ${vKey}`);
        }
      }

      // Same-model failover: if the requested model is a configured group, the
      // group's provider list drives candidate order and each provider serves
      // the model via its own default (the logical name is not sent upstream).
      const groupOrder = request.model ? modelGroups[request.model] : undefined;
      const groupActive = Boolean(groupOrder?.length);
      const requestedModel = groupActive ? undefined : request.model;

      let candidates = await selectCandidates(request, groupOrder);

      // Privacy mode: drop providers that may train on user data — trains OR an
      // "unknown" policy (conservative; an undocumented provider is NOT treated
      // as private-safe) — keeping any the user explicitly allowed. Skip the
      // filter if it would strand the request; in that case privacy could NOT be
      // honored and the winner below carries `privacyHonored: false` so surfaces
      // can say so instead of silently using a training provider.
      const allowedTraining = new Set(request.allowTrainingProviders ?? []);
      if (request.blockTrainingProviders) {
        const filtered = candidates.filter(
          (candidate) =>
            allowedTraining.has(candidate.id) ||
            !mayTrainOnUserData(candidate.id),
        );
        if (filtered.length > 0) {
          candidates = filtered;
        }
      }

      // Vision routing: an image request MUST go to a vision-capable
      // provider+model. Filter candidates to vision-capable ones; never silently
      // drop image blocks or fall back to text-only. If none remain (including an
      // explicitly-forced non-vision provider), throw `unsupported_capability`,
      // which the gateway maps to the honest capability error + suggestions.
      if (requiresVision(request.messages)) {
        candidates = candidates.filter((candidate) =>
          supportsVision(candidate.id, request.model),
        );
        if (candidates.length === 0) {
          throw new Error("unsupported_capability");
        }
      }

      // Tool routing: a request that supplies tool definitions MUST go to a
      // tool-capable provider+model. Same discipline as vision — filter to
      // tool-capable candidates and hard-error (`unsupported_capability`) rather
      // than silently sending tools to a model that drops them. The per-provider
      // model fan-out below (groq 70B→8B, openrouter free models) is constrained
      // to tool-capable models in the attempt loop so failover never lands on a
      // non-tool model when tools were requested.
      if (requiresTools(request)) {
        candidates = candidates.filter((candidate) =>
          supportsTools(candidate.id, request.model),
        );
        if (candidates.length === 0) {
          throw new Error("unsupported_capability");
        }
      }

      // Structured-output routing: a STRICT json_schema request must go to a
      // provider+model that GUARANTEES schema-constrained decoding. Filter to
      // json_schema-level candidates and hard-error rather than silently serving
      // best-effort json-mode. A non-strict structured request is NOT filtered —
      // it is allowed to fall back to json_object/prompt (resolved per-attempt
      // below) and is labeled guaranteed:false downstream.
      if (requiresGuaranteedSchema(request)) {
        candidates = candidates.filter(
          (candidate) =>
            structuredOutputLevel(candidate.id, request.model) === "json_schema",
        );
        if (candidates.length === 0) {
          throw new Error("unsupported_capability");
        }
      }

      if (candidates.length === 0) {
        throw new Error(
          "No providers available. Configure API keys or start Ollama.",
        );
      }

      let lastError: Error | undefined;
      const stickyProviderId = request.stickySessionKey
        ? stickySessions.get(request.stickySessionKey)
        : undefined;
      const prioritizedCandidates = stickyProviderId
        ? [
            ...candidates.filter((candidate) => candidate.id === stickyProviderId),
            ...candidates.filter((candidate) => candidate.id !== stickyProviderId),
          ]
        : candidates;

      const estTokens = estimateReserveTokens(request);

      for (const provider of prioritizedCandidates) {
        // Reserve quota synchronously BEFORE dispatch. Under a concurrent burst
        // this is the real admission gate: a saturated provider is skipped here
        // instead of overshooting its rate limit. Released on every terminal
        // path below (success drain, model/provider failover, throw, abort).
        if (!tryReserveProvider(provider.id, estTokens, Date.now())) {
          continue;
        }
        // Half-open admission: a recovering provider (has recent errors but is
        // still eligible) admits a single probe at a time. If one is already in
        // flight, release this reservation and fail over to the next candidate
        // rather than piling onto a possibly-still-down provider. The check +
        // add is synchronous (no await between), so it is race-free.
        const degraded =
          ledger.recentErrorCount(provider.id, ERROR_STREAK_WINDOW_MS, Date.now()) > 0;
        if (degraded) {
          if (halfOpenProbes.has(provider.id)) {
            reservations.release(provider.id, estTokens);
            continue;
          }
          halfOpenProbes.add(provider.id);
        }
        let reservationReleased = false;
        const releaseReservation = (): void => {
          if (reservationReleased) return;
          reservationReleased = true;
          reservations.release(provider.id, estTokens);
          // Release the half-open probe on every terminal path (success drain,
          // failover, throw, abort), so the next request can probe the provider.
          halfOpenProbes.delete(provider.id);
        };

        // keysFor() prefers per-request BYOK keys (request.keys) then appends the
        // keychain's ordered list (primary + fallbacks) — merges the per-request-
        // keys feature with the quota-reservation admission gate above. The
        // streamChat call below walks these keys on an auth (401/403) failure.
        const apiKeys = await keysFor(provider.id, request);
        let modelsToTry =
          provider.id === "groq"
            ? [requestedModel ?? GROQ_MODEL_70B, GROQ_MODEL_8B]
            : provider.id === "openrouter"
              ? [
                  requestedModel ?? provider.defaultModel,
                  ...OPENROUTER_FREE_MODELS.filter(
                    (model) => model !== (requestedModel ?? provider.defaultModel),
                  ),
                ]
            : [requestedModel ?? provider.defaultModel];
        // When tools are requested, never fail over onto a model that can't do
        // tools (e.g. groq's 8B fallback) — that would silently drop the tools.
        if (requiresTools(request)) {
          modelsToTry = modelsToTry.filter((model) =>
            supportsTools(provider.id, model),
          );
          if (modelsToTry.length === 0) {
            releaseReservation();
            continue;
          }
        }
        // Same discipline for vision: never fail over onto a model that can't do
        // vision (e.g. an openrouter vision model failing over to a text-only free
        // model) — that would silently re-send the image blocks to a blind model.
        if (requiresVision(request.messages)) {
          modelsToTry = modelsToTry.filter((model) =>
            supportsVision(provider.id, model),
          );
          if (modelsToTry.length === 0) {
            releaseReservation();
            continue;
          }
        }

        for (const model of modelsToTry) {
          const attemptStarted = Date.now();
          try {
            // Resolve the caller's structured-output request to the strongest
            // level THIS provider+model can actually serve (json_schema ≥
            // json_object ≥ prompt). The adapter emits only its native field for
            // that level; anything below json_schema is validated (and labeled
            // not-guaranteed) by the engine. We capture the resolved level here so
            // the winning result reports the level ACTUALLY served — the engine
            // must label `served_level`/`guaranteed` from this, not from the raw
            // provider capability.
            const resolvedRf = resolveResponseFormat(
              request.responseFormat,
              provider.id,
              model,
            );
            // BYOK PRIORITY + FALLBACK: walk the ordered keys for this provider.
            // A 401/403 is thrown by streamChat PRE-stream (before the first
            // chunk), so retrying with the next key here is safe — we never retry
            // a key mid-stream. On such an auth failure WITH a next key available,
            // retry the SAME provider+model with it (keep the reservation, do not
            // abandon the provider). Any non-auth error (429/5xx/network/other),
            // or exhausting the keys, throws to the EXISTING failover/abandon path
            // below UNCHANGED. With zero or one key the loop runs exactly once →
            // behavior is identical to the single-key path.
            const attemptKeys: Array<string | undefined> =
              apiKeys.length > 0 ? apiKeys : [undefined];
            let keyIndex = 0;
            let result!: Awaited<ReturnType<Provider["streamChat"]>>;
            while (true) {
              try {
                result = await provider.streamChat(request.messages, {
                  model,
                  apiKey: attemptKeys[keyIndex],
                  webSearch: request.webSearch,
                  tools: request.tools,
                  toolChoice: request.toolChoice,
                  responseFormat: resolvedRf,
                  temperature: request.temperature,
                  maxTokens: request.maxTokens,
                  cacheHints: request.cachedContentHandle
                    ? { cachedContentHandle: request.cachedContentHandle }
                    : undefined,
                  signal: request.signal,
                });
                break;
              } catch (keyError) {
                const keyStatus =
                  keyError instanceof ProviderHttpError
                    ? keyError.status
                    : undefined;
                const isAuthError = keyStatus === 401 || keyStatus === 403;
                if (isAuthError && keyIndex + 1 < attemptKeys.length) {
                  keyIndex += 1;
                  continue;
                }
                throw keyError;
              }
            }

            if (provider.id === "groq" && result.rateLimit) {
              ledger.applyGroqRateLimitFromHeaders(
                provider.id,
                result.rateLimit.remainingRequests,
                result.rateLimit.resetRequests,
              );
            }

            cooldownRetries.set(provider.id, 0);
            if (request.stickySessionKey) {
              stickySessions.set(request.stickySessionKey, provider.id);
              if (request.stickySessionTtlMs && request.stickySessionTtlMs > 0) {
                const key = request.stickySessionKey;
                setTimeout(() => {
                  if (stickySessions.get(key) === provider.id) {
                    stickySessions.delete(key);
                  }
                }, request.stickySessionTtlMs).unref?.();
              }
            }
            // NOTE: the success attempt event is intentionally NOT emitted here.
            // Connecting to a provider is not the same as a successful response —
            // a stream can die mid-drain. We emit `status: "success"` only AFTER
            // the stream fully drains (below), and a `status: "fail"` if it errors
            // mid-stream, so the recorded outcome reflects reality. Provider
            // selection / cooldown / sticky-session state above are unchanged.
            // Live tool-call channel (parallel to the text stream): populated as the
            // stream drains, complete once it's fully consumed. Kept off the text
            // `stream` so the (string) text path is byte-identical for existing
            // consumers; the gateway/engine read this AFTER draining the stream.
            const collectedToolCalls: ToolCallContentBlock[] = [];
            const textStream = async function* (): AsyncGenerator<string> {
              let reportedUsage: TokenUsage | undefined;
              let outputText = "";
              try {
                for await (const chunk of result.stream) {
                  if (chunk.rateLimit && provider.id === "groq") {
                    ledger.applyGroqRateLimitFromHeaders(
                      provider.id,
                      chunk.rateLimit.remainingRequests,
                      chunk.rateLimit.resetRequests,
                    );
                  }
                  if (chunk.usage) {
                    reportedUsage = chunk.usage;
                  }
                  if (chunk.toolCall) {
                    collectedToolCalls.push(chunk.toolCall);
                  }
                  if (chunk.content) {
                    outputText += chunk.content;
                    yield chunk.content;
                  }
                }
                // Prefer provider-reported usage; fall back to a clearly-marked
                // local estimate only when the provider did not report any.
                const usage =
                  reportedUsage ?? estimateUsage(request.messages, outputText);
                const completionLatencyMs = Date.now() - attemptStarted;
                ledger.recordUsage(provider.id, {
                  status: "success",
                  tokensIn: usage.inputTokens,
                  tokensOut: usage.outputTokens,
                  latencyMs: completionLatencyMs,
                  model,
                });
                if (vKey) {
                  ledger.recordVirtualKeyUsage(vKey, usage.inputTokens, usage.outputTokens);
                }
                ledger.clearCooldown(provider.id);
                request.onUsage?.({
                  providerId: provider.id,
                  model,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  latencyMs: completionLatencyMs,
                });
                // The stream fully drained — NOW it's honestly a success. Recording
                // it here (rather than before the stream is consumed) means a stream
                // that dies mid-way is never recorded as success.
                const successEvt = {
                  providerId: provider.id,
                  model,
                  status: "success" as const,
                  latencyMs: completionLatencyMs,
                };
                request.onAttempt?.(successEvt);
                config.onAttempt?.(successEvt);
              } catch (streamError: unknown) {
                const usage =
                  reportedUsage ?? estimateUsage(request.messages, outputText);
                ledger.recordUsage(provider.id, {
                  status: "error",
                  tokensIn: usage.inputTokens,
                  tokensOut: usage.outputTokens,
                  errorCode:
                    streamError instanceof ProviderHttpError
                      ? streamError.status
                      : undefined,
                  model,
                });
                if (vKey) {
                  ledger.recordVirtualKeyUsage(vKey, usage.inputTokens, usage.outputTokens);
                }
                // The response started but the stream broke mid-drain — record the
                // attempt as a FAILURE so the trace doesn't lie. This is purely an
                // observability signal; it does not alter provider selection or
                // cooldown (the stream is already committed to this provider).
                const failEvt = {
                  providerId: provider.id,
                  model,
                  status: "fail" as const,
                  latencyMs: Date.now() - attemptStarted,
                  errorCode:
                    streamError instanceof ProviderHttpError
                      ? streamError.status
                      : undefined,
                  errorMessage: redactSecrets(
                    streamError instanceof Error
                      ? streamError.message
                      : String(streamError),
                  ),
                };
                request.onAttempt?.(failEvt);
                config.onAttempt?.(failEvt);
                throw streamError;
              } finally {
                // Release the reservation once the stream is fully drained, errors,
                // or is abandoned (the consumer's `.return()` on early break runs
                // this finally) — so a dropped response can never leak a slot.
                releaseReservation();
              }
            };

            return {
              providerId: provider.id,
              model,
              stream: textStream(),
              // Live tool-call channel — filled as `stream` drains, read after.
              toolCalls: collectedToolCalls,
              // The level actually served this turn (json_schema/json_object/prompt
              // or undefined for text). The engine labels served_level/guaranteed
              // from THIS, never from the raw provider capability.
              resolvedStructuredLevel: resolvedRf?.level,
              // Honesty signal: under private mode, true iff the winner is
              // privacy-safe or user-allowed; false when the strand-fallback had
              // to use a may-train/"unknown" provider. undefined when not private.
              privacyHonored: request.blockTrainingProviders
                ? allowedTraining.has(provider.id) ||
                  !mayTrainOnUserData(provider.id)
                : undefined,
            };
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            const status =
              error instanceof ProviderHttpError ? error.status : undefined;
            const failEvt = {
              providerId: provider.id,
              model,
              status: "fail" as const,
              latencyMs: Date.now() - attemptStarted,
              errorCode: status,
              // Provider errors can echo the auth header / key (e.g. a 401 body);
              // redact before it's recorded into the persisted trace.
              errorMessage: redactSecrets(lastError.message),
            };
            request.onAttempt?.(failEvt);
            config.onAttempt?.(failEvt);
            // Failover is governed by the policy's fallback actions. Default is
            // next_provider for both 429 and 5xx; a policy may set "fail" to make
            // a given error class abort instead of trying the next provider.
            const isRateLimit = status === 429;
            const is5xx = status != null && status >= 500;
            // Treat network-level errors (TypeError: fetch failed, connection refused, etc.)
            // as transient 503s — they should trigger failover to the next provider.
            const isNetworkError =
              !(error instanceof ProviderHttpError) &&
              error instanceof Error &&
              (error.name === "TypeError" ||
                error.message.includes("fetch failed") ||
                error.message.includes("ECONNREFUSED") ||
                error.message.includes("ENOTFOUND") ||
                error.message.includes("network"));
            const shouldFailover =
              (isRateLimit && on429 === "next_provider") ||
              (is5xx && on5xx === "next_provider") ||
              (isNetworkError && on5xx === "next_provider");
            // True once we have exhausted every model we were willing to try for
            // this provider (Groq tries 70B then 8B; OpenRouter tries its free
            // models; everyone else has a single model). Only then do we cool the
            // provider down and move on to the next one.
            const isLastModel = model === modelsToTry.at(-1);

            ledger.recordUsage(provider.id, {
              status: status === 429 ? "rate_limited" : "error",
              errorCode: status,
              model,
            });

            if (
              error instanceof ProviderHttpError &&
              error.rateLimit?.resetRequests &&
              provider.id === "groq"
            ) {
              ledger.applyGroqRollingReset(
                provider.id,
                error.rateLimit.resetRequests,
              );
            }

            // More models left to try for this same provider — do that before
            // giving up on the provider entirely. The reservation is intentionally
            // kept: it's the same in-flight request continuing to the next model.
            if (shouldFailover && !isLastModel) {
              continue;
            }

            // Giving up on this provider (failover or hard error) — the request
            // is no longer in flight against it, so release before moving on.
            releaseReservation();

            if (shouldFailover) {
              const retries = (cooldownRetries.get(provider.id) ?? 0) + 1;
              cooldownRetries.set(provider.id, retries);
              // Groq reports a precise reset window via its x-ratelimit-* headers,
              // which applyGroqRollingReset has already turned into a cooldown.
              // Skip the redundant exponential cooldown only in that case; every
              // other provider (and Groq without a header) gets backed off here so
              // a rate-limited provider is skipped on the next request instead of
              // being retried into a guaranteed failure.
              const hasGroqHeader =
                error instanceof ProviderHttpError &&
                Boolean(error.rateLimit?.resetRequests);
              if (provider.id !== "groq" || !hasGroqHeader) {
                ledger.setCooldown(provider.id, retries);
              }
              break;
            }

            throw lastError;
          }
        }
      }

      throw lastError ?? new Error("All providers exhausted");
    },
  };
}
