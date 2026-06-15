import { listProviders, ProviderHttpError } from "@multipleai/providers";
import { sortProviders } from "@multipleai/router/priority";
import { GROQ_MODEL_70B, GROQ_MODEL_8B, PROVIDER_LIMITS } from "@multipleai/router/limits";
import { isInCooldown } from "@multipleai/router/cooldown";
import type {
  AppConfig,
  ChatMessage,
  ProviderId,
  ProviderStatus,
  RouteRequest,
  RouteStreamResult,
} from "@multipleai/types";
import { getKey } from "./tauri";
import {
  applyGroqRateLimitFromHeaders,
  applyGroqRollingReset,
  clearCooldown,
  isQuotaAvailable,
  maybeResetDailyCounters,
  recordUsage,
  remainingRatio,
  setCooldown,
} from "./quota";

const cooldownRetries = new Map<ProviderId, number>();

async function resolveKey(providerId: ProviderId): Promise<string | null> {
  if (providerId === "ollama") {
    return null;
  }
  return getKey(providerId);
}

export async function getProviderStatus(): Promise<ProviderStatus[]> {
  const now = Date.now();
  const allProviders = listProviders();

  return Promise.all(
    allProviders.map(async (provider) => {
      const row = await maybeResetDailyCounters(provider.id, now);
      const limits = PROVIDER_LIMITS[provider.id];
      const apiKey = await resolveKey(provider.id);
      const hasKey = provider.id === "ollama" ? true : Boolean(apiKey);
      const inCooldown = isInCooldown(row.cooldownUntil, now);
      const quotaAvailable = await isQuotaAvailable(provider.id, now);

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
  config: AppConfig,
): Promise<ReturnType<typeof listProviders>> {
  const allProviders = listProviders();
  const now = Date.now();

  if (request.provider) {
    const forced = allProviders.find((p) => p.id === request.provider);
    return forced ? [forced] : [];
  }

  const ratioEntries = await Promise.all(
    allProviders.map(async (provider) => [
      provider.id,
      await remainingRatio(provider.id, now),
    ] as const),
  );
  const ratios = new Map(ratioEntries);

  const ordered = sortProviders(
    allProviders,
    config.routingStrategy,
    (id) => ratios.get(id) ?? 0,
    config.providerPriority,
  );

  if (config.defaultProvider) {
    const preferred = ordered.find((p) => p.id === config.defaultProvider);
    if (preferred) {
      const apiKey = await resolveKey(preferred.id);
      const hasKey = preferred.id === "ollama" ? true : Boolean(apiKey);
      const row = await maybeResetDailyCounters(preferred.id, now);
      if (
        hasKey &&
        (await isQuotaAvailable(preferred.id, now)) &&
        !isInCooldown(row.cooldownUntil, now)
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
    if (!(await isQuotaAvailable(provider.id, now))) {
      continue;
    }
    candidates.push(provider);
  }

  return candidates;
}

export async function routeAndStream(
  request: RouteRequest,
  config: AppConfig,
  options?: { signal?: AbortSignal },
): Promise<RouteStreamResult> {
  const candidates = await selectCandidates(request, config);

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
          signal: options?.signal,
        });

        if (provider.id === "groq" && result.rateLimit) {
          await applyGroqRateLimitFromHeaders(
            provider.id,
            result.rateLimit.remainingRequests ?? null,
            result.rateLimit.resetRequests ?? null,
          );
        }

        cooldownRetries.set(provider.id, 0);

        const textStream = async function* (): AsyncGenerator<string> {
          let tokensOut = 0;
          try {
            for await (const chunk of result.stream) {
              if (chunk.rateLimit && provider.id === "groq") {
                await applyGroqRateLimitFromHeaders(
                  provider.id,
                  chunk.rateLimit.remainingRequests ?? null,
                  chunk.rateLimit.resetRequests ?? null,
                );
              }
              if (chunk.content) {
                tokensOut += chunk.content.length;
                yield chunk.content;
              }
            }
            await recordUsage(provider.id, {
              status: "success",
              tokensOut,
            });
            await clearCooldown(provider.id);
          } catch (streamError: unknown) {
            await recordUsage(provider.id, {
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

        await recordUsage(provider.id, {
          status: status === 429 ? "rate_limited" : "error",
          errorCode: status,
        });

        if (
          error instanceof ProviderHttpError &&
          error.rateLimit?.resetRequests &&
          provider.id === "groq"
        ) {
          await applyGroqRollingReset(
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
            await setCooldown(provider.id, retries);
          }
          break;
        }

        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("All providers exhausted");
}

export async function streamChat(
  messages: ChatMessage[],
  config: AppConfig,
  options?: { provider?: ProviderId; signal?: AbortSignal },
): Promise<RouteStreamResult> {
  return routeAndStream(
    {
      messages,
      provider: options?.provider,
    },
    config,
    { signal: options?.signal },
  );
}
