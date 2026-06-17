import { Hono } from "hono";
import { cors } from "hono/cors";
import { createProvider } from "@multipleai/providers";
import { isProviderId } from "@multipleai/types";

interface ValidateKeyRequest {
  providerId: string;
  key: string;
}

interface ValidateKeyResponse {
  valid: boolean;
  error?: string;
}

/** Cloudflare native Rate Limiting binding (configured in wrangler.toml). */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Bindings {
  RATE_LIMITER?: RateLimiter;
  /** Comma-separated allowlist of origins, or unset/"*" for any. */
  ALLOWED_ORIGINS?: string;
}

const RATE_LIMIT = 10;
const WINDOW_MS = 60_000;

// In-memory limiter is ONLY a best-effort fallback for `wrangler dev`. On the
// production edge it is ineffective (state is per-isolate and not shared), so we
// rely on the Cloudflare RATE_LIMITER binding there. See wrangler.toml.
const localHits = new Map<string, { count: number; resetAt: number }>();

function localRateLimitOk(ip: string): boolean {
  const now = Date.now();
  const entry = localHits.get(ip);
  if (!entry || entry.resetAt <= now) {
    localHits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) {
    return false;
  }
  entry.count += 1;
  return true;
}

function getClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

async function rateLimitOk(env: Bindings, ip: string): Promise<boolean> {
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    return success;
  }
  return localRateLimitOk(ip);
}

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS?.trim();
  const origin =
    !allowed || allowed === "*"
      ? "*"
      : allowed.split(",").map((value) => value.trim());
  return cors({
    origin,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })(c, next);
});

app.get("/health", (c) => c.json({ ok: true }));

app.post("/validate", async (c) => {
  const ip = getClientIp(c.req.raw);
  if (!(await rateLimitOk(c.env, ip))) {
    return c.json(
      { valid: false, error: "Rate limit exceeded (10 req/min per IP)" },
      429,
    );
  }

  let body: ValidateKeyRequest;
  try {
    body = await c.req.json<ValidateKeyRequest>();
  } catch {
    return c.json({ valid: false, error: "Invalid JSON body" }, 400);
  }

  if (!body.providerId || !body.key) {
    return c.json(
      { valid: false, error: "providerId and key are required" },
      400,
    );
  }

  if (!isProviderId(body.providerId)) {
    return c.json(
      { valid: false, error: `Unknown provider: ${body.providerId}` },
      400,
    );
  }

  try {
    const provider = createProvider(body.providerId);
    const valid = await provider.validateKey(body.key);
    return c.json({ valid } satisfies ValidateKeyResponse);
  } catch (error) {
    return c.json({
      valid: false,
      error: error instanceof Error ? error.message : "Validation failed",
    } satisfies ValidateKeyResponse);
  }
});

export default app;
