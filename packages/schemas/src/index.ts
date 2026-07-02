import { z } from "zod";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { PROVIDER_IDS, type ProviderId } from "@zintus/types";

/**
 * Runtime-validated request schemas shared by the gateway and the cloud relay.
 *
 * Kept separate from `@zintus/types` (which is pure compile-time types with no
 * runtime dependency) so that package stays dependency-free. zod is edge-safe,
 * so the Cloudflare relay imports the same schemas the Bun gateway does.
 *
 * `safeParse(...)` returns `{ success, data | error }`; format failures into a
 * 400 with `error.issues` rather than letting malformed JSON reach the engine.
 */

// ── Gateway: chat completions ──────────────────────────────────────────────

// "tool" accepts an OpenAI-native tool-result message (`{role:"tool",
// tool_call_id, content}`); the gateway normalizes it to a user-turn tool_result
// block before routing (the internal ChatMessage role stays system|user|assistant).
export const ChatRole = z.enum(["system", "user", "assistant", "tool"]);

// Processed image cap (mirrors packages/media's default maxOutputBytes). The
// gateway re-checks this server-side; this is the edge guard.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

// image/jpeg|png|webp only — the enum rejects svg/gif/video/pdf at the edge.
const ImageBlockSchema = z.object({
  type: z.literal("image"),
  // Raw base64 ONLY — reject a `data:` URI prefix.
  data: z
    .string()
    .min(1)
    .refine((s) => !s.startsWith("data:"), {
      message: "image.data must be raw base64 with no data: prefix",
    }),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  // Must be literally true — a missing/false flag is rejected (no un-stripped images).
  exifStripped: z.literal(true),
  name: z.string().optional(),
});

// A model's request to invoke a tool, replayed on the assistant turn of a
// continued tool conversation.
const ToolCallBlockSchema = z.object({
  type: z.literal("tool_call"),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

// The client's result for a prior tool call, sent back on the next turn. Without
// this the multi-turn tool loop is impossible over HTTP (the continuation turn
// would 400 at the edge).
const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolCallId: z.string().min(1),
  content: z.string(),
  isError: z.boolean().optional(),
});

const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ImageBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
]);

// OpenAI-native tool-call shape carried on an assistant turn's top-level
// `tool_calls`. The gateway EMITS this shape (handler.ts), so it must also
// ACCEPT it when a stock OpenAI client echoes the assistant turn back —
// otherwise the call is silently lost on the round-trip. parseMessages converts
// these into internal `tool_call` content blocks.
const OpenAiToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

export const ChatMessageSchema = z
  .object({
    role: ChatRole,
    // Backward compatible: a plain string (original shape) OR a non-empty array
    // of content blocks (multimodal / tool turns). Existing string clients are
    // unaffected. May be null/absent ONLY on an assistant turn that carries
    // top-level `tool_calls` (the OpenAI-native tools-only shape).
    content: z
      .union([z.string(), z.array(ContentBlockSchema).min(1)])
      .nullable()
      .optional(),
    // Present on an OpenAI-native `{role:"tool"}` message (correlates the result
    // to a prior tool call). Ignored for other roles.
    tool_call_id: z.string().optional(),
    // OpenAI-native assistant tool calls. Allowed so a stock OpenAI client can
    // replay the assistant turn the gateway emitted; normalized downstream.
    tool_calls: z.array(OpenAiToolCallSchema).optional(),
  })
  .refine(
    (m) => m.content != null || (m.tool_calls != null && m.tool_calls.length > 0),
    { message: "message content is required unless tool_calls is present" },
  );

// Exact ProviderId union, DERIVED from @zintus/types PROVIDER_IDS so an
// unknown provider is rejected at the edge with a 400 rather than failing
// downstream — and so the enum can never again silently lag the real provider
// set (it did when the set grew 12 → 22 on 2026-07-02). @zintus/types stays
// dependency-free and PROVIDER_IDS is a plain const array, so this is
// edge-safe for the relay.
const ProviderIdSchema = z.enum(
  PROVIDER_IDS as unknown as [ProviderId, ...ProviderId[]],
);

const ContextModeSchema = z.enum(["fast", "smart", "deep"]);
const RoutingStrategySchema = z.enum([
  "fastest",
  "capability",
  "economy",
  "quality",
  "balanced",
  "weighted",
]);
const SearchDepthSchema = z.enum(["basic", "standard", "deep"]);

