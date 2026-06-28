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
import { textOf, requiresVision, requiresStructuredOutput, requiresTools, hasToolTurns } from "@zintus/types";
import { getKey } from "@zintus/keychain";
import { ConversationStore } from "./conversation-store.js";
import { exportRequestTrace, nowEpochMs } from "./otel.js";
import { ResponseCache } from "@zintus/cache";
import { CodeIndex } from "@zintus/codebase-indexer";
import { listProviders, structuredOutputLevel } from "@zintus/providers";
import {
  validateJson,
  extractJsonObject,
  repairInstruction,
  type ValidationIssue,
} from "@zintus/schemas";

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

/** Minimal JSON-coercion instruction injected on the FIRST structured attempt when
 *  the resolved level is `prompt` (the provider has no native JSON mode). Without
 *  it the first attempt has zero guidance to emit JSON, so it returns prose and is
 *  a guaranteed validation failure — a wasted real provider call before the repair
 *  loop can steer it. Kept terse; the schema (if any) rides along so the model can
 *  conform on the first try. */
function coercionMessage(
  schema: Record<string, unknown> | undefined,
  name: string | undefined,
): ChatMessage {
  const base =
    "Respond with ONLY a single valid JSON value. Do not include any prose, " +
    "explanation, markdown, or code fences — output raw JSON only.";
  const content = schema
    ? `${base} The JSON MUST conform to this JSON Schema${
        name ? ` ("${name}")` : ""
      }:\n${JSON.stringify(schema)}`
    : base;
  return { role: "system", content };
}

/** Build the short, human "why this provider/model" line surfaced on every
 *  platform (the consistency rule). Honest: states the strategy, any capability
 *  constraint that filtered candidates, failover count, privacy outcome, or a
 *  cache hit. */
function buildRouteReason(opts: {
  providerId: string;
  model: string;
  strategy?: string;
  failoverCount: number;
  requiresVision: boolean;
  requiresTools: boolean;
  requiresStructured: boolean;
  privacyHonored?: boolean;
  cacheHit?: "L1" | "L2" | "miss";
}): string {
  // ASCII-only punctuation: this string is also set as an HTTP header
  // (X-Zintus-Route-Reason), and header values must be Latin-1 — a unicode dash/
  // middot would throw when the Response is built.
  if (opts.cacheHit && opts.cacheHit !== "miss") {
    return `Served from ${opts.cacheHit} cache (no provider call).`;
  }
  const caps: string[] = [];
  if (opts.requiresVision) caps.push("vision");
  if (opts.requiresTools) caps.push("tools");
  if (opts.requiresStructured) caps.push("structured output");
  let reason = `Routed to ${opts.providerId} (${opts.model}) via the ${
    opts.strategy ?? "auto"
  } strategy`;
  if (caps.length) reason += ` (${caps.join(", ")}-capable)`;
  if (opts.failoverCount > 0) {
    reason += ` after ${opts.failoverCount} failover${
      opts.failoverCount > 1 ? "s" : ""
    }`;
  }
  if (opts.privacyHonored === false) {
    reason += "; Private Mode NOT honored (no privacy-safe provider available)";
  } else if (opts.privacyHonored === true) {
    reason += "; Private Mode honored";
  }
  return reason + ".";
}

