import type { Context } from 'hono';
import type { Env } from './types.js';
import type { SessionPayload } from './auth.js';
import { enforceQuota, recordUsage } from './middleware/quota.js';
import {
  kvRateLimitOk,
  giftDailyKey,
  GIFT_DAILY_LIMIT,
  GIFT_DAILY_WINDOW_SECS,
} from './rate-limit.js';
import {
  tavilySearch,
  extractSearchQuery,
  injectSearchResults,
  type SearchResult,
} from '@zintus/search';
import {
  MANAGED_KEY_TIERS,
  CLASS_BURN,
  TIER_CLASS_ACCESS,
  minTierForClass,
  displayPlanTokens,
  planTokensPer1kByTier,
  type ModelClass,
  type Tier,
} from './tiers.js';

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
 *  - Every model belongs to a class (PRICING-FINAL Part 3) whose burn rate
 *    sets its plan-token debit; the per-reply `zintus` block reports the
 *    debit in user-facing plan tokens so no charge is ever invisible.
 *  - Models above the member's tier return the honest 403 upgrade error
 *    (`model_requires_upgrade`), never a silent downgrade to a cheaper model.
 *  - Usage is metered from the PROVIDER's own usage block when present; the
 *    estimate fallback is flagged in the usage_log model suffix (`~est`).
 *
 * All v1 upstreams speak the OpenAI chat-completions dialect, so there is one
 * code path. Model ids/base URLs mirror packages/providers ground truth
 * (capabilities.ts / manifest.ts) — do not invent ids here.
 */

interface ManagedUpstream {
  provider:
    | 'groq' | 'cerebras' | 'openai' | 'deepseek' | 'moonshot'
    | 'anthropic' | 'gemini' | 'zai' | 'mistral' | 'xai' | 'together';
  model: string;
}

export interface ManagedModel {
  /** Public id clients send as `model`. */
  id: string;
  displayName: string;
  contextWindow: number;
  /** Pricing class — sets the CLASS_BURN debit rate and tier gating. */
  class: ModelClass;
  capabilities: { tools: boolean; json: boolean; vision: boolean };
  /** Ordered upstreams — first configured+healthy one serves the request. */
  upstreams: ManagedUpstream[];
}

// All bases are OpenAI-chat-completions dialect. Anthropic and Google expose
// official OpenAI-compat endpoints, so the single code path holds.
const PROVIDER_BASE: Record<ManagedUpstream['provider'], string> = {
  groq: 'https://api.groq.com/openai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.ai/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  zai: 'https://api.z.ai/api/paas/v4',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
  together: 'https://api.together.xyz/v1',
};

/** Providers whose streaming responses honor `stream_options.include_usage`. */
// Conservative for the compat endpoints: false only skips the REQUEST param;
// the SSE scanner still captures a usage chunk whenever the provider sends
// one unprompted (Gemini/xAI do), and the estimate fallback stays ~est-flagged.
const STREAM_USAGE: Record<ManagedUpstream['provider'], boolean> = {
  groq: true,
  cerebras: true,
  openai: true,
  deepseek: true,
  moonshot: false,
  anthropic: false,
  gemini: false,
  zai: false,
  mistral: false,
  xai: false,
  together: false,
};

