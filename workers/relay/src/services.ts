import type { Context } from 'hono';
import type { Env } from './types.js';
import type { SessionPayload } from './auth.js';
import { enforceQuota, debitFlatFee } from './middleware/quota.js';
import { FLAT_FEES_CREDITS, displayPlanTokens, type Tier } from './tiers.js';

/**
 * Flat-fee managed services (PRICING-FINAL Part 4): image generation + STT.
 *
 * Same honesty contract as managed chat:
 *  - a service is only listed/servable when its operator key is configured;
 *  - the member is debited AFTER a successful upstream response — never for
 *    failures — via debitFlatFee (millicredits on the QuotaCounter);
 *  - every response carries `zintus.plan_tokens_debited` in the member's own
 *    tier units. Credits never appear anywhere client-visible.
 *
 * Membership + quota gates mirror handleManagedChat: active subscription
 * required; plan balance must not be exhausted (the flat fee then debits the
 * remainder — same trailing-debit model as token metering).
 */

// Upstream model ids are pinned here, not client-supplied — the public id is
// the whole allowlist (PRICING-FINAL: never forward unvalidated model strings).
const IMAGE_SERVICES = {
  'flux-schnell': {
    fee: FLAT_FEES_CREDITS.image_flux,
    provider: 'together' as const,
    upstreamModel: 'black-forest-labs/FLUX.1-schnell',
  },
  'gpt-image': {
    fee: FLAT_FEES_CREDITS.image_premium,
    provider: 'openai' as const,
    upstreamModel: 'gpt-image-1',
  },
};

type ImageServiceId = keyof typeof IMAGE_SERVICES;

const STT_UPSTREAM_MODEL = 'whisper-large-v3-turbo';
/** One STT fee unit covers this many seconds (3 cr / 10 min). */
const STT_FEE_WINDOW_SECS = 600;
/** Reject absurd uploads before they hit the upstream (Groq caps at 25MB). */
const STT_MAX_BYTES = 25 * 1024 * 1024;

function imageKey(env: Env, provider: 'together' | 'openai'): string {
  return (provider === 'together' ? env.MANAGED_KEY_TOGETHER : env.MANAGED_KEY_OPENAI)?.trim() ?? '';
}

/** Image services servable RIGHT NOW (operator key present). Never vaporware. */
export function availableImageServices(env: Env): ImageServiceId[] {
  return (Object.keys(IMAGE_SERVICES) as ImageServiceId[]).filter(
    (id) => imageKey(env, IMAGE_SERVICES[id].provider) !== '',
  );
}

/** Shared membership/balance gate for flat-fee services. */
async function requireMemberWithBalance(
  c: Context<{ Bindings: Env }>,
  session: SessionPayload,
): Promise<
  | { ok: true; tier: Tier }
  | { ok: false; res: Response }
> {
  const quota = await enforceQuota(session.user_id, c.env);
  if (quota.sub?.status !== 'active') {
    return {
      ok: false,
      res: c.json(
        { error: 'Zintus membership required for managed services', code: 'membership_required' },
        403,
      ),
    };
  }
  if (!quota.allowed) {
    return {
      ok: false,
      res: c.json(
        {
          error: 'Monthly plan tokens exhausted',
          code: 'plan_tokens_exhausted',
          used: quota.used,
          limit: quota.limit,
          reset: quota.reset,
        },
        429,
      ),
    };
  }
  return { ok: true, tier: quota.tier };
}

/** GET /v1/managed/services — public capability/pricing info (honest list). */
export function handleManagedServices(c: Context<{ Bindings: Env }>): Response {
  const images = availableImageServices(c.env).map((id) => ({
    id,
    kind: 'image',
    // Display units per tier for the pricing/UI layer — same conversion as
    // receipts; internal credit fees are never exposed.
    plan_tokens: planTokensByTier(IMAGE_SERVICES[id].fee),
  }));
  const stt = (c.env.MANAGED_KEY_GROQ?.trim() ?? '') !== ''
    ? [{
        id: 'whisper-turbo',
        kind: 'stt',
        per: '10min',
        plan_tokens: planTokensByTier(FLAT_FEES_CREDITS.stt_10min),
      }]
    : [];
  return c.json({ services: [...images, ...stt] });
}

function planTokensByTier(credits: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tier of ['starter', 'pro', 'max', 'ultra'] as const) {
    out[tier] = displayPlanTokens(credits * 1000, tier);
  }
  return out;
}

