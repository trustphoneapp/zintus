import { randomUUID } from "node:crypto";
import {
  createRouter,
  type Router,
  type RouterConfig,
} from "@multipleai/router";
import type {
  ProviderStatus,
  RequestTrace,
  RouteRequest,
  RouteStreamResult,
  Thread,
  ThreadMessage,
  TraceAttempt,
} from "@multipleai/types";
import { ConversationStore } from "./conversation-store.js";

export interface EngineConfig extends RouterConfig {
  conversationsPath?: string;
  persistConversations?: boolean;
  persistTraces?: boolean;
}

export interface EngineRouteRequest extends RouteRequest {
  threadId?: string;
}

export interface EngineStreamResult extends RouteStreamResult {
  traceId: string;
  threadId?: string;
}

export interface Engine {
  routeAndStream(request: EngineRouteRequest): Promise<EngineStreamResult>;
  getProviderStatus(): Promise<ProviderStatus[]>;
  listThreads(): Thread[];
  getThreadMessages(threadId: string): ThreadMessage[];
  createThread(title?: string): Thread;
  getTrace(traceId: string): RequestTrace | null;
  getLastTrace(): RequestTrace | null;
}

const DEFAULT_QUOTA_PATH = `${process.env.HOME ?? "."}/.multipleai/quota.db`;

export function createEngine(config: EngineConfig = {}): Engine {
  const conversations = new ConversationStore(config.conversationsPath);
  const persistConversations = config.persistConversations !== false;
  const persistTraces = config.persistTraces !== false;

  let activeTraceId: string | null = null;
  const activeAttempts: TraceAttempt[] = [];
  const traceStartedAt = { value: 0 };

  const router: Router = createRouter({
    ...config,
    dbPath: config.dbPath ?? DEFAULT_QUOTA_PATH,
    onAttempt: (event) => {
      const attempt: TraceAttempt = {
        providerId: event.providerId,
        model: event.model,
        status: event.status,
        latencyMs: event.latencyMs,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
      };
      activeAttempts.push(attempt);
      if (persistTraces && activeTraceId) {
        conversations.recordAttempt(activeTraceId, attempt);
      }
      config.onAttempt?.(event);
    },
  });

  return {
    async getProviderStatus() {
      return router.getProviderStatus();
    },

    listThreads() {
      return conversations.listThreads();
    },

    getThreadMessages(threadId: string) {
      return conversations.getThreadMessages(threadId);
    },

    createThread(title?: string) {
      return conversations.createThread(title);
    },

    getTrace(traceId: string) {
      return conversations.getTrace(traceId);
    },

    getLastTrace() {
      return conversations.getLastTrace();
    },

    async routeAndStream(request: EngineRouteRequest) {
      const traceId = randomUUID();
      activeTraceId = traceId;
      activeAttempts.length = 0;
      traceStartedAt.value = Date.now();

      if (persistTraces) {
        conversations.startTrace(traceId);
      }

      let threadId = request.threadId;
      const lastUser = [...request.messages]
        .reverse()
        .find((message) => message.role === "user");

      if (persistConversations && lastUser) {
        if (!threadId) {
          threadId = conversations.createThread(
            lastUser.content.slice(0, 48),
          ).id;
        }
        conversations.appendMessage(threadId, lastUser, { traceId });
      }

      const result = await router.routeAndStream(request);

      const wrappedStream = async function* (): AsyncGenerator<string> {
        let assistantContent = "";
        try {
          for await (const chunk of result.stream) {
            assistantContent += chunk;
            yield chunk;
          }
          if (persistConversations && threadId) {
            conversations.appendMessage(
              threadId,
              { role: "assistant", content: assistantContent },
              {
                providerId: result.providerId,
                model: result.model,
                traceId,
              },
            );
          }
        } finally {
          const completedAt = new Date();
          const trace: Omit<RequestTrace, "traceId" | "attempts"> = {
            startedAt: new Date(traceStartedAt.value),
            completedAt,
            winner: {
              providerId: result.providerId,
              model: result.model,
            },
            totalLatencyMs: completedAt.getTime() - traceStartedAt.value,
          };
          if (persistTraces) {
            conversations.completeTrace(traceId, trace);
          }
          activeTraceId = null;
        }
      };

      return {
        providerId: result.providerId,
        model: result.model,
        stream: wrappedStream(),
        traceId,
        threadId,
      };
    },
  };
}