// OpenRouter-style provider routing preferences. The chat body's `provider`
// field accepts EITHER the legacy Zintus forced-provider STRING (`"groq"` — pins
// the request to one provider) OR this OBJECT (OpenRouter's shape), which the
// gateway MAPS onto the existing strategy / priority / failover machinery:
//   • `order`           → per-request provider preference order (sticky order)
//   • `sort:"latency"`  → `fastest` strategy   (lowest measured p95 wins)
//   • `sort:"price"`    → `economy` strategy   (cheapest paid-equivalent wins)
//   • `sort:"throughput"` → `fastest` strategy (Zintus's speed signal is p95
//                            latency; throughput and latency are correlated and
//                            we never fabricate a tokens/sec ranking we lack)
//   • `allow_fallbacks:false` → pin the request to the FIRST eligible provider
//                            (no failover to other providers/models)
export const ProviderRoutingSchema = z.object({
  order: z.array(ProviderIdSchema).optional(),
  sort: z.enum(["price", "throughput", "latency"]).optional(),
  allow_fallbacks: z.boolean().optional(),
});

export const SearchOptionsSchema = z.object({
  enabled: z.boolean().optional(),
  depth: SearchDepthSchema.optional(),
  maxResults: z.number().int().positive().max(50).optional(),
});

// Tool / function-calling definitions. Mirrors @zintus/types ToolDefinition.
// `name` uses the provider-intersection charset/length so a name accepted here
// is valid for every adapter (OpenAI-compat + Gemini). `parameters` is an
// arbitrary JSON-Schema object passed through to the provider untouched.
export const ToolDefinitionSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  strict: z.boolean().optional(),
});

// How the model may use tools this turn. Either a mode string or a forced tool.
export const ToolChoiceSchema = z.union([
  z.enum(["auto", "required", "none"]),
  z.object({ type: z.literal("tool"), name: z.string() }),
]);

// ── MCP (Model Context Protocol) — gateway-hosted, server-side tool calling ──
// How to reach an MCP server. Discriminated on `transport` — mirrors
// @zintus/mcp's `MCPServerConfig`. `stdio` spawns a LOCAL user process (its
// command is the user's own config; the loopback gateway hosts it). `sse`/`http`
// reach a remote MCP endpoint. Validated at the edge so a malformed config is
// rejected before it reaches the registry.
export const MCPServerConfigSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    transport: z.literal("sse"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    transport: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

// Optional chat-request block: the gateway connects each MCP server, gathers its
// tools (filtered by `enabledTools` when present), and runs a SERVER-SIDE bounded
// tool loop. Bounded server count keeps a single request from spawning unbounded
// child processes / connections.
export const MCPRequestSchema = z.object({
  servers: z.array(MCPServerConfigSchema).max(16),
  enabledTools: z.array(z.string()).optional(),
});

// Body for the standalone discover / disconnect endpoints.
export const MCPDiscoverRequestSchema = z.object({
  config: MCPServerConfigSchema,
});

export type MCPServerConfigInput = z.infer<typeof MCPServerConfigSchema>;

/**
 * Structured-output request (`response_format`). Mirrors @zintus/types
 * `ResponseFormat`. `json_schema` asks for schema-conformant JSON; `json_object`
 * asks only for syntactically-valid JSON; `text` is the default free-form
 * behavior. `maxRepairAttempts` is capped at 2 (matches the server-side cap on
 * validate→repair round-trips). `schema` is an arbitrary JSON-Schema object
 * passed through to the validator/provider; it is REQUIRED when
 * `type === "json_schema"` — enforced by the refine below so a strict request
 * without a schema is rejected at the edge rather than failing downstream.
 */
export const ResponseFormatSchema = z
  .object({
    type: z.enum(["text", "json_object", "json_schema"]),
    schema: z.record(z.string(), z.unknown()).optional(),
    name: z.string().optional(),
    strict: z.boolean().optional(),
    maxRepairAttempts: z.number().int().min(0).max(2).optional(),
  })
  .refine((rf) => rf.type !== "json_schema" || rf.schema != null, {
    message: "response_format.type 'json_schema' requires a schema",
  });

/**
 * Chat body. Mirrors the OpenAI-compatible shape the gateway accepts. Either
 * `messages` or (`message` + `thread_id`) must be present — enforced by the
 * handler's parseMessages, kept permissive here so existing clients are not
 * broken. Unknown keys are stripped (mild hardening).
 */
export const ChatCompletionRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).optional(),
  message: z
    .union([z.string(), z.object({ role: z.string().optional(), content: z.string() })])
    .optional(),
  model: z.string().optional(),
  stream: z.boolean().optional(),
  // Either the legacy forced-provider STRING or the OpenRouter-style routing
  // OBJECT (mapped onto strategy/priority/failover by the gateway). See
  // ProviderRoutingSchema.
  provider: z.union([ProviderIdSchema, ProviderRoutingSchema]).optional(),
  thread_id: z.string().optional(),
  // When the turn belongs to a project, its project-scoped memory facts are
  // compiled alongside thread + global facts.
  project_id: z.string().optional(),
  projectId: z.string().optional(),
  mode: ContextModeSchema.optional(),
  // Opt-in artifact/canvas mode: append artifact-authoring instructions to the
  // system prompt so the model emits ```artifact``` blocks. Default off.
  artifact_mode: z.boolean().optional(),
  virtual_key: z.string().optional(),
  virtualKey: z.string().optional(),
  provider_weights: z.record(z.string(), z.number()).optional(),
  providerWeights: z.record(z.string(), z.number()).optional(),
  strategy: RoutingStrategySchema.optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  diff: z.string().optional(),
  // Privacy mode: drop providers that may train on user data, with an allow-list
  // of providers the user explicitly permits even so.
  block_training: z.boolean().optional(),
  allow_training: z.array(ProviderIdSchema).optional(),
  // Local durability control (orthogonal to block_training, which is provider-
  // training privacy). false = incognito/ephemeral: the engine writes NO durable
  // state (conversation, memory facts, summary, chunks, compile traces, response
  // cache), skips OTel trace export, and the gateway records no activity row.
  // Default true.
  persist: z.boolean().optional(),
  // Per-request BYOK keys (provider -> key) for the LOCAL gateway only. Never
  // logged, never persisted, never forwarded to the relay.
  keys: z.record(ProviderIdSchema, z.string()).optional(),
  search: SearchOptionsSchema.optional(),
  // Tool / function calling. Presence of `tools` makes the request require a
  // tool-capable provider/model — the gateway gates this (422 when unsupported)
  // and threads both into the engine request.
  tools: z.array(ToolDefinitionSchema).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  // Structured / JSON output. Absent ⇒ plain text (unchanged behavior). A
  // `json_schema` request without a `schema` is rejected by ResponseFormatSchema.
  response_format: ResponseFormatSchema.optional(),
  // MCP (Model Context Protocol) — additive. When present, the gateway hosts the
  // listed MCP servers, merges their tools with any client `tools`, and runs a
  // bounded server-side tool loop. Absent ⇒ the existing flow is byte-identical.
  mcp: MCPRequestSchema.optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ProviderRouting = z.infer<typeof ProviderRoutingSchema>;

