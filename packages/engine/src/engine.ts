import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  compileContext,
  type CompileMode,
} from "@zintus/context-compiler";
import {
  MemoryStore,
  extractFacts,
  summarizeTurns,
  summarizeWithLlm,
  consolidateFactsWithLlm,
  type CompileTraceRow,
} from "@zintus/memory";
import {
  createRouter,
  type Router,
  type RouterConfig,
} from "@zintus/router";
import type {
  ChatMessage,
  ContextMode,
  MemoryThreadState,
  PolicyConfig,
  ProviderId,
  ProviderStatus,
  RequestTrace,
  RouteRequest,
  RouteStreamResult,
  Thread,
  ThreadMessage,
  TraceAttempt,
} from "@zintus/types";
import { getKey } from "@zintus/keychain";
import { ConversationStore } from "./conversation-store.js";
import { exportRequestTrace } from "./otel.js";
import { ResponseCache } from "@zintus/cache";
import { CodeIndex } from "@zintus/codebase-indexer";
import { listProviders } from "@zintus/providers";

/** Conservative context windows (tokens) for sizing code/diff/terminal context
 *  to the target model — smaller window ⇒ the compiler auto-shrinks those
 *  blocks. Defaults generously when the model is unknown. */
function modelContextWindow(model?: string): number {
  if (!model) return 128_000;
  const m = model.toLowerCase();
  if (m.includes("gemini") || m.includes("llama-3.3-70b") || m.includes("opus") || m.includes("sonnet"))
    return 128_000;
  if (m.includes("8b") || m.includes("mini") || m.includes("flash-lite")) return 32_000;
  return 64_000;
}

export interface EngineConfig extends RouterConfig {
  conversationsPath?: string;
  persistConversations?: boolean;
  persistTraces?: boolean;
  compilerVersion?: string;
  cachePath?: string;
  enableCache?: boolean;
  /** Local workspace to index for codebase-aware context (Smart Context
   *  Engine). Defaults to $ZINTUS_WORKSPACE. Off when neither is set. */
  workspaceDir?: string;
}

export interface EngineRouteRequest extends Omit<RouteRequest, "messages"> {
  threadId?: string;
  mode?: ContextMode;
  message?: ChatMessage;
  messages?: RouteRequest["messages"];
  /** Skip the response cache lookup for this request (still writes a fresh
   *  result). Wired from a `Cache-Control: no-cache` request header. */
  bypassCache?: boolean;
  /** Raw unified git diff for this turn (compressed into context). */
  diffText?: string;
}

export interface EngineStreamResult extends RouteStreamResult {
  traceId: string;
  threadId?: string;
  compileTraceId?: string;
  compileTokenEstimate?: number;
  /** Which cache tier served the response, or "miss" when a provider was hit. */
  cacheHit?: "L1" | "L2" | "miss";
  /** Number of provider attempts that failed before one succeeded. */
  failoverCount?: number;
}

export interface Engine {
  routeAndStream(request: EngineRouteRequest): Promise<EngineStreamResult>;
  compileThreadContext(input: {
    threadId: string;
    message?: ThreadMessage["content"] | ChatMessage;
    mode?: ContextMode;
  }): Promise<{ traceId: string; messages: RouteRequest["messages"] }>;
  getThreadState(threadId: string): Record<string, unknown> | null;
  getCompileTrace(traceId: string): CompileTraceRow | null;
  getProviderStatus(): Promise<ProviderStatus[]>;
  getSavings(): { byProvider: Record<string, number>; total: number };
  /** Remaining free-tier quota ratio (0..1) for a provider — in-flight-aware
   *  (daily budget ∧ rolling-minute incl. reservations). Feeds Tokzen's
   *  quota-aware compression dial in the gateway. */
  getQuotaRemaining(provider: ProviderId): number;
  updatePolicy(policy: PolicyConfig): void;
  probeProviders(): Promise<Array<{ providerId: ProviderId; ok: boolean }>>;
  listThreads(): Thread[];
  getThreadMessages(threadId: string): ThreadMessage[];
  createThread(title?: string): Thread;
  getTrace(traceId: string): RequestTrace | null;
  getLastTrace(): RequestTrace | null;
  listTraces(limit: number): RequestTrace[];
}

const DEFAULT_QUOTA_PATH = join(homedir(), ".zintus", "quota.db");
// LLM-assisted memory makes extra network calls (and costs quota/money). It is
// strictly opt-in; the default path uses deterministic, offline summarization.
const ENABLE_MEMORY_LLM = process.env.MEMORY_LLM === "1";

