/**
 * Shared test fixtures and assertion helpers for Zintus.
 *
 * RUNNER-AGNOSTIC: this module is imported by tests under BOTH `bun test` and
 * `vitest`. vitest cannot resolve `bun:*` builtins, so this file must NOT import
 * `bun:test`, `bun:sqlite`, or `vitest`, and must not call any test-runner API
 * at module scope. It exports only pure data + assertion functions that throw
 * plain `Error`s on failure (the calling test still uses its own runner's
 * `expect`/`describe`). Bun-only helpers (SQLite, mock.module) live in
 * `@zintus/test-utils/bun`.
 */
import { ProviderHttpError } from "@zintus/providers";
import type {
  Provider,
  ProviderId,
  StreamChunk,
  StreamChatResult,
  ChatMessage,
} from "@zintus/types";

// ── Fixtures ────────────────────────────────────────────────────────────────

export const SAMPLE_MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "What is 2 + 2?" },
];

/** A deterministic TypeScript source of roughly `lines` lines, for compressor
 *  tests. Each function has a real body so AST code-stripping has something to
 *  strip. */
export function makeTypeScriptSource(lines = 200): string {
  const out: string[] = [
    "// generated fixture",
    "import { readFileSync } from 'node:fs';",
    "",
  ];
  let i = 0;
  while (out.length < lines) {
    out.push(
      `export function fn${i}(a: number, b: number): number {`,
      `  const sum = a + b;`,
      `  const scaled = sum * ${i + 1};`,
      `  if (scaled > 100) {`,
      `    return scaled - 100;`,
      `  }`,
      `  return scaled;`,
      `}`,
      "",
    );
    i++;
  }
  return out.join("\n");
}

/** A log block of `lines` lines, mostly repeated INFO/DEBUG with a few ERRORs
 *  interspersed (so dedup has duplicates and error-preservation has errors). */
export function makeLogLines(lines = 1000): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    if (i % 137 === 0) {
      out.push(`2024-01-15T10:00:${i % 60} [ERROR] request ${i} failed: timeout`);
    } else {
      out.push(`2024-01-15T10:00:${i % 60} [INFO] connection pool initialized: 10 connections`);
    }
  }
  return out.join("\n");
}

/** A multi-paragraph prose block (no code/JSON) for prose-compression tests. */
export function makeProse(paragraphs = 6): string {
  const p =
    "The routing layer selects a provider based on quota, latency and policy. " +
    "When a provider is rate limited the request fails over to the next " +
    "candidate in priority order, and the failing provider enters a cooldown " +
    "that grows exponentially with consecutive failures.";
  return Array.from({ length: paragraphs }, () => p).join("\n\n");
}

// ── Mock provider ────────────────────────────────────────────────────────────

export interface MockProviderOptions {
  id?: ProviderId;
  priority?: number;
  /** Total latency before the first chunk (ms). */
  latencyMs?: number;
  /** If set, streamChat throws a ProviderHttpError with this status. */
  failWith?: number;
  /** Number of whitespace-separated tokens of fake content to emit. */
  responseTokens?: number;
  /** Exact content to emit (overrides responseTokens). */
  content?: string;
  /** Optional rate-limit headers to attach to the result. */
  rateLimit?: StreamChatResult["rateLimit"];
  /** validateKey return (default true). */
  validKey?: boolean;
}

export interface MockProvider extends Provider {
  /** How many times streamChat was invoked. */
  readonly calls: () => number;
}

/**
 * Build a fake Provider for router/gateway tests. Emits deterministic content,
 * can inject latency, can fail with a given HTTP status, and counts calls.
 */
export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const id = options.id ?? "groq";
  const validKey = options.validKey ?? true;
  let callCount = 0;

  const content =
    options.content ??
    Array.from({ length: options.responseTokens ?? 3 }, (_, i) => `tok${i}`).join(" ");

  const provider: Provider = {
    id,
    name: id,
    color: "#000000",
    priority: options.priority ?? 1,
    keyRegex: /^.+$/,
    defaultModel: "mock-model",
    async streamChat(): Promise<StreamChatResult> {
      callCount++;
      if (options.latencyMs && options.latencyMs > 0) {
        await new Promise((r) => setTimeout(r, options.latencyMs));
      }
      if (options.failWith != null) {
        throw new ProviderHttpError(`mock failure ${options.failWith}`, options.failWith);
      }
      const chunks: StreamChunk[] = content
        ? content.split(" ").map((word, i, arr) => ({
            content: i === arr.length - 1 ? word : `${word} `,
          }))
        : [];
      return {
        rateLimit: options.rateLimit,
        stream: (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })(),
      };
    },
    async validateKey(): Promise<boolean> {
      return validKey;
    },
  };

  return Object.assign(provider, { calls: () => callCount });
}

