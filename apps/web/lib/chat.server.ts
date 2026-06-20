import { createRouter } from "@zintus/router";
import type {
  AppConfig,
  ChatMessage,
  ContextMode,
  ProviderId,
  RouteStreamResult,
} from "@zintus/types";
import { DEFAULT_CONFIG } from "@zintus/types";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ChatRequestBody {
  messages: ChatMessage[];
  provider?: ProviderId;
  mode?: ContextMode;
  threadId?: string;
  apiKeys?: Partial<Record<ProviderId, string>>;
  settings?: Partial<AppConfig>;
}

export interface ChatServerStreamResult extends RouteStreamResult {
  compileTokens?: number;
}

function quotaDbPath(): string {
  return (
    process.env.ZINTUS_QUOTA_PATH ??
    join(homedir(), ".zintus", "quota-web.db")
  );
}

export async function streamChat(
  body: ChatRequestBody,
): Promise<ChatServerStreamResult> {
  const config = { ...DEFAULT_CONFIG, ...body.settings };
  const router = createRouter({
    strategy: config.routingStrategy,
    providerPriority: config.providerPriority,
    defaultProvider: config.defaultProvider,
    dbPath: quotaDbPath(),
    getApiKey: async (providerId: ProviderId) => {
      if (providerId === "ollama" || providerId === "lmstudio") {
        return null;
      }
      return body.apiKeys?.[providerId] ?? null;
    },
  });

  const result = await router.routeAndStream({
    messages: body.messages,
    provider: body.provider,
    mode: body.mode ?? config.contextMode,
    threadId: body.threadId,
  });

  return { ...result, compileTokens: undefined };
}
