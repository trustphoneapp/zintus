import type {
  AppConfig,
  ContentBlock,
  ContextMode,
  ProviderId,
  ToolCallContentBlock,
  ToolChoice,
  ToolDefinition,
  ResponseFormat,
} from "@zintus/types";
import {
  fetchGatewayHealth,
  streamGatewayChat,
  type ChatMcpConfig,
  type ChatMeta,
  type CompressionStats,
  type McpToolEvent,
} from "./gateway";

export { UnsupportedCapabilityError } from "./gateway";
export type { ChatMcpConfig, McpToolEvent } from "./gateway";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  /** Plain text, OR an ordered content-block array (text first, then images). */
  content: string | ContentBlock[];
}

function isEmptyContent(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return content.trim() === "";
  return content.length === 0;
}

/**
 * Clean a store-derived conversation before it is sent to the gateway. The
 * tool-execution loop can leave the message store with empty-content assistant
 * bubbles (a tool round with no preamble text) and/or two adjacent assistant
 * turns (one per round). Replaying that verbatim produces a malformed multi-turn
 * conversation (empty assistant content + adjacent same-role turns) that strict
 * role-alternation providers (e.g. Gemini) reject. This returns a cleaned COPY:
 *   (a) drops any assistant turn whose content is empty (blank string or empty
 *       block array);
 *   (b) merges adjacent same-role turns whose content are both strings (joined
 *       with a newline); non-string (ContentBlock[]) turns are pushed un-merged.
 * Order is preserved and the input is never mutated.
 */
export function sanitizeSendHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && isEmptyContent(m.content)) continue;
    const last = out[out.length - 1];
    if (
      last &&
      last.role === m.role &&
      typeof last.content === "string" &&
      typeof m.content === "string"
    ) {
      last.content = `${last.content}\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** Minimal shape `imageAwareHistory` reads — a stored UI message (see app-store's
 *  `UiMessage`). Kept structural so this module never imports app-store. */
export interface StoredTurn {
  role: "user" | "assistant";
  content: string;
  images?: readonly unknown[];
}

/**
 * Build send-history turns from stored messages. A prior USER turn that carried
 * image(s) keeps only its TEXT in history — base64 is never persisted — so we
 * append a one-line note. Without it the model conflates the assistant's earlier
 * image description with a NEW image attached in a later turn and answers "the
 * same screenshot as before" instead of reading the new one. The note tells the
 * model that earlier turn had its own, now-omitted image. Order is preserved and
 * the input is never mutated. Non-image and assistant turns pass through as-is.
 */
export function imageAwareHistory(
  messages: readonly StoredTurn[],
): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === "user" && m.images && m.images.length > 0) {
      const n = m.images.length;
      return {
        role: m.role,
        content: `${m.content}\n\n[This earlier message had ${n} attached image${
          n === 1 ? "" : "s"
        }, not shown here — a different image from any attached later.]`,
      };
    }
    return { role: m.role, content: m.content };
  });
}

export interface StreamChatResult {
  providerId: ProviderId;
  model: string;
  threadId?: string;
  traceId?: string;
  compileTokens?: number;
  meta?: ChatMeta;
  compression?: CompressionStats;
  /** Tool calls the model made this turn (empty for a normal text turn). The
   *  caller runs the tools and sends results back as tool_result blocks. */
  toolCalls?: ToolCallContentBlock[];
  /** Server-side MCP tool-loop events emitted this turn (display only). */
  toolEvents?: McpToolEvent[];
  source: "gateway";
}

export async function isGatewayAvailable(): Promise<boolean> {
  const health = await fetchGatewayHealth();
  return Boolean(health?.ok);
}

export async function streamChat(params: {
  messages: ChatMessage[];
  providerId?: ProviderId;
  /** Specific model id (catalog "Use this model"); else the provider default. */
  model?: string;
  mode?: ContextMode;
  threadId?: string;
  /** Active project id — compiles the project's memory facts into context. */
  projectId?: string;
  /** `false` = incognito/private: the gateway persists nothing for this turn. */
  persist?: boolean;
  apiKeys?: Partial<Record<ProviderId, string>>;
  settings?: AppConfig;
  webSearch?: boolean;
  temperature?: number;
  /** Tool/function definitions for this turn. Requires a tool-capable provider —
   *  the gateway returns a structured 422 otherwise. */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** Structured-output request (e.g. { type: "json_object" }). */
  responseFormat?: ResponseFormat;
  /** Configured MCP servers for this turn — the gateway runs them server-side
   *  and streams tool-loop events; the web only displays them. */
  mcp?: ChatMcpConfig;
  /** Opt-in artifact/canvas mode: adds the artifact-authoring system instruction. */
  artifactMode?: boolean;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
  /** Live callback for each server-side MCP tool-loop event (call/result). */
  onMcpToolEvent?: (event: McpToolEvent) => void;
}): Promise<StreamChatResult> {
  const gatewayUp = await isGatewayAvailable();

  if (!gatewayUp) {
    throw new Error(
      "No gateway connected. Zintus is local-first — start your gateway with `zintus serve`, then add a provider key (zintus keys set groq <your-key>). Self-host guide: /docs#self-host",
    );
  }

  const result = await streamGatewayChat({
    messages: params.messages,
    providerId: params.providerId,
    model: params.model,
    defaultProvider: params.settings?.defaultProvider,
    strategy: params.settings?.routingStrategy,
    mode: params.mode ?? params.settings?.contextMode,
    threadId: params.threadId,
    persist: params.persist,
    projectId: params.projectId,
    webSearch: params.webSearch,
    blockTraining: params.settings?.blockTrainingProviders,
    allowTraining: params.settings?.allowTrainingProviders,
    keys: params.apiKeys,
    temperature: params.temperature,
    tools: params.tools,
    toolChoice: params.toolChoice,
    responseFormat: params.responseFormat,
    mcp: params.mcp,
    artifactMode: params.artifactMode,
    signal: params.signal,
    onChunk: params.onChunk,
    onMcpToolEvent: params.onMcpToolEvent,
  });

  return { ...result, source: "gateway" };
}