// Class assignments follow PRICING-FINAL Part 3 by the owner's explicit
// listing (not raw cost bands): Groq 70B is premium there despite mid-band
// cost. Cost-safety was verified per class in the Part 9 margin table.
export const MANAGED_MODELS: ManagedModel[] = [
  {
    id: 'zintus/llama-3.3-70b',
    displayName: 'Llama 3.3 70B',
    contextWindow: 128_000,
    class: 'premium',
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
    class: 'cheap',
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [{ provider: 'groq', model: 'llama-3.1-8b-instant' }],
  },
  {
    id: 'zintus/gpt-4o-mini',
    displayName: 'GPT-4o mini',
    contextWindow: 128_000,
    class: 'mid',
    capabilities: { tools: true, json: true, vision: true },
    upstreams: [{ provider: 'openai', model: 'gpt-4o-mini' }],
  },
  {
    id: 'zintus/deepseek-chat',
    displayName: 'DeepSeek Chat',
    contextWindow: 64_000,
    class: 'cheap',
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [{ provider: 'deepseek', model: 'deepseek-chat' }],
  },
  {
    id: 'zintus/kimi-k2',
    displayName: 'Kimi K2',
    contextWindow: 131_072,
    class: 'premium',
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [{ provider: 'moonshot', model: 'kimi-k2-0711-preview' }],
  },
  // ── 2026-07-06 roster expansion: five already-provisioned operator keys ──
  // Classes per PRICING-FINAL Part 3 (economics re-verified per model):
  // Haiku $2.20 blended = premium ceiling; Gemini Flash $0.96 = mid (the
  // priced-in Starter worst case); Mistral Small $0.285 = mid; Grok premium
  // per owner gating call (margin-safe even at grok-4.3 pricing); GLM flash
  // models are the free gift class (daily-capped for non-members).
  {
    id: 'zintus/claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    class: 'premium',
    capabilities: { tools: true, json: true, vision: true },
    upstreams: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
  },
  {
    id: 'zintus/gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    contextWindow: 1_048_576,
    class: 'mid',
    capabilities: { tools: true, json: true, vision: true },
    upstreams: [{ provider: 'gemini', model: 'gemini-2.5-flash' }],
  },
  {
    id: 'zintus/glm-4.7-flash',
    displayName: 'GLM 4.7 Flash (free)',
    contextWindow: 128_000,
    class: 'free',
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [{ provider: 'zai', model: 'glm-4.7-flash' }],
  },
  {
    id: 'zintus/glm-4.5-flash',
    displayName: 'GLM 4.5 Flash (free)',
    contextWindow: 128_000,
    class: 'free',
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [{ provider: 'zai', model: 'glm-4.5-flash' }],
  },
  {
    id: 'zintus/mistral-small',
    displayName: 'Mistral Small',
    contextWindow: 128_000,
    class: 'mid',
    capabilities: { tools: true, json: true, vision: true },
    upstreams: [{ provider: 'mistral', model: 'mistral-small-latest' }],
  },
  // ── 2026-07-07 xAI roster fix: grok-4.1-fast is RETIRED (absent from the
  // owner's console model list; the survey's third-party retirement report is
  // now confirmed) — the old entry was vaporware that would 404 on first use.
  // Replaced with the two models the account actually serves. Blended 70/30:
  // grok-build-0.1 $1.00/$2.00 ⇒ $1.30/M = premium (COGS $0.26/1k cr, under
  // the $0.44 Haiku anchor); grok-4.3 $1.25/$2.50 ⇒ $1.625/M = FRONTIER per
  // PRICING-FINAL §2's explicit listing (COGS $0.108/1k cr — the roster's
  // first frontier model, so Max+ now unlocks something real). Vision stays
  // false: xAI docs describe image input at the endpoint level only, no
  // per-model confirmation. grok-4.20 variants skipped (same price as 4.3,
  // redundant SKUs, multi-agent has 4x lower rate limits).
  {
    id: 'zintus/grok-build',
    displayName: 'Grok Build (code)',
    contextWindow: 256_000,
    class: 'premium',
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [{ provider: 'xai', model: 'grok-build-0.1' }],
  },
  {
    id: 'zintus/grok-4.3',
    displayName: 'Grok 4.3',
    contextWindow: 1_000_000,
    class: 'frontier',
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [{ provider: 'xai', model: 'grok-4.3' }],
  },
  // ── 2026-07-06 Together expansion: 3 models requested, 1 servable ──
  // Llama-4 Scout + Maverick were requested but are NOT in Together's
  // serverless catalog (dedicated endpoints only — official pricing page and
  // docs.together.ai/docs/serverless/models verified 2026-07-06), so a
  // /chat/completions call with the operator key would fail; listing them
  // violates the never-vaporware rule. The plain Qwen/Qwen3-235B-A22B id is
  // likewise not serverless — the servable variant is Instruct-2507-tput,
  // 262K ctx at $0.20/$0.60 ⇒ $0.32/M blended (70/30) = mid band. COGS
  // $0.16/1k cr vs the $0.48/1k cr mid worst case already priced into
  // PRICING-FINAL §7 — margin-safe at every tier. Capabilities are honest:
  // the -tput catalog row lists NO function-calling, vision, or structured
  // outputs, so all three flags stay false.
  {
    id: 'zintus/qwen3-235b',
    displayName: 'Qwen3 235B',
    contextWindow: 262_144,
    class: 'mid',
    capabilities: { tools: false, json: false, vision: false },
    upstreams: [{ provider: 'together', model: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput' }],
  },
  // Scout via GROQ (the Together route above was unservable). Verified on
  // console.groq.com/docs/models 2026-07-06: 131,072 ctx, $0.11/$0.34 ⇒
  // $0.179/M blended (70/30) = cheap band, exactly the survey's row 9; tool
  // use is on Groq's official supported list. COGS $0.179/1k cr — the
  // referred-Starter all-Scout worst case nets ~57%, safer than the accepted
  // mid worst case. CAVEAT: Groq lists it as a PREVIEW model (may be retired
  // on short notice) — if it 404s in tail logs, drop this entry.
  {
    id: 'zintus/llama-4-scout',
    displayName: 'Llama 4 Scout',
    contextWindow: 131_072,
    class: 'cheap',
    capabilities: { tools: true, json: true, vision: false },
    upstreams: [{ provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' }],
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
    anthropic: env.MANAGED_KEY_ANTHROPIC,
    gemini: env.MANAGED_KEY_GEMINI,
    zai: env.MANAGED_KEY_ZAI,
    mistral: env.MANAGED_KEY_MISTRAL,
    xai: env.MANAGED_KEY_XAI,
    together: env.MANAGED_KEY_TOGETHER,
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
  /** Web search: results are fetched relay-side (Tavily) and injected as
   *  context, so EVERY managed model supports the search toggle regardless
   *  of native capability — mirroring the gateway's fallback strategy. */
  search?: { enabled?: boolean; maxResults?: number };
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
    class: m.class,
    // USER-FACING plan tokens debited per 1K real tokens, per tier (the
    // display conversion differs per tier by design — PRICING-FINAL Part 6).
    // Clients render "uses ~N plan tokens per 1K" for the member's own tier.
    // Internal credit units are never exposed.
    plan_tokens_per_1k: planTokensPer1kByTier(m.class),
    min_tier: minTierForClass(m.class),
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

  const quota = await enforceQuota(session.user_id, c.env);

  const model = MANAGED_MODELS.find((m) => m.id === body.model);
  const upstreams = model ? configuredUpstreams(c.env, model) : [];
  if (!model || upstreams.length === 0) {
    return c.json({ error: `Unknown or unavailable model: ${body.model}`, code: 'model_unavailable' }, 404);
  }

  // Tier class gating (PRICING-FINAL Part 5): honest 403 naming the required
  // plan — never a silent downgrade to a cheaper model. Checked BEFORE the
  // membership gate so a free-tier user asking for a paid class hears
  // "requires the Pro plan", not a generic membership error.
  if (!TIER_CLASS_ACCESS[quota.tier].includes(model.class)) {
    const minTier = minTierForClass(model.class);
    return c.json(
      {
        error: `${model.displayName} requires the ${minTier[0]!.toUpperCase()}${minTier.slice(1)} plan or higher. Upgrade at zintus.ai/pricing`,
        code: 'model_requires_upgrade',
        model: model.id,
        min_tier: minTier,
      },
      403,
    );
  }

  if (model.class !== 'free') {
    // Paid classes: an ACTIVE managed-tier subscription. past_due keeps its
    // data but does not get served — Stripe retries payment, the UI says why.
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
  } else if (quota.sub?.status !== 'active') {
    // Gift class for non-members (free tier / lapsed sub): served free of
    // charge behind the daily abuse fence. Members skip the cap entirely.
    if (!(await kvRateLimitOk(c.env.KV, giftDailyKey(session.user_id), GIFT_DAILY_LIMIT, GIFT_DAILY_WINDOW_SECS))) {
      return c.json(
        { error: 'Daily free-model limit reached — resets tomorrow, or upgrade for unlimited use', code: 'gift_daily_cap' },
        429,
      );
    }
  }

  // Managed web search: fetch results relay-side and inject as a system
  // context block (same pattern as the gateway's external fallback). Fails
  // soft — a search outage degrades to an honest no-results note rather than
  // failing the chat. No plan-token fee: upstream cost is ~1 cr equivalent
  // and PRICING-FINAL prices only images/STT/research as flat fees.
  let chatMessages = body.messages!;
  if (body.search?.enabled) {
    const tavilyKey = c.env.TAVILY_API_KEY?.trim() ?? '';
    const query = extractSearchQuery(chatMessages as never);
    if (tavilyKey && query) {
      let results: SearchResult[] = [];
      try {
        results = await tavilySearch(
          query,
          { maxResults: Math.min(body.search.maxResults ?? 5, 10) },
          tavilyKey,
        );
      } catch (err) {
        console.error('managed.search_failed', err instanceof Error ? err.message : String(err));
      }
      chatMessages = injectSearchResults(chatMessages as never, results) as typeof chatMessages;
      if (results.length === 0) {
        chatMessages = [
          ...chatMessages,
          {
            role: 'system',
            content:
              'Web search was requested but returned no results this turn. Answer from your knowledge and say so honestly — do not fabricate search citations.',
          } as ChatMessage,
        ];
      }
    } else if (!tavilyKey) {
      chatMessages = [
        ...chatMessages,
        {
          role: 'system',
          content:
            'The user enabled web search, but no search provider is configured. Tell them search is temporarily unavailable and answer from your knowledge.',
        } as ChatMessage,
      ];
    }
  }

  const stream = body.stream !== false;
  const inputChars = chatMessages.reduce(
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
      messages: chatMessages,
      stream,
      // Always send max_tokens: Anthropic's OpenAI-compat endpoint REQUIRES
      // it (400 without it — hit live 2026-07-06), and every other upstream
      // accepts it. Client value wins when provided.
      max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 8192,
    };
    if (typeof body.temperature === 'number') payload['temperature'] = body.temperature;
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
      // Log the upstream error body (truncated, redacted by the platform's
      // error path) so provider 4xx/5xx causes are diagnosable via
      // `wrangler tail` instead of guessing from a bare status code.
      const errBody = await res.text().catch(() => '');
      console.error('managed.upstream_error', up.provider, res.status, errBody.slice(0, 300));
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

  const burn = CLASS_BURN[model.class];
  const meter = (totals: UsageTotals) =>
    recordUsage(
      session.user_id,
      `zintus:${servedUp.provider}`,
      totals.reported ? model.id : `${model.id}~est`,
      totals.input,
      totals.output,
      c.env,
      burn,
      quota.tier,
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
    // Receipt data (PRICING-FINAL Part 6): real tokens + the user-facing
    // plan-token debit for THIS member's tier. Clients render
    // "DeepSeek Flash · 847 tok · plan −N tok" from these fields.
    const realTotal = totals.input + totals.output;
    return c.json({
      ...json,
      zintus: {
        served_by: servedUp.provider,
        model: model.id,
        class: model.class,
        tokens: realTotal,
        plan_tokens_debited: displayPlanTokens(realTotal * burn, quota.tier),
        usage_reported: totals.reported,
      },
    });
  }

  // Streaming: manually pump provider SSE to the client while scanning for
  // usage. Metering fires in the pump's `finally`, so it runs on BOTH normal
  // completion AND mid-stream client disconnect. This replaced a
  // pipeThrough(TransformStream{flush}) design after a workerd probe
  // (2026-07-06) proved two runtime facts:
  //   • flush() never fires when the CLIENT cancels — the old version never
  //     metered a disconnected stream, i.e. free tokens on every abort;
  //   • a JS TransformStream leaves the pending writer.write() hanging on
  //     client cancel, while workerd's native IdentityTransformStream
  //     rejects it promptly — which is what lets us detect the disconnect,
  //     cancel the upstream (stop paying for unseen tokens), and meter what
  //     WAS generated (estimate-flagged when the usage chunk never arrived).
  // Bun tests have no IdentityTransformStream; the fallback keeps the
  // completion path testable (disconnect semantics are workerd-only — see
  // workers/relay/scripts/verify-stream-disconnect/).
  const scanner = new SseUsageScanner();
  const decoder = new TextDecoder();
  const IdentityStream =
    (globalThis as { IdentityTransformStream?: typeof TransformStream })
      .IdentityTransformStream ?? TransformStream;
  const { readable, writable } = new IdentityStream();
  const writer = writable.getWriter();
  const upstreamBody = upstreamRes.body!;
  const pump = (async () => {
    const reader = upstreamBody.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        scanner.scan(decoder.decode(value, { stream: true }));
        try {
          await writer.write(value);
        } catch {
          // Client disconnected mid-stream.
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // Client already gone — nothing to close toward.
      }
      await meter(scanner.totals(inputChars));
    }
  })();
  c.executionCtx.waitUntil(pump.catch(() => {}));

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Zintus-Served-By': servedUp.provider,
      'X-Zintus-Model': model.id,
      'X-Zintus-Class': model.class,
      // Plan tokens per 1K real tokens for THIS member's tier — lets streaming
      // clients render the running plan debit without knowing internal units.
      'X-Zintus-Plan-Per-1k': String(planTokensPer1kByTier(model.class)[quota.tier] ?? 0),
    },
  });
}