export interface EngineConfig extends RouterConfig {
  conversationsPath?: string;
  persistConversations?: boolean;
  persistTraces?: boolean;
  compilerVersion?: string;
  cachePath?: string;
  enableCache?: boolean;
  /** Filesystem path for the long-term memory DB. Defaults to MemoryStore's
   *  own default (~/.zintus/memory.db). Injecting a path keeps separate
   *  engines/processes/tests from colliding on a single hidden global DB. */
  memoryPath?: string;
  /** Pre-built MemoryStore to use instead of constructing one. Takes precedence
   *  over `memoryPath`. When injected, the CALLER owns its lifecycle and
   *  Engine.close() will not close it. */
  memory?: MemoryStore;
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
  /** A short, human "why this provider/model" — strategy + failover + capability +
   *  privacy. Surfaced on every platform (the consistency rule). Always present. */
  routeReason?: string;
  /**
   * Structured-output verdict, present ONLY when the request asked for non-text
   * structured output (`responseFormat.type !== "text"`). The text `stream` for
   * a structured turn is BUFFERED (validated/repaired before return) rather than
   * token-streamed, then replayed as a single chunk so existing stream consumers
   * are unaffected.
   */
  structuredOutput?: {
    /** What the caller asked for. */
    requested: "json_object" | "json_schema";
    /** The strongest level the winning provider/model could actually serve.
     *  "prompt" = no native structured support (coerced via instruction). */
    servedLevel: "json_schema" | "json_object" | "prompt";
    /** True only when the served level GUARANTEES schema conformance AND the
     *  final output validated. */
    guaranteed: boolean;
    /** Did the final (post-repair) output pass validation? For a `json_object`
     *  request with no schema this is syntactic-JSON validity only. */
    valid: boolean;
    /** Number of validate→repair round-trips actually performed (0 = first
     *  response already valid, no repair). */
    repairAttempts: number;
    /** Outstanding validation issues when `valid` is false. */
    issues?: ValidationIssue[];
  };
  /** The parsed, validated JSON value when `structuredOutput.valid` — otherwise
   *  undefined. */
  parsed?: unknown;
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
  /** Release the DB handles this engine OWNS (conversation store, response
   *  cache, and the memory store ONLY when the engine constructed it). An
   *  injected MemoryStore is left open for its owner to close. Idempotent.
   *  Optional so lightweight fake engines (e.g. gateway tests) need not
   *  implement it; the real `createEngine` always provides it. */
  close?(): void;
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
  // Memory store is injectable so separate engines/processes/tests don't
  // collide on a single hidden global DB. `ownsMemory` is false when the caller
  // injected an instance — in that case its lifecycle (and close) belongs to
  // the caller, so Engine.close() must not close it.
  const ownsMemory = config.memory == null;
  const memory = config.memory ?? new MemoryStore(config.memoryPath);
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
      const latestUserInput = textOf(
        latestMessage?.content ?? initialMessages.at(-1)?.content ?? "",
      );

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
      // Real OTel span timing: a monotonic clock sample at request open, plus
      // the real instant each attempt is observed to complete (captured in
      // onAttempt below, parallel to `attempts`). These feed the OTLP exporter
      // so span start/end/duration are measured, not synthetic offsets.
      const otelStartMs = nowEpochMs();
      const attemptEndsMs: number[] = [];

      if (persistTraces) {
        conversations.startTrace(traceId);
      }

      let threadId = request.threadId;
      const lastUser = [...effectiveMessages]
        .reverse()
        .find((message) => message.role === "user");

      if (persistConversations && lastUser) {
        if (!threadId) {
          threadId = conversations.createThread(textOf(lastUser.content).slice(0, 48)).id;
        }
        conversations.appendMessage(threadId, lastUser, { traceId });
      }

      const targetProvider = request.provider ?? "auto";
      const targetModel = request.model ?? "auto";

      // The attempt callback is shared by every router dispatch on this turn
      // (the structured-output path re-dispatches for repairs), so all attempts
      // accumulate on the SAME trace.
      const onAttempt = (event: TraceAttempt) => {
        attempts.push(event);
        attemptEndsMs.push(nowEpochMs());
        if (persistTraces) {
          conversations.recordAttempt(traceId, event);
        }
        config.onAttempt?.(event);
      };

