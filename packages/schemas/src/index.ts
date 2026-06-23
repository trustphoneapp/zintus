import { z } from "zod";

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

export const ChatRole = z.enum(["system", "user", "assistant"]);

export const ChatMessageSchema = z.object({
  role: ChatRole,
  content: z.string(),
});

// Exact ProviderId union (mirrors @zintus/types ProviderId) so an unknown
// provider is rejected at the edge with a 400 rather than failing downstream.
const ProviderIdSchema = z.enum([
  "cerebras",
  "groq",
  "gemini",
  "openrouter",
  "cohere",
  "mistral",
  "deepseek",
  "fireworks",
  "xai",
  "huggingface",
  "lmstudio",
  "ollama",
]);

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

export const SearchOptionsSchema = z.object({
  enabled: z.boolean().optional(),
  depth: SearchDepthSchema.optional(),
  maxResults: z.number().int().positive().max(50).optional(),
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
  provider: ProviderIdSchema.optional(),
  thread_id: z.string().optional(),
  mode: ContextModeSchema.optional(),
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
  // Per-request BYOK keys (provider -> key) for the LOCAL gateway only. Never
  // logged, never persisted, never forwarded to the relay.
  keys: z.record(ProviderIdSchema, z.string()).optional(),
  search: SearchOptionsSchema.optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

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
