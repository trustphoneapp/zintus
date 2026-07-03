import type { Context } from 'hono';
import type { Env } from './types.js';
import type { SessionPayload } from './auth.js';
import { enforceQuota, recordUsage } from './middleware/quota.js';
import { MANAGED_KEY_TIERS } from './tiers.js';

/**
 * Managed-membership LLM backend — the feature MANAGED_KEYS_AVAILABLE gates.
 *
 * A paying member's chat request is served by ZINTUS-OWNED provider keys
 * (Cloudflare secrets, never sent to any client) and metered against the
 * member's monthly plan tokens via the existing QuotaCounter DO. This is the
 * opposite trust model from BYOK: the key never leaves the relay, the user
 * never sees it, and the ONLY thing the client receives is the model stream.
 *
 * Honesty rules (product non-negotiables):
 *  - `/v1/managed/models` lists ONLY models whose operator key is actually
 *    configured — nothing purchasable-but-unservable is ever shown.
 *  - Every model in v1 debits plan tokens 1:1 (`multiplier: 1`). Premium
 *    multipliers ship only together with UI that displays them per-reply.
 *  - Usage is metered from the PROVIDER's own usage block when present; the
 *    estimate fallback is flagged in the usage_log model suffix (`~est`).
 *
 * All v1 upstreams speak the OpenAI chat-completions dialect, so there is one
 * code path. Model ids/base URLs mirror packages/providers ground truth
 * (capabilities.ts / manifest.ts) — do not invent ids here.
 */

interface ManagedUpstream {
  provider: 'groq' | 'cerebras' | 'openai' | 'deepseek' | 'moonshot';
  model: string;
}

export interface ManagedModel {
  /** Public id clients send as `model`. */
  id: string;
  displayName: string;
  contextWindow: number;
  /** Plan-token debit multiplier. v1: always 1 (see honesty rules above). */
  multiplier: 1;
  capabilities: { tools: boolean; json: boolean; vision: boolean };
  /** Ordered upstreams — first configured+healthy one serves the request. */
  upstreams: ManagedUpstream[];
}

const PROVIDER_BASE: Record<ManagedUpstream['provider'], string> = {
  groq: 'https://api.groq.com/openai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.ai/v1',
};

/** Providers whose streaming responses honor `stream_options.include_usage`. */
const STREAM_USAGE: Record<ManagedUpstream['provider'], boolean> = {
  groq: true,
  cerebras: true,
  openai: true,
  deepseek: true,
  moonshot: false,
};

export const MANAGED_MODELS: ManagedModel[] = [
  {
    id: 'zintus/llama-3.3-70b',
    displayName: 'Llama 3.3 70B',
    contextWindow: 128_000,
    multiplier: 1,
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      { provider: 'cerebras', model: 'llama-3.3-70b' },
    ],
  },
  {
    id: 'zintus/llama-3.1-8b',
    displayName: 'Llama 3.1 8B (fast)',
    contextWindow: 128_000,
    multiplier: 1,
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
  },
  {
    id: 'zintus/gpt-4o-mini',
    displayName: 'GPT-4o mini',
    contextWindow: 128_000,
    multiplier: 1,
    capabilities: { tools: true, json: true, vision: true },
    upstreams: [{ provider: 'openai', model: 'gpt-4o-mini' }],
  },
  {
    id: 'zintus/deepseek-chat',
    displayName: 'DeepSeek Chat',
    contextWindow: 64_000,
    multiplier: 1,
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [{ provider: 'deepseek', model: 'deepseek-chat' }],
  },
  {
    id: 'zintus/kimi-k2',
    displayName: 'Kimi K2',
    contextWindow: 131_072,
    multiplier: 1,
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [{ provider: 'moonshot', model: 'kimi-k2-0711-preview' }],
  },
];

/** Operator key for an upstream provider, or "" when not configured. */
export function managedKey(env: Env, provider: ManagedUpstream['provider']): string {
  const map: Record<ManagedUpstream['provider'], string | undefined> = {
    groq: env.MANAGED_KEY_GROQ,
    cerebras: env.MANAGED_KEY_CEREBRAS,
    openai: env.MANAGED_KEY_OPENAI,
    deepseek: env.MANAGED_KEY_DEEPSEEK,
    moonshot: env.MANAGED_KEY_MOONSHOT,
  };
  return map[provider]?.trim() ?? '';
}