// ── Gateway: deep research ─────────────────────────────────────────────────

// Mirrors @zintus/search ResearchDepth ("quick" | "standard" | "deep").
const ResearchDepthSchema = z.enum(["quick", "standard", "deep"]);

export const ResearchRequestSchema = z.object({
  query: z.string().min(1).optional(),
  messages: z.array(ChatMessageSchema).optional(),
  depth: ResearchDepthSchema.optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  thread_id: z.string().optional(),
});

export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

// ── Relay: public worker payloads ──────────────────────────────────────────

/** Magic-link sign-in request. Email is the public attack surface. */
export const MagicLinkRequestSchema = z.object({
  email: z.string().email().max(320),
  redirectTo: z.string().url().max(2048).optional(),
});

export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;

/**
 * Format a ZodError into a compact, client-safe issues array (path + message),
 * suitable for a 400 response body.
 */
export function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

// ── Structured-output: JSON-Schema validation, extraction & repair ──────────
//
// The wire type for a structured request is a *raw JSON Schema object* (so
// non-TS callers and the relay can use it), which means conformance checking
// needs a real JSON-Schema validator, not Zod. We use Ajv (draft-2020-12,
// pure JS, edge-safe). These helpers are pure: no network, never throw.

/** A single conformance/parse failure, shaped like `formatIssues` output. */
export interface ValidationIssue {
  path: string;
  message: string;
}

// A shared Ajv instance + a cache of compiled validators keyed by the schema's
// JSON string, so a hot path (every structured response) doesn't recompile the
// same schema on every call. `strict:false` so vendor schemas with unknown
// keywords (Gemini's propertyOrdering, etc.) compile instead of throwing.
const ajv = addFormats(
  new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true }),
);

// Maps schema JSON → compiled validator, or `null` when the schema itself could
// not be compiled (cached so we don't re-attempt a doomed compile every call).
const validatorCache = new Map<string, ValidateFunction | null>();

