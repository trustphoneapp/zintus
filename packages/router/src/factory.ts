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
} from "@multipleai/types";
import {
  estimateUsage,
  listProviders,
  ProviderHttpError,
} from "@multipleai/providers";
import type { TokenUsage } from "@multipleai/types";
import { isInCooldown } from "./cooldown.js";
import { sortProviders } from "./priority.js";
import { QuotaLedger } from "./quota-ledger.js";
import { GROQ_MODEL_70B, GROQ_MODEL_8B } from "./limits.js";

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
}

/** A provider with a recent error streak this large is treated as unhealthy. */
const ERROR_STREAK_THRESHOLD = 3;
const ERROR_STREAK_WINDOW_MS = 5 * 60_000;

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
}

const DEFAULT_DB_PATH = join(homedir(), ".multipleai", "quota.db");
const OPENROUTER_FREE_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-7b-instruct:free",
] as const;

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

  const cooldownRetries = new Map<ProviderId, number>();
  const stickySessions = new Map<string, ProviderId>();

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
  ): Promise<boolean> {
    const hasKey =
      provider.id === "ollama" || provider.id === "lmstudio"
        ? true
        : Boolean(await resolveKey(provider.id));
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
        if (provider && (await isEligible(provider, now))) {
          candidates.push(provider);
        }
      }
      return candidates;
    }

    const weightMap = request.providerWeights ?? providerWeights;

    if (effStrategy === "weighted" || weightMap) {
      const eligible: Provider[] = [];
      for (const provider of allProviders) {
        if (await isEligible(provider, now)) {
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

    const ordered = sortProviders(allProviders, effStrategy, {
      remainingRatio,
      providerPriority,
      latencyP95,
    });

    if (config.defaultProvider) {
      const preferred = ordered.find((p) => p.id === config.defaultProvider);
      if (preferred && (await isEligible(preferred, now))) {
        return [preferred];
      }
    }

    const candidates = [];
    for (const provider of ordered) {
      if (await isEligible(provider, now)) {
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

      const candidates = await selectCandidates(request, groupOrder);

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

      for (const provider of prioritizedCandidates) {
        const apiKey = (await resolveKey(provider.id)) ?? undefined;
        const modelsToTry =
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

        for (const model of modelsToTry) {
          const attemptStarted = Date.now();
          try {
            const result = await provider.streamChat(request.messages, {
              model,
              apiKey,
              cacheHints: request.cachedContentHandle
                ? { cachedContentHandle: request.cachedContentHandle }
                : undefined,
            });

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
            config.onAttempt?.({
              providerId: provider.id,
              model,
              status: "success",
              latencyMs: Date.now() - attemptStarted,
            });

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
                  if (chunk.content) {
                    outputText += chunk.content;
                    yield chunk.content;
                  }
                }
                // Prefer provider-reported usage; fall back to a clearly-marked
                // local estimate only when the provider did not report any.
                const usage =
                  reportedUsage ?? estimateUsage(request.messages, outputText);
                ledger.recordUsage(provider.id, {
                  status: "success",
                  tokensIn: usage.inputTokens,
                  tokensOut: usage.outputTokens,
                  latencyMs: Date.now() - attemptStarted,
                });
                if (vKey) {
                  ledger.recordVirtualKeyUsage(vKey, usage.inputTokens, usage.outputTokens);
                }
                ledger.clearCooldown(provider.id);
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
                });
                if (vKey) {
                  ledger.recordVirtualKeyUsage(vKey, usage.inputTokens, usage.outputTokens);
                }
                throw streamError;
              }
            };

            return {
              providerId: provider.id,
              model,
              stream: textStream(),
            };
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            const status =
              error instanceof ProviderHttpError ? error.status : undefined;
            config.onAttempt?.({
              providerId: provider.id,
              model,
              status: "fail",
              latencyMs: Date.now() - attemptStarted,
              errorCode: status,
              errorMessage: lastError.message,
            });
            // Failover is governed by the policy's fallback actions. Default is
            // next_provider for both 429 and 5xx; a policy may set "fail" to make
            // a given error class abort instead of trying the next provider.
            const isRateLimit = status === 429;
            const is5xx = status != null && status >= 500;
            const shouldFailover =
              (isRateLimit && on429 === "next_provider") ||
              (is5xx && on5xx === "next_provider");
            // True once we have exhausted every model we were willing to try for
            // this provider (Groq tries 70B then 8B; OpenRouter tries its free
            // models; everyone else has a single model). Only then do we cool the
            // provider down and move on to the next one.
            const isLastModel = model === modelsToTry.at(-1);

            ledger.recordUsage(provider.id, {
              status: status === 429 ? "rate_limited" : "error",
              errorCode: status,
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
            // giving up on the provider entirely.
            if (shouldFailover && !isLastModel) {
              continue;
            }

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