      // ── Structured / JSON output (buffered validate→repair) ───────────────
      // A non-text `responseFormat` takes a BUFFERED branch: the router already
      // resolved the best level this provider/model can serve, so we drain the
      // text fully, extract+validate the JSON, and (when invalid) re-dispatch
      // the SAME request with a repair instruction appended — up to the capped
      // number of round-trips. The final text is replayed as a single stream
      // chunk so existing `.stream` consumers are unaffected. Structured turns
      // bypass the response cache entirely (reads AND writes) — caching
      // unvalidated text would replay a non-conforming answer.
      if (requiresStructuredOutput(request)) {
        const schema = request.responseFormat?.schema as
          | Record<string, unknown>
          | undefined;
        // 0 = validate once, no repair; capped server-side at 2.
        const maxRepairAttempts = Math.min(
          request.responseFormat?.maxRepairAttempts ?? 2,
          2,
        );

        const dispatchAndDrain = async (
          messages: RouteRequest["messages"],
        ): Promise<{ result: RouteStreamResult; text: string }> => {
          const dispatched = await router.routeAndStream({
            ...request,
            messages,
            threadId,
            stickySessionKey: threadId
              ? `${threadId}:${request.provider ?? "auto"}`
              : undefined,
            stickySessionTtlMs: 30 * 60 * 1000,
            onAttempt,
          });
          // Drain fully — preserves the router's trace/usage/persistence
          // side-effects and yields nothing partial to the caller.
          let text = "";
          for await (const chunk of dispatched.stream) {
            text += chunk;
          }
          return { result: dispatched, text };
        };

        // Predict the level this request will resolve to (same logic the router's
        // resolveResponseFormat uses) so we can PREPEND a JSON-coercion instruction
        // on the FIRST attempt for `prompt`-level requests (providers with no native
        // JSON mode). For native json_object/json_schema providers the adapter sends
        // the real format field, so no coercion is needed. With explicit
        // provider+model this is exact; under auto routing the conservative "none →
        // prompt" prediction coerces harmlessly even if the winner is native-JSON.
        const providerLevel = structuredOutputLevel(
          targetProvider as ProviderId,
          targetModel,
        );
        const requestedType = request.responseFormat!.type;
        const predictedLevel: "json_schema" | "json_object" | "prompt" =
          requestedType === "json_schema"
            ? providerLevel === "json_schema"
              ? "json_schema"
              : providerLevel === "json_object"
                ? "json_object"
                : "prompt"
            : providerLevel === "none"
              ? "prompt"
              : "json_object";

        let convoMessages = effectiveMessages;
        if (predictedLevel === "prompt") {
          convoMessages = [
            coercionMessage(schema, request.responseFormat?.name),
            ...convoMessages,
          ];
        }
        let { result: structuredResult, text } =
          await dispatchAndDrain(convoMessages);

        let extracted = extractJsonObject(text);
        let valid = false;
        let issues: ValidationIssue[] = [];
        let repairAttempts = 0;

        const validateOnce = () => {
          extracted = extractJsonObject(text);
          if (!extracted.ok) {
            valid = false;
            issues = [{ path: "/", message: "response was not valid JSON" }];
            return;
          }
          if (schema) {
            const verdict = validateJson(schema, extracted.value);
            valid = verdict.valid;
            issues = verdict.issues;
          } else {
            // json_object request: syntactic JSON validity only.
            valid = true;
            issues = [];
          }
        };

        validateOnce();
        while (!valid && repairAttempts < maxRepairAttempts) {
          // Append the model's prior (invalid) output as an assistant turn FIRST,
          // then the repair instruction as a user turn. Omitting the assistant turn
          // creates consecutive user messages, which Gemini (the default json_schema
          // route) rejects/merges because it requires strict role alternation.
          convoMessages = [
            ...convoMessages,
            { role: "assistant", content: text },
            { role: "user", content: repairInstruction(text, issues) },
          ];
          repairAttempts += 1;
          ({ result: structuredResult, text } =
            await dispatchAndDrain(convoMessages));
          validateOnce();
        }

        // Label served_level/guaranteed from the level the router ACTUALLY served
        // (resolvedStructuredLevel), never from the raw provider capability — a
        // json_object request to a json_schema-capable provider must report
        // "json_object"/guaranteed:false, not "json_schema". guaranteed is true only
        // when the provider served json_schema AND validation passed.
        const servedLevel: "json_schema" | "json_object" | "prompt" =
          structuredResult.resolvedStructuredLevel ?? "prompt";
        const guaranteed = servedLevel === "json_schema" && valid;
        const requested = request.responseFormat!.type as
          | "json_object"
          | "json_schema";

        // Persist the FINAL assistant text + trace, mirroring the normal path's
        // side-effects. Cache writes are intentionally skipped (see above).
        if (persistConversations && threadId) {
          conversations.appendMessage(
            threadId,
            { role: "assistant", content: text },
            {
              providerId: structuredResult.providerId,
              model: structuredResult.model,
              traceId,
            },
          );
          updateMemoryAfterTurn(threadId, lastUser, text);
        }

        const completedAt = new Date();
        const trace: Omit<RequestTrace, "traceId" | "attempts"> = {
          startedAt: new Date(traceStartedAt),
          completedAt,
          winner: {
            providerId: structuredResult.providerId,
            model: structuredResult.model,
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
          startMs: otelStartMs,
          endMs: nowEpochMs(),
          attemptEndsMs: [...attemptEndsMs],
        });

        const finalText = text;
        const replayStream = async function* (): AsyncGenerator<string> {
          yield finalText;
        };

        return {
          providerId: structuredResult.providerId,
          model: structuredResult.model,
          stream: replayStream(),
          traceId,
          threadId,
          compileTraceId,
          compileTokenEstimate,
          cacheHit: "miss",
          failoverCount: attempts.filter((a) => a.status === "fail").length,
          privacyHonored: structuredResult.privacyHonored,
          routeReason: buildRouteReason({
            providerId: structuredResult.providerId,
            model: structuredResult.model,
            strategy: request.strategy,
            failoverCount: attempts.filter((a) => a.status === "fail").length,
            requiresVision: requiresVision(effectiveMessages),
            requiresTools: false,
            requiresStructured: true,
            privacyHonored: structuredResult.privacyHonored,
          }),
          structuredOutput: {
            requested,
            servedLevel,
            guaranteed,
            valid,
            repairAttempts,
            issues: valid ? undefined : issues,
          },
          parsed: valid ? extracted.value : undefined,
        };
      }

