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

const RATE_LIMIT = 10;
const WINDOW_MS = 60_000;
const hits = new Map<string, { count: number; resetAt: number }>();

function getClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);

  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT) {
    return false;
  }

  entry.count += 1;
  return true;
}

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

app.post("/validate", async (c) => {
  const ip = getClientIp(c.req.raw);
  if (!checkRateLimit(ip)) {
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