/** Upstreams of `m` that have an operator key configured, in preference order. */
function configuredUpstreams(env: Env, m: ManagedModel): ManagedUpstream[] {
  return m.upstreams.filter((u) => managedKey(env, u.provider) !== '');
}

/** Models servable RIGHT NOW (≥1 configured upstream). Never lists vaporware. */
export function availableManagedModels(env: Env): ManagedModel[] {
  return MANAGED_MODELS.filter((m) => configuredUpstreams(env, m).length > 0);
}

// ── request/response types ──────────────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; [k: string]: unknown }>;
}

interface ManagedChatBody {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: string };
}

/** Hard caps so one request can't monopolize the worker. */
const MAX_MESSAGES = 200;
const MAX_TOTAL_CHARS = 400_000;

function validateBody(body: ManagedChatBody): string | null {
  if (!body.model || typeof body.model !== 'string') return 'model required';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages required';
  if (body.messages.length > MAX_MESSAGES) return `too many messages (max ${MAX_MESSAGES})`;
  let chars = 0;
  for (const m of body.messages) {
    if (!m || typeof m !== 'object') return 'invalid message';
    if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') return 'invalid role';
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
  }
  if (chars > MAX_TOTAL_CHARS) return `request too large (max ${MAX_TOTAL_CHARS} chars)`;
  return null;
}

/** ~chars/4 token estimate — the flagged fallback when a provider omits usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface UsageTotals {
  input: number;
  output: number;
  /** True when totals came from the provider's usage block (not estimated). */
  reported: boolean;
}

/**
 * Extract `{prompt_tokens, completion_tokens}` from one SSE `data:` payload if
 * present. OpenAI-dialect streams place usage on a (usually final) chunk when
 * `stream_options.include_usage` is set.
 */
export function usageFromSseChunk(json: unknown): { input: number; output: number } | null {
  if (!json || typeof json !== 'object') return null;
  const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
  if (!usage || typeof usage.prompt_tokens !== 'number') return null;
  return { input: usage.prompt_tokens, output: usage.completion_tokens ?? 0 };
}

/** Accumulates streamed SSE bytes; yields usage + text-length fallback data. */
export class SseUsageScanner {
  private buf = '';
  private outputChars = 0;
  private usage: { input: number; output: number } | null = null;

  scan(chunkText: string): void {
    this.buf += chunkText;
    // Process complete SSE events (separated by blank line); keep the tail.
    const events = this.buf.split('\n\n');
    this.buf = events.pop() ?? '';
    for (const evt of events) {
      for (const line of evt.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const found = usageFromSseChunk(json);
          if (found) this.usage = found;
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') this.outputChars += delta.length;
        } catch {
          // Partial/foreign payload — the estimate fallback still covers us.
        }
      }
    }
  }

  totals(inputFallbackChars: number): UsageTotals {
    if (this.usage) return { input: this.usage.input, output: this.usage.output, reported: true };
    return {
      input: estimateTokens('x'.repeat(Math.max(1, inputFallbackChars))),
      output: estimateTokens('x'.repeat(Math.max(1, this.outputChars))),
      reported: false,
    };
  }
}

// ── route handlers ──────────────────────────────────────────────────────

/** GET /v1/managed/models — public, honest: only servable models. */
export function handleManagedModels(c: Context<{ Bindings: Env }>): Response {
  const models = availableManagedModels(c.env).map((m) => ({
    id: m.id,
    display_name: m.displayName,
    context_window: m.contextWindow,
    multiplier: m.multiplier,
    capabilities: m.capabilities,
  }));
  return c.json({ models, managed_tiers: MANAGED_KEY_TIERS });
}

/**
 * POST /v1/managed/chat/completions — the member chat path.
 * Caller (index.ts) has already authenticated the session.
 */
