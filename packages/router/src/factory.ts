import type {
  Provider,
  ProviderId,
  ProviderStatus,
  RouteRequest,
  RouteStreamResult,
  RoutingStrategy,
} from "@multipleai/types";
import { listProviders, ProviderHttpError } from "@multipleai/providers";
import { getKey } from "@multipleai/keychain";
import { isInCooldown } from "./cooldown.js";
import { sortProviders } from "./priority.js";
import { QuotaLedger } from "./quota-ledger.js";
import { GROQ_MODEL_70B, GROQ_MODEL_8B } from "./limits.js";

export interface RouterConfig {
  dbPath?: string;
  strategy?: RoutingStrategy;
  providerPriority?: ProviderId[];
  defaultProvider?: ProviderId;
  getApiKey?: (providerId: ProviderId) => Promise<string | null>;
}

export interface Router {
  routeAndStream(request: RouteRequest): Promise<RouteStreamResult>;
  getProviderStatus(): Promise<ProviderStatus[]>;
}

const DEFAULT_DB_PATH = `${process.env.HOME ?? "."}/.multipleai/quota.db`;

export function createRouter(config: RouterConfig = {}): Router {
  const strategy = config.strategy ?? "fastest";
  const ledger = new QuotaLedger(config.dbPath ?? DEFAULT_DB_PATH);
  const resolveKey =
    config.getApiKey ??
    (async (providerId: ProviderId) => {
      if (providerId === "ollama") {
        return null;
      }
      return getKey(providerId);
    });

  const cooldownRetries = new Map<ProviderId, number>();

  async function buildStatus(): Promise<ProviderStatus[]> {
    const now = Date.now();
    const allProviders = listProviders();

    return Promise.all(
      allProviders.map(async (provider: Provider) => {
        const row = ledger.maybeResetDailyCounters(provider.id, now);
        const limits = ledger.getLimits(provider.id);
        const apiKey = await resolveKey(provider.id);
        const hasKey = provider.id === "ollama" ? true : Boolean(apiKey);
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

  async function selectCandidates(
    request: RouteRequest,
  ): Promise<Provider[]> {
    const allProviders = listProviders();
    const remainingRatio = (id: ProviderId) => ledger.remainingRatio(id);

    if (request.provider) {
      const forced = allProviders.find(
        (provider: Provider) => provider.id === request.provider,
      );
      return forced ? [forced] : [];
    }

    const ordered = sortProviders(
      allProviders,
      strategy,
      remainingRatio,
      config.providerPriority,
    );
    const now = Date.now();

    if (config.defaultProvider) {
      const preferred = ordered.find((p) => p.id === config.defaultProvider);
      if (preferred) {
        const apiKey = await resolveKey(preferred.id);
        const hasKey = preferred.id === "ollama" ? true : Boolean(apiKey);
        if (
          hasKey &&
          ledger.isQuotaAvailable(preferred.id, now) &&
          !isInCooldown(
            ledger.maybeResetDailyCounters(preferred.id, now).cooldownUntil,
            now,
          )
        ) {
          return [preferred];
        }
      }
    }

    const candidates = [];
    for (const provider of ordered) {
      const apiKey = await resolveKey(provider.id);
      const hasKey = provider.id === "ollama" ? true : Boolean(apiKey);
      if (!hasKey) {
        continue;
      }
      if (!ledger.isQuotaAvailable(provider.id, now)) {
        continue;
      }
      candidates.push(provider);
    }

    return candidates;
  }

  return {
    async getProviderStatus() {
      return buildStatus();
    },

    async routeAndStream(request) {
      const candidates = await selectCandidates(request);

      if (candidates.length === 0) {
        throw new Error(
          "No providers available. Configure API keys or start Ollama.",
        );
      }

      let lastError: Error | undefined;

      for (const provider of candidates) {
        const apiKey = (await resolveKey(provider.id)) ?? undefined;
        const modelsToTry =
          provider.id === "groq"
            ? [request.model ?? GROQ_MODEL_70B, GROQ_MODEL_8B]
            : [request.model ?? provider.defaultModel];

        for (const model of modelsToTry) {
          try {
            const result = await provider.streamChat(request.messages, {
              model,
              apiKey,
            });

            if (provider.id === "groq" && result.rateLimit) {
              ledger.applyGroqRateLimitFromHeaders(
                provider.id,
                result.rateLimit.remainingRequests,
                result.rateLimit.resetRequests,
              );
            }

            cooldownRetries.set(provider.id, 0);

            const textStream = async function* (): AsyncGenerator<string> {
              let tokensOut = 0;
              try {
                for await (const chunk of result.stream) {
                  if (chunk.rateLimit && provider.id === "groq") {
                    ledger.applyGroqRateLimitFromHeaders(
                      provider.id,
                      chunk.rateLimit.remainingRequests,
                      chunk.rateLimit.resetRequests,
                    );
                  }
                  if (chunk.content) {
                    tokensOut += chunk.content.length;
                    yield chunk.content;
                  }
                }
                ledger.recordUsage(provider.id, {
                  status: "success",
                  tokensOut,
                });
                ledger.clearCooldown(provider.id);
              } catch (streamError: unknown) {
                ledger.recordUsage(provider.id, {
                  status: "error",
                  tokensOut,
                  errorCode:
                    streamError instanceof ProviderHttpError
                      ? streamError.status
                      : undefined,
                });
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
            const shouldFailover = status === 429 || (status != null && status >= 500);
            const isLastGroqModel =
              provider.id === "groq" && model === modelsToTry.at(-1);

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

            if (shouldFailover && !isLastGroqModel) {
              continue;
            }

            if (shouldFailover) {
              const retries = (cooldownRetries.get(provider.id) ?? 0) + 1;
              cooldownRetries.set(provider.id, retries);
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
