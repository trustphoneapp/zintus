import { listProviders, ProviderHttpError } from "@multipleai/providers";
import type { AppConfig, ChatMessage, ProviderId } from "@multipleai/types";
import { GROQ_MODEL_70B, GROQ_MODEL_8B } from "@multipleai/router/limits";
import { sortProviders } from "@multipleai/router/priority";
import { getApiKey } from "./keys";
import { loadConfig } from "./config";
import {
  applyGroqRollingReset,
  clearCooldown,
  getQuotaSnapshot,
  isQuotaAvailable,
  recordUsage,
  remainingRatio,
  setCooldown,
} from "./quota";
import {
  checkQuotaWarnings,
  notifyQuotaExhausted,
  notifyStreamError,
} from "./notifications";

const cooldownRetries = new Map<ProviderId, number>();

async function isProviderReady(id: ProviderId, now = Date.now()): Promise<boolean> {
  const snapshot = await getQuotaSnapshot(id, now);
  if (snapshot.inCooldown) {
    return false;
  }
  return isQuotaAvailable(id, now);
}

async function selectCandidates(
  config: AppConfig,
  forcedProvider?: ProviderId,
): Promise<ReturnType<typeof listProviders>> {
  const allProviders = listProviders();
  const now = Date.now();

  if (forcedProvider) {
    const forced = allProviders.find((p) => p.id === forcedProvider);
    return forced ? [forced] : [];
  }

  const ratios = new Map<ProviderId, number>();
  for (const provider of allProviders) {
    ratios.set(provider.id, await remainingRatio(provider.id, now));
  }

  const ordered = sortProviders(
    allProviders,
    config.routingStrategy,
    (id) => ratios.get(id) ?? 0,
    config.providerPriority,
  );

  if (config.defaultProvider) {
    const preferred = ordered.find((p) => p.id === config.defaultProvider);
    if (preferred) {
      const key = await getApiKey(preferred.id);
      const hasKey = preferred.id === "ollama" ? true : Boolean(key);
      if (hasKey && (await isProviderReady(preferred.id, now))) {
        return [preferred];
      }
    }
  }

  const candidates = [];
  for (const provider of ordered) {
    const key = await getApiKey(provider.id);
    const hasKey = provider.id === "ollama" ? true : Boolean(key);
    if (!hasKey || !(await isProviderReady(provider.id, now))) {
      continue;
    }
    candidates.push(provider);
  }

  return candidates;
}

export interface StreamChatParams {
  providerId?: ProviderId;
  messages: ChatMessage[];
  onChunk: (text: string) => void;
  signal?: AbortSignal;
}

export async function streamChat({
  providerId,
  messages,
  onChunk,
  signal,
}: StreamChatParams): Promise<{ providerId: ProviderId; model: string }> {
  const config = loadConfig();
  const candidates = await selectCandidates(config, providerId);

  if (candidates.length === 0) {
    await notifyStreamError("No providers available. Add keys or start Ollama.");
    throw new Error("No providers available");
  }

  let lastError: Error | undefined;

  for (const provider of candidates) {
    const apiKey = await getApiKey(provider.id);
    const modelsToTry =
      provider.id === "groq"
        ? [provider.defaultModel ?? GROQ_MODEL_70B, GROQ_MODEL_8B]
        : [provider.defaultModel];

    for (const model of modelsToTry) {
      if (!(await isQuotaAvailable(provider.id))) {
        await notifyQuotaExhausted(provider.id);
        continue;
      }

      try {
        const result = await provider.streamChat(messages, {
          apiKey: apiKey ?? undefined,
          model,
          signal,
        });

        cooldownRetries.set(provider.id, 0);
        let output = "";
        let tokensOut = 0;

        for await (const chunk of result.stream) {
          if (signal?.aborted) {
            break;
          }
          if (chunk.content) {
            output += chunk.content;
            tokensOut += chunk.content.length;
            onChunk(output);
          }
        }

        await recordUsage(provider.id, {
          tokensIn: messages.reduce((sum, message) => sum + message.content.length, 0),
          tokensOut,
          status: "success",
        });
        await clearCooldown(provider.id);
        await checkQuotaWarnings();

        return { providerId: provider.id, model };
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
          await applyGroqRollingReset(provider.id, error.rateLimit.resetRequests);
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

        await notifyStreamError(lastError.message);
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("All providers exhausted");
}
