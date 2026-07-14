/**
 * Streaming client for the relay's managed-membership chat path
 * (`POST /v1/managed/chat/completions`, see workers/relay/src/managed.ts).
 *
 * This is the ONLY web chat path that does not go through the local gateway: an
 * active member's request is served relay-side with Zintus-owned keys and billed
 * against plan tokens, so there is no local key, no local routing, and no local
 * quota ledger involved. Everything else (BYOK/local models) keeps using
 * streamChat → the gateway.
 *
 * Ported from apps/desktop/lib/managed-chat.ts. The one browser-specific change:
 * the request is a CREDENTIALED cross-subdomain fetch (`credentials: "include"`)
 * so the HttpOnly `zintus_session` cookie authenticates it — desktop instead
 * sends an `Authorization: Bearer` token. The relay accepts either (requireSession
 * in workers/relay/src/index.ts) and already returns credentialed CORS for this
 * origin via the global `app.use("*", cors({ credentials: true, … }))`.
 */

import { RELAY_URL } from "./cloud";

/** Minimal message shape the relay accepts. Managed v1 models are text-only
 *  (no vision/tools), so content is always a plain string here. */
export interface ManagedChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ManagedStreamResult {
  /** Managed model id that served the turn (e.g. "zintus/llama-3.3-70b"). */
  model: string;
  /** Upstream that actually served it (X-Zintus-Served-By), e.g. "groq". */
  servedBy: string | null;
  /** Provider-reported usage from the final SSE chunk, when present. */
  usage: { inputTokens: number; outputTokens: number } | null;
  /**
   * Plan tokens this turn debited, for THIS member's tier — computed from the
   * relay's X-Zintus-Plan-Per-1k header (plan tokens per 1K real tokens for
   * the served model's class) × the reported usage. Null when the relay
   * predates the header or usage was never reported. PRICING-FINAL Part 6.
   */
  planTokensDebited: number | null;
  /** Pricing class of the served model (X-Zintus-Class), e.g. "premium". */
  modelClass: string | null;
  latencyMs: number;
}

export type ManagedChatError =
  | { kind: "membership_required" }
  | { kind: "plan_tokens_exhausted"; used: number; limit: number; reset: number }
  | { kind: "model_unavailable" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

export class ManagedChatFailure extends Error {
  readonly detail: ManagedChatError;
  constructor(detail: ManagedChatError) {
    super(
      detail.kind === "error" ? detail.message : `managed chat failed: ${detail.kind}`,
    );
    this.detail = detail;
    this.name = "ManagedChatFailure";
  }
}

/** Map a relay error payload to a typed failure the UI can speak honestly about. */
export function classifyManagedError(
  status: number,
  body: { code?: string; error?: string; used?: number; limit?: number; reset?: number },
): ManagedChatError {
  if (status === 401) return { kind: "unauthorized" };
  if (body.code === "membership_required") return { kind: "membership_required" };
  if (body.code === "plan_tokens_exhausted") {
    return {
      kind: "plan_tokens_exhausted",
      used: body.used ?? 0,
      limit: body.limit ?? 0,
      reset: body.reset ?? 0,
    };
  }
  if (body.code === "model_unavailable") return { kind: "model_unavailable" };
  return { kind: "error", message: body.error ?? `relay error ${status}` };
}

/**
 * Map a typed managed failure to the exact honest, no-upsell sentence shown in
 * the chat. Mirrors the desktop wording so the two surfaces read identically.
 */
export function managedFailureMessage(detail: ManagedChatError): string {
  switch (detail.kind) {
    case "membership_required":
      return "This model needs an active Zintus membership. Pick a plan on the Pricing page — or use a BYOK provider.";
    case "plan_tokens_exhausted":
      return `Your plan tokens for this month are used up (${detail.used.toLocaleString()} of ${detail.limit.toLocaleString()}). They reset on ${new Date(detail.reset * 1000).toLocaleDateString()} — until then your own provider keys keep working.`;
    case "unauthorized":
      return "Your Zintus sign-in expired. Sign in again to keep using membership models.";
    case "model_unavailable":
      return "That managed model is not available right now. Pick another from the model menu.";
    default:
      return detail.message;
  }
}

/**
 * Parse OpenAI-dialect SSE `data:` payloads out of a text buffer. Returns the
 * unconsumed tail. Exported for tests.
 */
export function drainSseBuffer(
  buffer: string,
  onDelta: (text: string) => void,
  onUsage: (usage: { inputTokens: number; outputTokens: number }) => void,
): string {
  const events = buffer.split("\n\n");
  const tail = events.pop() ?? "";
  for (const evt of events) {
    for (const line of evt.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) onDelta(delta);
        if (typeof json.usage?.prompt_tokens === "number") {
          onUsage({
            inputTokens: json.usage.prompt_tokens,
            outputTokens: json.usage.completion_tokens ?? 0,
          });
        }
      } catch {
        // Ignore malformed frames; the stream continues.
      }
    }
  }
  return tail;
}

export async function streamManagedChat(params: {
  model: string;
  messages: ManagedChatMessage[];
  responseFormat?: { type: string };
  /** Web search toggle — the relay fetches and injects results server-side,
   *  so every managed model honors it regardless of native capability. */
  search?: { enabled: boolean };
  signal?: AbortSignal;
  onChunk: (text: string) => void;
}): Promise<ManagedStreamResult> {
  const startedAt = Date.now();
  const res = await fetch(`${RELAY_URL}/v1/managed/chat/completions`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      stream: true,
      ...(params.search?.enabled ? { search: { enabled: true } } : {}),
      ...(params.responseFormat?.type === "json_object"
        ? { response_format: { type: "json_object" } }
        : {}),
    }),
    signal: params.signal,
  });

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      error?: string;
      used?: number;
      limit?: number;
      reset?: number;
    };
    throw new ManagedChatFailure(classifyManagedError(res.status, body));
  }

  let usage: { inputTokens: number; outputTokens: number } | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = drainSseBuffer(buffer, params.onChunk, (u) => {
      usage = u;
    });
  }
  // Flush any final complete frame that arrived without a trailing blank line.
  drainSseBuffer(buffer + "\n\n", params.onChunk, (u) => {
    usage = u;
  });

  const planPer1kRaw = res.headers.get("X-Zintus-Plan-Per-1k");
  const planPer1k = planPer1kRaw != null ? Number(planPer1kRaw) : NaN;
  // TS can't see the closure assignments above; re-widen from the declaration.
  const finalUsage = usage as { inputTokens: number; outputTokens: number } | null;
  const planTokensDebited =
    finalUsage && Number.isFinite(planPer1k)
      ? Math.round(((finalUsage.inputTokens + finalUsage.outputTokens) * planPer1k) / 1000)
      : null;

  return {
    model: res.headers.get("X-Zintus-Model") ?? params.model,
    servedBy: res.headers.get("X-Zintus-Served-By"),
    usage,
    planTokensDebited,
    modelClass: res.headers.get("X-Zintus-Class"),
    latencyMs: Date.now() - startedAt,
  };
}

/** A managed model id is the relay's `zintus/…` public id (never a BYOK model). */
export function isManagedModelId(id: string): boolean {
  return id.startsWith("zintus/");
}