/**
 * POST /v1/managed/images — { service?: "flux-schnell"|"gpt-image", prompt }.
 * Returns { image: { b64 | url }, zintus: { service, plan_tokens_debited } }.
 */
export async function handleManagedImage(
  c: Context<{ Bindings: Env }>,
  session: SessionPayload,
): Promise<Response> {
  const body = (await c.req.json<{ service?: string; prompt?: string; size?: string }>().catch(() => null)) ?? {};
  const serviceId = (body.service ?? 'flux-schnell') as ImageServiceId;
  const service = IMAGE_SERVICES[serviceId];
  if (!service) {
    return c.json({ error: `Unknown image service: ${body.service}`, code: 'service_unavailable' }, 404);
  }
  if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0 || body.prompt.length > 4000) {
    return c.json({ error: 'prompt required (max 4000 chars)' }, 400);
  }
  const key = imageKey(c.env, service.provider);
  if (!key) {
    return c.json({ error: `Image service not available: ${serviceId}`, code: 'service_unavailable' }, 404);
  }

  const gate = await requireMemberWithBalance(c, session);
  if (!gate.ok) return gate.res;

  // Both upstreams speak the OpenAI images dialect.
  const base = service.provider === 'together'
    ? 'https://api.together.xyz/v1'
    : 'https://api.openai.com/v1';
  const upstream = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: service.upstreamModel,
      prompt: body.prompt,
      n: 1,
      ...(body.size === '512x512' || body.size === '1024x1024' ? { size: body.size } : {}),
      response_format: service.provider === 'together' ? 'b64_json' : undefined,
    }),
  });
  if (!upstream.ok) {
    // Never debit a failure.
    return c.json({ error: `Image generation failed (${service.provider} ${upstream.status})`, code: 'upstream_failed' }, 502);
  }
  const json = (await upstream.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const img = json.data?.[0];
  if (!img?.b64_json && !img?.url) {
    return c.json({ error: 'Image generation returned no image', code: 'upstream_failed' }, 502);
  }

  c.executionCtx.waitUntil(
    debitFlatFee(session.user_id, `image_${serviceId}`, service.fee, c.env, gate.tier),
  );
  return c.json({
    image: img.b64_json ? { b64: img.b64_json } : { url: img.url },
    zintus: {
      service: serviceId,
      plan_tokens_debited: displayPlanTokens(service.fee * 1000, gate.tier),
    },
  });
}

/**
 * POST /v1/managed/transcribe — multipart form with `file` (audio).
 * Returns { text, duration_secs, zintus: { plan_tokens_debited } }.
 * Fee: 3 cr per started 10-minute window, from the provider-reported duration.
 */
export async function handleManagedTranscribe(
  c: Context<{ Bindings: Env }>,
  session: SessionPayload,
): Promise<Response> {
  const key = c.env.MANAGED_KEY_GROQ?.trim() ?? '';
  if (!key) {
    return c.json({ error: 'Transcription not available', code: 'service_unavailable' }, 404);
  }

  const gate = await requireMemberWithBalance(c, session);
  if (!gate.ok) return gate.res;

  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'multipart field "file" (audio) required' }, 400);
  }
  if (file.size > STT_MAX_BYTES) {
    return c.json({ error: 'audio too large (max 25MB)' }, 413);
  }

  const upstreamForm = new FormData();
  upstreamForm.set('file', file);
  upstreamForm.set('model', STT_UPSTREAM_MODEL);
  upstreamForm.set('response_format', 'verbose_json'); // includes duration

  const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: upstreamForm,
  });
  if (!upstream.ok) {
    return c.json({ error: `Transcription failed (groq ${upstream.status})`, code: 'upstream_failed' }, 502);
  }
  const json = (await upstream.json()) as { text?: string; duration?: number };
  if (typeof json.text !== 'string') {
    return c.json({ error: 'Transcription returned no text', code: 'upstream_failed' }, 502);
  }

  // Fee scales with provider-reported duration; a missing duration bills one
  // window (the minimum) — never a guess above what was served.
  const windows = Math.max(1, Math.ceil((json.duration ?? 0) / STT_FEE_WINDOW_SECS));
  const fee = FLAT_FEES_CREDITS.stt_10min * windows;
  c.executionCtx.waitUntil(
    debitFlatFee(session.user_id, 'stt_whisper_turbo', fee, c.env, gate.tier),
  );
  return c.json({
    text: json.text,
    duration_secs: json.duration ?? null,
    zintus: {
      service: 'whisper-turbo',
      plan_tokens_debited: displayPlanTokens(fee * 1000, gate.tier),
    },
  });
}
