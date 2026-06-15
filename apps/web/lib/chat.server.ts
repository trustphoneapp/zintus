import { createRouter } from "@multipleai/router";
import type { AppConfig, ChatMessage, ProviderId, RouteStreamResult } from "@multipleai/types";
import { DEFAULT_CONFIG } from "@multipleai/types";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ChatRequestBody {
  messages: ChatMessage[];
  provider?: ProviderId;
  apiKeys?: Partial<Record<ProviderId, string>>;
  settings?: Partial<AppConfig>;
}

function quotaDbPath(): string {
  return (
    process.env.MULTIPLEAI_QUOTA_PATH ??
    join(homedir(), ".multipleai", "quota-web.db")
  );
}

export async function streamChat(body: ChatRequestBody): Promise<RouteStreamResult> {
  const config = { ...DEFAULT_CONFIG, ...body.settings };
  const router = createRouter({
    strategy: config.routingStrategy,
    providerPriority: config.providerPriority,
    defaultProvider: config.defaultProvider,
    dbPath: quotaDbPath(),
    getApiKey: async (providerId: ProviderId) => {
      if (providerId === "ollama") {
        return null;
      }
      return body.apiKeys?.[providerId] ?? null;
    },
  });

  return router.routeAndStream({
    messages: body.messages,
    provider: body.provider,
  });
}