export async function handleManagedChat(
  c: Context<{ Bindings: Env }>,
  session: SessionPayload,
): Promise<Response> {
  const body = (await c.req.json<ManagedChatBody>().catch(() => null)) ?? {};
  const invalid = validateBody(body);
  if (invalid) return c.json({ error: invalid }, 400);

  // Membership gate: an ACTIVE managed-tier subscription. past_due keeps its
  // data but does not get served — Stripe retries payment, the UI says why.
  const quota = await enforceQuota(session.user_id, c.env);
  const managedTier = (MANAGED_KEY_TIERS as readonly string[]).includes(quota.tier);
  if (!managedTier || quota.sub?.status !== 'active') {
    return c.json(
      { error: 'Zintus membership required for managed models', code: 'membership_required' },
      403,
    );
  }
  if (!quota.allowed) {
    return c.json(
      {
        error: 'Monthly plan tokens exhausted',
        code: 'plan_tokens_exhausted',
        used: quota.used,
        limit: quota.limit,
        reset: quota.reset,
      },
      429,
    );
  }

  const model = MANAGED_MODELS.find((m) => m.id === body.model);
  const upstreams = model ? configuredUpstreams(c.env, model) : [];
  if (!model || upstreams.length === 0) {
    return c.json({ error: `Unknown or unavailable model: ${body.model}`, code: 'model_unavailable' }, 404);
  }

  const stream = body.stream !== false;
  const inputChars = body.messages!.reduce(
    (n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
    0,
  );

  // Try upstreams in order until one accepts (connection/5xx failover — the
  // same resilience story the local gateway tells, one hop up).
  let upstreamRes: Response | null = null;
  let served: ManagedUpstream | null = null;
  let lastError = '';
  for (const up of upstreams) {
    const payload: Record<string, unknown> = {
      model: up.model,
      messages: body.messages,
      stream,
    };
    if (typeof body.temperature === 'number') payload['temperature'] = body.temperature;
    if (typeof body.max_tokens === 'number') payload['max_tokens'] = body.max_tokens;
    if (body.response_format?.type === 'json_object') payload['response_format'] = { type: 'json_object' };
    if (stream && STREAM_USAGE[up.provider]) payload['stream_options'] = { include_usage: true };

    try {
      const res = await fetch(`${PROVIDER_BASE[up.provider]}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${managedKey(c.env, up.provider)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (res.ok && res.body) {
        upstreamRes = res;
        served = up;
        break;
      }
      lastError = `${up.provider} ${res.status}`;
      // 4xx that isn't rate-limit is OUR bug (bad payload/model id) — surface,
      // don't burn the other upstream too.
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastError = `${up.provider} ${err instanceof Error ? err.message : 'network error'}`;
    }
  }
  if (!upstreamRes || !served) {
    return c.json({ error: `All managed upstreams failed (${lastError})`, code: 'upstream_failed' }, 502);
  }
  const servedUp = served;

  const meter = (totals: UsageTotals) =>
    recordUsage(
      session.user_id,
      `zintus:${servedUp.provider}`,
      totals.reported ? model.id : `${model.id}~est`,
      totals.input,
      totals.output,
      c.env,
    );

  if (!stream) {
    const json = (await upstreamRes.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: Array<{ message?: { content?: string } }>;
    };
    const totals: UsageTotals = json.usage?.prompt_tokens != null
      ? { input: json.usage.prompt_tokens, output: json.usage.completion_tokens ?? 0, reported: true }
      : {
          input: estimateTokens('x'.repeat(Math.max(1, inputChars))),
          output: estimateTokens(json.choices?.[0]?.message?.content ?? ' '),
          reported: false,
        };
    c.executionCtx.waitUntil(meter(totals));
    return c.json({
      ...json,
      zintus: { served_by: servedUp.provider, model: model.id, multiplier: model.multiplier, usage_reported: totals.reported },
    });
  }

  // Streaming: pass provider SSE through untouched while scanning for usage.
  // The transform's flush() fires when the upstream stream ends — that is the
  // metering trigger. waitUntil keeps the worker alive until metering lands
  // even if the client disconnects right at end-of-stream.
  const scanner = new SseUsageScanner();
  const decoder = new TextDecoder();
  let resolveDone!: () => void;
  const streamDone = new Promise<void>((r) => (resolveDone = r));
  const metered = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      scanner.scan(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      resolveDone();
    },
  });
  c.executionCtx.waitUntil(
    streamDone.then(() => meter(scanner.totals(inputChars))).catch(() => {}),
  );

  return new Response(upstreamRes.body!.pipeThrough(metered), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Zintus-Served-By': servedUp.provider,
      'X-Zintus-Model': model.id,
    },
  });
}