function resolveCompilerVersion(): string {
  try {
    const content = readFileSync(
      new URL("../../context-compiler/package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(content) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function buildMemoryAdapter(memory: MemoryStore) {
  return {
    getThreadState: async (threadId: string): Promise<MemoryThreadState | null> => {
      const row = memory.getThreadState(threadId);
      return row ? (row.state as unknown as MemoryThreadState) : null;
    },
    getTopFacts: async (threadId: string, _query: string, limit: number) =>
      memory
        .listFacts(threadId)
        .slice(0, limit)
        .map((fact) => ({
          id: fact.id,
          content: `${fact.key}: ${fact.value}`,
          source: fact.source,
        })),
    searchChunks: async (threadId: string, query: string, topK?: number) =>
      (await memory.searchChunks(threadId, query, topK)).map((chunk) => ({
        id: String(chunk.id),
        content: chunk.content,
        relevance: chunk.relevance,
      })),
  };
}

export function createEngine(config: EngineConfig = {}): Engine {
  const conversations = new ConversationStore(config.conversationsPath);
  const persistConversations = config.persistConversations !== false;
  const persistTraces = config.persistTraces !== false;
  const memory = new MemoryStore();
  memory.init();
  const cache = config.enableCache !== false ? new ResponseCache(config.cachePath) : null;
  const compilerVersion = config.compilerVersion ?? resolveCompilerVersion();
  void compilerVersion;
  const memoryAdapter = buildMemoryAdapter(memory);

  // Codebase-aware context (Smart Context Engine). Off unless a workspace is
  // configured. Indexed lazily on first use; idempotent re-index is cheap.
  const workspaceDir = config.workspaceDir ?? process.env.ZINTUS_WORKSPACE;
  let codeIndex: CodeIndex | null = null;
  let codeIndexReady: Promise<unknown> | null = null;
  const codeSearch = workspaceDir
    ? async (query: string, topK: number) => {
        if (!codeIndex) {
          codeIndex = new CodeIndex();
          codeIndexReady = codeIndex
            .indexWorkspace(workspaceDir)
            .catch((error: unknown) => {
              console.warn("codebase-index: indexWorkspace failed", error);
            });
        }
        if (codeIndexReady) {
          await codeIndexReady;
        }
        try {
          return await codeIndex.searchCode(query, topK);
        } catch {
          return [];
        }
      }
    : undefined;

  // providerId -> its default model, for quota-aware context sizing.
  const providerDefaultModel = new Map(
    listProviders().map((p) => [p.id, p.defaultModel]),
  );

  const resolveApiKey =
    config.getApiKey ??
    (async (providerId: ProviderId) => {
      if (providerId === "ollama" || providerId === "lmstudio") {
        return null;
      }
      return getKey(providerId);
    });

  const router: Router = createRouter({
    ...config,
    dbPath: config.dbPath ?? DEFAULT_QUOTA_PATH,
    getApiKey: resolveApiKey,
  });

  function updateMemoryAfterTurn(
    threadId: string,
    lastUser: ChatMessage | undefined,
    assistantContent: string,
  ): void {
    if (assistantContent.trim().length === 0) {
      return;
    }
    // Fire-and-forget: memory maintenance must never affect or delay chat
    // streaming. Failures are logged, never thrown.
    queueMicrotask(async () => {
      try {
        const existing = memory.getThreadState(threadId);
        const state =
          (existing?.state as Record<string, unknown> | undefined) ?? {};
        const currentSummary = Array.isArray(state.workingSummary)
          ? ""
          : String(state.workingSummary ?? "");
        const turnsForMemory: ChatMessage[] = [
          ...(lastUser ? [lastUser] : []),
          { role: "assistant", content: assistantContent },
        ];
        const nextSummary = ENABLE_MEMORY_LLM
          ? await summarizeWithLlm(currentSummary, turnsForMemory)
          : summarizeTurns(currentSummary, turnsForMemory);

        if (ENABLE_MEMORY_LLM) {
          const currentFacts = memory.listFacts(threadId).map((f) => ({
            id: f.id,
            content: `${f.key}: ${f.value}`,
            source: f.source ?? undefined,
          }));
          const changes = await consolidateFactsWithLlm(currentFacts, turnsForMemory);
          
          for (const factId of changes.deletions) {
            memory.deleteFact(threadId, factId);
          }
          for (const addition of changes.additions) {
            const safeKey = `llm.${addition.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32)}`;
            memory.upsertFact({
              threadId,
              key: safeKey,
              value: addition,
              source: "llm",
            });
          }
          for (const update of changes.updates) {
            memory.upsertFact({
              id: update.id,
              threadId,
              key: update.id,
              value: update.content,
              source: "llm",
            });
          }
        } else {
          const newFacts = extractFacts(turnsForMemory);
          for (const fact of newFacts) {
            memory.upsertFact({
              id: fact.id,
              threadId,
              key: fact.id,
              value: fact.content,
              source: fact.source,
            });
          }
        }

        memory.upsertThreadState(threadId, {
          ...state,
          threadId,
          workingSummary: nextSummary,
        });

        // Index this turn for semantic recall in later turns. Without this the
        // vector-recall block queries an empty table (embedAndStoreChunk was
        // never called on the hot path). User question + assistant answer are
        // both stored so future prompts can match either.
        if (lastUser?.content && typeof lastUser.content === "string") {
          await memory.embedAndStoreChunk(threadId, lastUser.content);
        }
        await memory.embedAndStoreChunk(threadId, assistantContent);
      } catch (error) {
        console.warn(
          `[engine] memory update failed for thread ${threadId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    });
  }

  return {
    async getProviderStatus() {
      return router.getProviderStatus();
    },

    getSavings() {
      return router.getSavings();
    },

    getQuotaRemaining(provider) {
      return router.getQuotaRemaining(provider);
    },

    updatePolicy(policy) {
      router.updatePolicy(policy);
    },

    probeProviders() {
      return router.probeProviders();
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

    listTraces(limit) {
      return conversations.listTraces(limit);
    },

    async routeAndStream(request: EngineRouteRequest) {
      const latestMessage = request.message;
      const initialMessages =
        request.messages ?? (latestMessage ? [latestMessage] : []);
      if (initialMessages.length === 0) {
        throw new Error("messages or message is required");
      }

      let effectiveMessages = initialMessages;
      let compileTraceId: string | undefined;
      let compileTokenEstimate: number | undefined;
      const effectiveMode = request.mode ?? "smart";
      const latestUserInput =
        latestMessage?.content ?? initialMessages.at(-1)?.content ?? "";

      // When a thread is supplied, compile context from memory + server-side
      // history (the server owns conversation history). The new user input is
      // passed separately as `newUserMessage`, and prior turns come from the
      // server's episodic store — so even when the client also sends a full
      // `messages` array, there is no double-count: we use the server's view.
      // Callers that pass no threadId (e.g. one-shot/stateless) still go
      // verbatim. This is what puts the compiler (and its context blocks) on
      // the live hot path instead of being bypassed by the web client.
      if (request.threadId) {
        // Quota-aware sizing (the moat): if a provider is forced, use its
        // window; otherwise size to the SMALLEST window among providers that
        // currently have quota, so the compiled context fits whatever free
        // model the router actually picks right now.
        let contextWindow = modelContextWindow(request.model);
        if (!request.model) {
          try {
            const windows = (await router.getProviderStatus())
              .filter((s) => s.available)
              .map((s) => modelContextWindow(providerDefaultModel.get(s.id)));
            if (windows.length) {
              contextWindow = Math.min(...windows);
            }
          } catch {
            // keep the default window
          }
        }
        const compiled = await compileContext({
          threadId: request.threadId,
          newUserMessage: latestUserInput,
          mode: effectiveMode as CompileMode,
          memory: memoryAdapter,
          episodicMessages: conversations.getThreadMessages(request.threadId),
          targetModel: request.model,
          contextWindow,
          codeSearch,
          diffText: request.diffText,
        });
        effectiveMessages = compiled.messages;
        compileTokenEstimate = compiled.tokenEstimate;
        try {
          const stored = memory.recordCompileTrace(
            request.threadId,
            compiled.compileTrace as unknown as Record<string, unknown>,
          );
          compileTraceId = String(stored.id);
        } catch {
          compileTraceId = undefined;
        }
      }

      const traceId = randomUUID();
      const attempts: TraceAttempt[] = [];
      const traceStartedAt = Date.now();

      if (persistTraces) {
        conversations.startTrace(traceId);
      }

      let threadId = request.threadId;
      const lastUser = [...effectiveMessages]
        .reverse()
        .find((message) => message.role === "user");

      if (persistConversations && lastUser) {
        if (!threadId) {
          threadId = conversations.createThread(lastUser.content.slice(0, 48)).id;
        }
        conversations.appendMessage(threadId, lastUser, { traceId });
      }

      const targetProvider = request.provider ?? "auto";
      const targetModel = request.model ?? "auto";

      if (cache && !request.bypassCache) {
        const cacheKey = cache.generateKey(effectiveMessages, {
          model: targetModel,
          providerId: targetProvider,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        });
        let cacheHit: "L1" | "L2" = "L1";
        let cachedResponse = cache.getL1(cacheKey);
        if (cachedResponse === null && lastUser) {
          cachedResponse = await cache.getL2(
            lastUser.content,
            targetModel,
            targetProvider,
            0.12,
          );
          cacheHit = "L2";
        }

        if (cachedResponse !== null) {
          const finalResponse = cachedResponse;
          const textStream = async function* (): AsyncGenerator<string> {
            yield finalResponse;
          };

          if (persistConversations && threadId) {
            conversations.appendMessage(
              threadId,
              { role: "assistant", content: finalResponse },
              {
                providerId: targetProvider as any,
                model: targetModel,
                traceId,
              },
            );
          }

          return {
            providerId: targetProvider as any,
            model: targetModel,
            stream: textStream(),
            traceId,
            threadId,
            compileTraceId,
            compileTokenEstimate,
            cacheHit,
            failoverCount: 0,
          };
        }
      }

      const result = await router.routeAndStream({
        ...request,
        messages: effectiveMessages,
        threadId,
        stickySessionKey: threadId
          ? `${threadId}:${request.provider ?? "auto"}`
          : undefined,
        stickySessionTtlMs: 30 * 60 * 1000,
        onAttempt: (event) => {
          attempts.push(event);
          if (persistTraces) {
            conversations.recordAttempt(traceId, event);
          }
          config.onAttempt?.(event);
        },
      });

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
            updateMemoryAfterTurn(threadId, lastUser, assistantContent);
          }
          if (cache) {
            // Key the write the SAME way as the read (targetModel/targetProvider,
            // "auto" for unforced requests) so an identical prompt actually hits
            // L1 next time. Keying the write by the winner's resolved
            // provider/model instead would never match the auto-routed read key.
            await cache.set(effectiveMessages, assistantContent, {
              model: targetModel,
              providerId: targetProvider,
              temperature: request.temperature,
              maxTokens: request.maxTokens,
              threadId,
            });
          }
        } finally {
          const completedAt = new Date();
          const trace: Omit<RequestTrace, "traceId" | "attempts"> = {
            startedAt: new Date(traceStartedAt),
            completedAt,
            winner: {
              providerId: result.providerId,
              model: result.model,
            },
            totalLatencyMs: completedAt.getTime() - traceStartedAt,
          };
          if (persistTraces) {
            conversations.completeTrace(traceId, trace);
          }
          exportRequestTrace({
            trace: { traceId, attempts: [...attempts], ...trace },
            cacheHit: "miss",
            compileTokens: compileTokenEstimate,
            failoverCount: attempts.filter((a) => a.status === "fail").length,
          });
        }
      };

      return {
        providerId: result.providerId,
        model: result.model,
        stream: wrappedStream(),
        traceId,
        threadId,
        compileTraceId,
        compileTokenEstimate,
        cacheHit: "miss",
        failoverCount: attempts.filter((a) => a.status === "fail").length,
      };
    },

    async compileThreadContext(input) {
      const latest =
        input.message == null
          ? undefined
          : typeof input.message === "string"
            ? { role: "user" as const, content: input.message }
            : { role: input.message.role, content: input.message.content };
      const compiled = await compileContext({
        threadId: input.threadId,
        newUserMessage: latest?.content ?? "",
        mode: (input.mode ?? "smart") as CompileMode,
        memory: memoryAdapter,
        episodicMessages: conversations.getThreadMessages(input.threadId),
      });
      try {
        const stored = memory.recordCompileTrace(
          input.threadId,
          compiled.compileTrace as unknown as Record<string, unknown>,
        );
        return { traceId: String(stored.id), messages: compiled.messages };
      } catch {
        return { traceId: "0", messages: compiled.messages };
      }
    },

    getThreadState(threadId: string) {
      return memory.getThreadState(threadId)?.state ?? null;
    },

    getCompileTrace(traceId: string) {
      const parsed = Number(traceId);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
      }
      return memory.getCompileTrace(parsed);
    },
  };
}