      // Skip the cache READ for tool and structured requests. The cache only ever
      // stores plain-text answers (tool/structured turns skip the WRITE), so a
      // cached text reply could replay and silently DROP the tool calls / structured
      // output a tools-or-responseFormat request explicitly asked for. (Structured
      // requests already returned above; the guard is kept for defense in depth.)
      // `requiresTools` only catches turns that carry a NEW `tools` field; a
      // CONTINUATION turn replaying tool_call/tool_result blocks (no `tools` field)
      // would otherwise slip through — its lastUser is a pure tool_result whose
      // `textOf` is "", driving an empty-string L2 lookup — so also guard on
      // `hasToolTurns(messages)`.
      if (
        cache &&
        !request.bypassCache &&
        !requiresTools(request) &&
        !requiresStructuredOutput(request) &&
        !hasToolTurns(effectiveMessages)
      ) {
        // SCOPED-CACHE NOTE (assessed, intentionally NOT scoped here): the L1
        // key (prompt/model/provider/temp/maxTokens) and the L2 semantic lookup
        // (prompt embedding + model + provider) are NOT scoped by user / thread
        // / workspace. This is safe because the engine's ResponseCache is a
        // single-user, machine-local DB (~/.zintus/cache.db) — every entry was
        // produced by, and is served back to, the same local user. The risk
        // would be cross-user leakage IF this same cache instance were ever
        // shared across users (e.g. a multi-tenant relay); in that case the
        // cache key MUST gain a scope dimension. The store already carries
        // userId/threadId columns for that future, but threading a scope into
        // the key/lookup lives in @zintus/cache, which is outside this change's
        // scope. See docs/agents/CORE.md ("Response cache scope").
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
            textOf(lastUser.content),
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

          // A cache hit is a real, observable outcome — finish the trace the
          // SAME way the provider path does (winner, latency, completedAt) so
          // observability never silently drops or lies about cache hits. The
          // hit tier is carried out-of-band via the OTLP `zintus.cache.hit`
          // attribute (cacheStatus = "L1"/"L2", i.e. a hit, vs "miss").
          const cacheCompletedAt = new Date();
          const cacheTrace: Omit<RequestTrace, "traceId" | "attempts"> = {
            startedAt: new Date(traceStartedAt),
            completedAt: cacheCompletedAt,
            winner: { providerId: targetProvider as ProviderId, model: targetModel },
            totalLatencyMs: cacheCompletedAt.getTime() - traceStartedAt,
          };
          if (persistTraces) {
            conversations.completeTrace(traceId, cacheTrace);
          }
          exportRequestTrace({
            trace: { traceId, attempts: [], ...cacheTrace },
            cacheHit,
            compileTokens: compileTokenEstimate,
            failoverCount: 0,
            startMs: otelStartMs,
            endMs: nowEpochMs(),
          });

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
            routeReason: buildRouteReason({
              providerId: String(targetProvider),
              model: targetModel,
              failoverCount: 0,
              requiresVision: false,
              requiresTools: false,
              requiresStructured: false,
              cacheHit,
            }),
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
          // Stamp the real instant this attempt finished (the engine only
          // observes attempts on completion). Kept parallel to `attempts` so
          // the exporter can place each attempt span on the real timeline.
          attemptEndsMs.push(nowEpochMs());
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
          // Never cache a tool-call turn: its text is empty/partial and the tool
          // calls (the real payload) aren't cached, so a cache hit would replay an
          // empty answer for a prompt that actually wanted a tool invocation. The
          // `result.toolCalls` check only catches a turn whose RESPONSE emitted new
          // calls; a continuation turn carrying tool_result blocks in its history
          // (final synthesis, no new calls) is caught by `hasToolTurns` so L2 never
          // embeds the empty-string body of a pure tool_result turn.
          if (
            cache &&
            !(result.toolCalls && result.toolCalls.length > 0) &&
            !hasToolTurns(effectiveMessages)
          ) {
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
            startMs: otelStartMs,
            endMs: nowEpochMs(),
            attemptEndsMs: [...attemptEndsMs],
          });
        }
      };

      return {
        providerId: result.providerId,
        model: result.model,
        stream: wrappedStream(),
        // Forward the router's live tool-call channel by REFERENCE so the gateway
        // reads completed tool calls after draining the (text) stream. Populated as
        // `result.stream` drains via `wrappedStream`.
        toolCalls: result.toolCalls,
        traceId,
        threadId,
        compileTraceId,
        compileTokenEstimate,
        cacheHit: "miss",
        failoverCount: attempts.filter((a) => a.status === "fail").length,
        privacyHonored: result.privacyHonored,
        routeReason: buildRouteReason({
          providerId: result.providerId,
          model: result.model,
          strategy: request.strategy,
          failoverCount: attempts.filter((a) => a.status === "fail").length,
          requiresVision: requiresVision(effectiveMessages),
          requiresTools: requiresTools(request),
          requiresStructured: requiresStructuredOutput(request),
          privacyHonored: result.privacyHonored,
        }),
      };
    },

    async compileThreadContext(input) {
      const latest =
        input.message == null
          ? undefined
          : typeof input.message === "string"
            ? { role: "user" as const, content: input.message }
            : { role: input.message.role, content: textOf(input.message.content) };
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

    close() {
      // Close only what this engine owns. Each close is best-effort and never
      // throws so a partial failure can't strand the rest of the shutdown.
      // `close?.()` is used for stores that may not (yet) expose a close hook
      // (e.g. MemoryStore / ResponseCache live in packages outside this scope);
      // it becomes a real close the moment those packages add the method.
      try {
        conversations.close();
      } catch {
        /* already closed / never opened */
      }
      try {
        (cache as { close?: () => void } | null)?.close?.();
      } catch {
        /* already closed */
      }
      if (ownsMemory) {
        try {
          (memory as { close?: () => void }).close?.();
        } catch {
          /* already closed */
        }
      }
    },
  };
}