// ── Request builder ──────────────────────────────────────────────────────────

export interface MockRequestOptions {
  messages?: ChatMessage[];
  provider?: string;
  model?: string;
  stream?: boolean;
  maxTokens?: number;
  threadId?: string;
  /** Bearer token to send (omit for no auth header). */
  token?: string;
  /** Path (default /v1/chat/completions). */
  path?: string;
  /** Raw body override — when set, `messages`/etc. are ignored (for invalid-body tests). */
  rawBody?: string;
  method?: string;
  /** Extra headers. */
  headers?: Record<string, string>;
}

/** Build a Request for the gateway handler. */
export function createMockRequest(options: MockRequestOptions = {}): Request {
  const path = options.path ?? "/v1/chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...options.headers,
  };
  const body =
    options.rawBody ??
    JSON.stringify({
      messages: options.messages ?? SAMPLE_MESSAGES,
      provider: options.provider,
      model: options.model,
      stream: options.stream,
      max_tokens: options.maxTokens,
      thread_id: options.threadId,
    });
  return new Request(`http://test.local${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.method === "GET" ? undefined : body,
  });
}

// ── Assertions (throw plain Errors; runner-agnostic) ─────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

/**
 * Validate a streaming SSE response from the gateway and return stats.
 * Asserts: Content-Type is text/event-stream, every non-[DONE] `data:` line is
 * a JSON chat.completion.chunk, and the stream ends with `data: [DONE]`.
 * (Matches the ACTUAL gateway framing — content deltas only, no role-prime or
 * finish_reason chunk.)
 */
export async function assertValidSSEStream(
  response: Response,
): Promise<{ chunks: number; totalContent: string }> {
  const ct = response.headers.get("Content-Type") ?? "";
  assert(ct.includes("text/event-stream"), `expected SSE Content-Type, got "${ct}"`);
  assert(response.body != null, "SSE response has no body");

  const text = await response.text();
  const lines = text.split("\n").filter((l) => l.startsWith("data: "));
  assert(lines.length > 0, "SSE stream had no data lines");
  assert(lines[lines.length - 1] === "data: [DONE]", "SSE stream did not end with data: [DONE]");

  let chunks = 0;
  let totalContent = "";
  for (const line of lines) {
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    let parsed: { object?: string; choices?: Array<{ delta?: { content?: string } }>; error?: unknown };
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new Error(`SSE chunk is not valid JSON: ${payload.slice(0, 80)}`);
    }
    if (parsed.error) continue; // error frames are valid SSE, not content
    assert(
      parsed.object === "chat.completion.chunk",
      `expected object "chat.completion.chunk", got "${parsed.object}"`,
    );
    chunks++;
    totalContent += parsed.choices?.[0]?.delta?.content ?? "";
  }
  return { chunks, totalContent };
}

/**
 * Assert the ACTUAL Zintus non-streaming chat completion shape. Note: the
 * gateway does NOT emit OpenAI's `created` or `usage` fields, and `id` is a
 * UUID trace id (not `chatcmpl-…`). It DOES include extra fields
 * (`provider`, `thread_id`). This asserts what the code really returns.
 */
export function assertChatCompletionShape(body: unknown): void {
  assert(typeof body === "object" && body != null, "completion body is not an object");
  const b = body as Record<string, unknown>;
  assert(typeof b.id === "string" && b.id.length > 0, "completion.id missing");
  assert(b.object === "chat.completion", `completion.object must be "chat.completion", got ${String(b.object)}`);
  assert(typeof b.model === "string", "completion.model missing");
  assert(Array.isArray(b.choices) && b.choices.length > 0, "completion.choices must be a non-empty array");
  const choice = (b.choices as unknown[])[0] as Record<string, unknown>;
  assert(typeof choice.index === "number", "choice.index missing");
  assert(typeof choice.finish_reason === "string", "choice.finish_reason missing");
  const message = choice.message as Record<string, unknown>;
  assert(message?.role === "assistant", "choice.message.role must be assistant");
  assert(typeof message?.content === "string", "choice.message.content must be a string");
}

/**
 * Assert a gateway error body. The gateway is INCONSISTENT by design: most
 * errors are `{ error: { message } }`, but some routes (404, several sub-routes)
 * return `{ error: "<string>" }`. This accepts both and returns the message.
 */
export function assertErrorShape(body: unknown): string {
  assert(typeof body === "object" && body != null, "error body is not an object");
  const err = (body as Record<string, unknown>).error;
  if (typeof err === "string") return err;
  assert(typeof err === "object" && err != null, "error must be a string or object");
  const message = (err as Record<string, unknown>).message;
  assert(typeof message === "string" && message.length > 0, "error.message must be a non-empty string");
  return message;
}