// Bound the cache so a high-cardinality or hostile caller can't grow it without
// limit in the long-lived gateway (the §10.6 "hostile schema" memory-DoS). When
// it reaches the cap we evict the OLDEST entry (a Map iterates in insertion
// order), keeping the cache warm for recent schemas. Failed-compile memoization
// (the `null` entries) is preserved and bounded the same way.
const MAX_VALIDATOR_CACHE = 200;

function cacheValidator(key: string, value: ValidateFunction | null): void {
  if (validatorCache.size >= MAX_VALIDATOR_CACHE) {
    const oldest = validatorCache.keys().next().value;
    if (oldest !== undefined) validatorCache.delete(oldest);
  }
  validatorCache.set(key, value);
}

function compileValidator(
  schema: Record<string, unknown>,
): { validate?: ValidateFunction; error?: string } {
  const key = JSON.stringify(schema);
  if (validatorCache.has(key)) {
    const cached = validatorCache.get(key);
    return cached ? { validate: cached } : { error: "previously uncompilable schema" };
  }
  try {
    const validate = ajv.compile(schema);
    cacheValidator(key, validate);
    return { validate };
  } catch (err) {
    cacheValidator(key, null);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Validate a parsed JS value against a raw JSON Schema. Returns the conformance
 * verdict plus path-tagged issues. NEVER throws — a schema Ajv itself cannot
 * compile yields `{valid:false, issues:[{path:"/", message:"uncompilable schema: …"}]}`
 * rather than an exception, so a hostile/malformed schema can't crash the engine.
 */
export function validateJson(
  schema: Record<string, unknown>,
  value: unknown,
): { valid: boolean; issues: ValidationIssue[] } {
  const { validate, error } = compileValidator(schema);
  if (!validate) {
    return { valid: false, issues: [{ path: "/", message: `uncompilable schema: ${error}` }] };
  }
  const valid = validate(value);
  if (valid) return { valid: true, issues: [] };
  const issues: ValidationIssue[] = (validate.errors ?? []).map((e) => ({
    path: e.instancePath || "/",
    message: e.message || "invalid",
  }));
  return { valid: false, issues };
}

/**
 * Extract the first parseable JSON object/array from model text. Tolerant of the
 * common best-effort failure modes — ```json fences, leading/trailing prose —
 * because a `json_object`/`prompt`-level model often wraps its JSON. This is the
 * single most valuable repair-avoidance step: it salvages a syntactically-fine
 * response that would otherwise need a round-trip. `{ok:false}` when nothing
 * parses.
 */
export function extractJsonObject(text: string): { ok: boolean; value?: unknown } {
  if (typeof text !== "string") return { ok: false };

  // 1. Strip Markdown code fences (```json … ``` or ``` … ```), keeping the body.
  let body = text;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1] != null) body = fence[1];

  // 2. Whole-body parse first (the clean / fenced-then-stripped case).
  const whole = tryParse(body.trim());
  if (whole.ok) return whole;

  // 3. Otherwise scan for the first balanced {…} or […] and parse that, which
  //    strips leading prose ("Here is the JSON: { … }") and trailing commentary.
  const candidate = firstBalancedSpan(body);
  if (candidate != null) {
    const parsed = tryParse(candidate);
    if (parsed.ok) return parsed;
  }
  return { ok: false };
}

function tryParse(s: string): { ok: boolean; value?: unknown } {
  if (s.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

// Find the first balanced {...} or [...] span, respecting strings/escapes so a
// brace inside a string value doesn't throw off the depth count.
function firstBalancedSpan(text: string): string | undefined {
  const start = (() => {
    const obj = text.indexOf("{");
    const arr = text.indexOf("[");
    if (obj === -1) return arr;
    if (arr === -1) return obj;
    return Math.min(obj, arr);
  })();
  if (start === -1) return undefined;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Build the repair instruction fed back to the model after a failed validation.
 * Concise on purpose — it names the concrete issues (path + message) and demands
 * ONLY corrected JSON with no prose/fences, which is what minimizes a second
 * failed round-trip.
 */
export function repairInstruction(rawText: string, issues: ValidationIssue[]): string {
  const list =
    issues.length > 0
      ? issues.map((i) => `- ${i.path || "/"}: ${i.message}`).join("\n")
      : "- the output was not valid JSON for the requested schema";
  return [
    "Your previous response failed JSON-schema validation.",
    "",
    "Previous output:",
    rawText,
    "",
    "Problems found:",
    list,
    "",
    "Return ONLY the corrected JSON that satisfies the schema. Do not include any",
    "explanation, prose, or Markdown code fences — output the raw JSON value only.",
  ].join("\n");
}
