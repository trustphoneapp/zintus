/**
 * Zintus Relay Worker — Hono entry point.
 *
 * Routes:
 *   AUTH (email/OAuth, CLI, mobile):
 *     POST /api/auth/magic-link
 *     GET  /api/auth/verify
 *     GET  /api/auth/google
 *     GET  /api/auth/google/callback
 *     GET  /api/auth/cli-status
 *     POST /api/auth/mobile-verify
 *     POST /api/auth/signout
 *
 *   SESSION MANAGEMENT (user cookie auth):
 *     GET    /api/sessions
 *     POST   /api/sessions
 *     DELETE /api/sessions/:id
 *
 *   RELAY — GATEWAY SIDE (relay_token WebSocket):
 *     WS  /relay/:sessionId
 *
 *   RELAY — MOBILE SIDE (user cookie auth):
 *     GET  /api/sessions/:id/status
 *     POST /api/sessions/:id/control
 *     GET  /api/sessions/:id/stream
 *
 * Rate limits via KV counters (keys: `rl:<type>:<identifier>`).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { MagicLinkRequestSchema } from "@zintus/schemas";
import { redactSecrets } from "./redact.js";
import type { Env, GatewaySessionRow, UserRow, SubscriptionRow } from "./types.js";
import {
  sha256Hex,
  issueSessionToken,
  verifySessionToken,
  revokeSessionToken,
  parseSessionCookie,
  buildSessionCookie,
  clearSessionCookie,
  type SessionPayload,
} from "./auth.js";
import { createCheckoutSession, createPortalSession, handleStripeWebhook } from "./billing.js";
import { MANAGED_KEYS_AVAILABLE, MANAGED_KEY_TIERS } from "./tiers.js";
import { corsOrigin, validateRedirectTo } from "./http-security.js";
import { enforceQuota, recordUsage } from "./middleware/quota.js";
import { getOrCreateReferralCode, resolveReferralCode } from "./referral.js";
import { validateGoogleClaims, type GoogleClaims } from "./google-auth.js";
import {
  kvRateLimitOk,
  magicLinkEmailKey,
  magicLinkIpKey,
  MAGIC_LINK_EMAIL_LIMIT,
  MAGIC_LINK_EMAIL_WINDOW_SECS,
  MAGIC_LINK_IP_LIMIT,
  MAGIC_LINK_IP_WINDOW_SECS,
} from "./rate-limit.js";

// Re-export the Durable Object class for wrangler to find.
export { GatewaySession } from "./GatewaySession.js";

const app = new Hono<{ Bindings: Env }>();

// ── Error handler ──────────────────────────────────────────────────────────
// Uncaught errors (e.g. `throw new Error("Stripe checkout error: ...")` in
// billing.ts) must not leak internal detail to the client, and any secret in
// the message/stack must be scrubbed before the platform captures it. Returns a
// generic 500; logs the error REDACTED (this is the relay's only error log).
app.onError((err, c) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error("relay.error", redactSecrets(detail));
  return c.json({ error: "Internal server error" }, 500);
});

// ── Security headers + CORS ────────────────────────────────────────────────

// CORS allow-list + redirect validation live in ./http-security.js so the
// relay's security tests import the real implementation (no drift).

function decodeBase64url(str: string): string {
  return atob(
    str
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(str.length / 4) * 4, "=")
  );
}

async function verifyGoogleJWT(
  token: string,
  expectedAud: string
): Promise<GoogleClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(decodeBase64url(parts[0]!)) as {
      kid?: string;
      alg?: string;
    };
    // Pin algorithm — never trust header.alg per RFC 8725
    if (header.alg !== "RS256") return null;
    const jwksRes = await fetch(
      "https://www.googleapis.com/oauth2/v3/certs"
    );
    if (!jwksRes.ok) return null;
    const jwks = (await jwksRes.json()) as {
      keys: Array<{ kid: string } & JsonWebKey>;
    };
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signingInput = new TextEncoder().encode(
      `${parts[0]}.${parts[1]}`
    );
    const sigBytes = Uint8Array.from(
      atob(
        parts[2]!.replace(/-/g, "+").replace(/_/g, "/")
          .padEnd(Math.ceil(parts[2]!.length / 4) * 4, "=")
      ),
      (c) => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      sigBytes,
      signingInput
    );
    if (!valid) return null;
    const claims = JSON.parse(
      decodeBase64url(parts[1]!)
    ) as GoogleClaims;
    // Validate iss / aud / exp AND require email_verified === true (RFC 8725 +
    // Google's verify-ID-token guidance). Shared with the unit tests so the
    // account-takeover guard can't silently drift. See google-auth.ts.
    const now = Math.floor(Date.now() / 1000);
    const result = validateGoogleClaims(claims, expectedAud, now);
    if (!result.ok) return null;
    return claims;
  } catch {
    return null;
  }
}

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

app.use(
  "*",
  cors({
    origin: (origin) => corsOrigin(origin),
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

// ── Helpers ───────────────────────────────────────────────────────────────

async function requireSession(
  c: Context<{ Bindings: Env }>,
): Promise<SessionPayload | null> {
  const cookie = parseSessionCookie(c.req.header("Cookie") ?? null);
  if (!cookie) return null;
  return verifySessionToken(c.env.KV, cookie);
}

async function findOrCreateUser(
  db: D1Database,
  email: string,
): Promise<UserRow> {
  const existing = await db
    .prepare("SELECT * FROM zintus_users WHERE email = ?")
    .bind(email)
    .first<UserRow>();
  if (existing) return existing;
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO zintus_users (id, email, created_at) VALUES (?, ?, ?)",
    )
    .bind(id, email, Date.now())
    .run();
  return { id, email, created_at: Date.now() };
}

async function createUserSession(
  kv: KVNamespace,
  db: D1Database,
  user: UserRow,
  cookieDomain: string,
): Promise<string> {
  const payload: SessionPayload = {
    session_id: crypto.randomUUID(),
    user_id: user.id,
    email: user.email,
  };
  const token = await issueSessionToken(kv, payload);
  await db
    .prepare(
      "INSERT INTO user_sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(
      payload.session_id,
      user.id,
      Date.now(),
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    )
    .run();
  return buildSessionCookie(token, cookieDomain);
}

// ── Health ────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ ok: true }));

// ── AUTH — magic link ─────────────────────────────────────────────────────

app.post("/api/auth/magic-link", async (c) => {
  // Validate the public email input with a shared schema (RFC-ish email, length
  // bound) instead of a bare `.includes("@")` check on an untyped cast.
  const parsed = MagicLinkRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "Valid email required" }, 400);
  }
  const { email } = parsed.data;

  // Layered rate limit (both must pass):
  //   • per-email — 3/hour: caps mail to one inbox (anti-spam to a victim).
  //   • per-IP   — 10/hour: caps links one host can request across *any*
  //     emails, so rotating the address from one host is throttled too.
  // The per-email limit alone was bypassable by changing `email` (bug B6).
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (
    !(await kvRateLimitOk(
      c.env.KV,
      magicLinkEmailKey(email),
      MAGIC_LINK_EMAIL_LIMIT,
      MAGIC_LINK_EMAIL_WINDOW_SECS,
    ))
  ) {
    return c.json({ error: "Too many magic link requests (3/hour per email)" }, 429);
  }
  if (
    !(await kvRateLimitOk(
      c.env.KV,
      magicLinkIpKey(ip),
      MAGIC_LINK_IP_LIMIT,
      MAGIC_LINK_IP_WINDOW_SECS,
    ))
  ) {
    return c.json({ error: "Too many magic link requests (10/hour per IP)" }, 429);
  }

  // Store a short-lived token in KV (15 min).
  const token = crypto.randomUUID() + "-" + crypto.randomUUID();
  const hash = await sha256Hex(token);
  const redirectTo = validateRedirectTo(c.req.query("redirect_to"));
  await c.env.KV.put(
    `ml:${hash}`,
    JSON.stringify({ email, redirect_to: redirectTo }),
    { expirationTtl: 900 },
  );

  const verifyUrl = `${c.env.RELAY_BASE_URL}/api/auth/verify?token=${token}`;

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Zintus <auth@zintus.app>",
      to: email,
      subject: "Sign in to Zintus",
      html: `
        <p>Click to sign in to Zintus — expires in 15 minutes.</p>
        <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Sign in</a>
        <p style="color:#888;font-size:13px;">If you didn't request this, you can ignore this email.</p>
      `,
    }),
  });

  if (!emailRes.ok) {
    return c.json({ error: "Failed to send email" }, 502);
  }

  return c.json({ ok: true });
});

// ── AUTH — verify magic link ──────────────────────────────────────────────

app.get("/api/auth/verify", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "Missing token" }, 400);

  const hash = await sha256Hex(token);
  const raw = await c.env.KV.get(`ml:${hash}`);
  if (!raw) return c.json({ error: "Invalid or expired link" }, 400);

  const { email, redirect_to } = JSON.parse(raw) as {
    email: string;
    redirect_to: string;
  };
  await c.env.KV.delete(`ml:${hash}`);

  const user = await findOrCreateUser(c.env.DB, email);
  const cookieValue = await createUserSession(c.env.KV, c.env.DB, user, c.env.COOKIE_DOMAIN);

  return new Response(null, {
    status: 302,
    headers: {
      Location: validateRedirectTo(redirect_to),
      "Set-Cookie": cookieValue,
    },
  });
});

// ── AUTH — Google OAuth ───────────────────────────────────────────────────

app.get("/api/auth/google", async (c) => {
  const state = crypto.randomUUID();
  const redirectTo = validateRedirectTo(c.req.query("redirect_to"));
  await c.env.KV.put(
    `oauth:${state}`,
    JSON.stringify({ redirect_to: redirectTo }),
    { expirationTtl: 600 },
  );

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${c.env.RELAY_BASE_URL}/api/auth/google/callback`,
    response_type: "code",
    scope: "email profile",
    state,
    access_type: "online",
  });

  return Response.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    302,
  );
});

app.get("/api/auth/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "Missing code/state" }, 400);

  const raw = await c.env.KV.get(`oauth:${state}`);
  if (!raw) return c.json({ error: "Invalid or expired state" }, 400);
  const { redirect_to } = JSON.parse(raw) as { redirect_to: string };
  await c.env.KV.delete(`oauth:${state}`);

  // Exchange code for tokens.
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${c.env.RELAY_BASE_URL}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return c.json({ error: "Token exchange failed" }, 502);
  const tokens = (await tokenRes.json()) as { id_token?: string };

  // Verify the id_token with RS256 signature via Google JWKS.
  if (!tokens.id_token) return c.json({ error: "Missing id_token" }, 502);
  const claims = await verifyGoogleJWT(tokens.id_token, c.env.GOOGLE_CLIENT_ID);
  if (!claims) return c.json({ error: "Invalid or expired id_token" }, 502);
  const email = claims.email;

  const user = await findOrCreateUser(c.env.DB, email);
  const cookieValue = await createUserSession(c.env.KV, c.env.DB, user, c.env.COOKIE_DOMAIN);

  return new Response(null, {
    status: 302,
    headers: {
      Location: validateRedirectTo(redirect_to),
      "Set-Cookie": cookieValue,
    },
  });
});

// ── AUTH — CLI login flow ─────────────────────────────────────────────────

// CLI calls this before opening the browser.
app.post("/api/auth/cli-login", async (c) => {
  const { state } = (await c.req.json<{ state?: string }>()) ?? {};
  if (!state) return c.json({ error: "state required" }, 400);
  await c.env.KV.put(`cli:${state}`, JSON.stringify({ pending: true }), {
    expirationTtl: 300,
  });
  return c.json({ ok: true });
});

// Called by the web dashboard's /dashboard/cli-callback page after auth.
app.post("/api/auth/cli-complete", async (c) => {
  const session = await requireSession(c as Context<{ Bindings: Env }>);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { state, session_id, gateway_secret } = (await c.req.json<{
    state?: string;
    session_id?: string;
    gateway_secret?: string;
  }>()) ?? {};
  if (!state || !session_id || !gateway_secret) {
    return c.json({ error: "state, session_id, gateway_secret required" }, 400);
  }

  const raw = await c.env.KV.get(`cli:${state}`);
  if (!raw) return c.json({ error: "Unknown or expired state" }, 400);

  await c.env.KV.put(
    `cli:${state}`,
    JSON.stringify({ session_id, gateway_secret }),
    { expirationTtl: 300 },
  );
  return c.json({ ok: true });
});

// CLI polls this after opening the browser.
app.get("/api/auth/cli-status", async (c) => {
  const state = c.req.query("state");
  if (!state) return c.json({ error: "state required" }, 400);

  const raw = await c.env.KV.get(`cli:${state}`);
  if (!raw) return c.json({ error: "Unknown or expired state" }, 404);

  const data = JSON.parse(raw) as
    | { pending: boolean }
    | { session_id: string; gateway_secret: string };

  if ("pending" in data && data.pending) {
    return c.json({ status: "pending" }, 202);
  }
  await c.env.KV.delete(`cli:${state}`);
  return c.json({ status: "complete", ...data });
});

// ── AUTH — mobile deep link verify ───────────────────────────────────────

// Mobile calls this after receiving the deep link token.
app.post("/api/auth/mobile-verify", async (c) => {
  const { token } = (await c.req.json<{ token?: string }>()) ?? {};
  if (!token) return c.json({ error: "token required" }, 400);

  const hash = await sha256Hex(token);
  const raw = await c.env.KV.get(`motp:${hash}`);
  if (!raw) return c.json({ error: "Invalid or expired token" }, 400);
  await c.env.KV.delete(`motp:${hash}`);

  const { email } = JSON.parse(raw) as { email: string };
  const user = await findOrCreateUser(c.env.DB, email);
  const payload: SessionPayload = {
    session_id: crypto.randomUUID(),
    user_id: user.id,
    email: user.email,
  };
  const sessionToken = await issueSessionToken(c.env.KV, payload);

  return c.json({ session_token: sessionToken, email: user.email });
});

// ── AUTH — sign out ───────────────────────────────────────────────────────

app.post("/api/auth/signout", async (c) => {
  const cookie = parseSessionCookie(c.req.header("Cookie") ?? null);
  if (cookie) await revokeSessionToken(c.env.KV, cookie);
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookie(c.env.COOKIE_DOMAIN),
    },
  });
});

// ── AUTH — who am I ───────────────────────────────────────────────────────

app.get("/api/auth/me", async (c) => {
  const session = await requireSession(c as Context<{ Bindings: Env }>);
  if (!session) return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, email: session.email, user_id: session.user_id });
});

// ── SESSIONS — list / create / delete ────────────────────────────────────

app.get("/api/sessions", async (c) => {
  const session = await requireSession(c as Context<{ Bindings: Env }>);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const rows = await c.env.DB.prepare(
    "SELECT id, name, last_seen, online FROM gateway_sessions WHERE user_id = ? ORDER BY last_seen DESC",
  )
    .bind(session.user_id)
    .all<Pick<GatewaySessionRow, "id" | "name" | "last_seen" | "online">>();

  return c.json({ sessions: rows.results ?? [] });
});

app.post("/api/sessions", async (c) => {
  const session = await requireSession(c as Context<{ Bindings: Env }>);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const { name } = (await c.req.json<{ name?: string }>()) ?? {};
  const sessionId = crypto.randomUUID();
  const gatewaySecret = crypto.randomUUID() + "-" + crypto.randomUUID();
  const secretHash = await sha256Hex(gatewaySecret);

  await c.env.DB.prepare(
    "INSERT INTO gateway_sessions (id, user_id, name, gateway_secret_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(sessionId, session.user_id, name ?? "My Gateway", secretHash)
    .run();

  // gateway_secret shown ONCE — never stored in plaintext, never sent to mobile.
  return c.json({ session_id: sessionId, gateway_secret: gatewaySecret }, 201);
});

app.delete("/api/sessions/:id", async (c) => {
  const session = await requireSession(c as Context<{ Bindings: Env }>);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT user_id FROM gateway_sessions WHERE id = ?",
  )
    .bind(sessionId)
    .first<{ user_id: string }>();

  if (!row || row.user_id !== session.user_id) {
    return c.json({ error: "Not found" }, 404);
  }

  // Force-disconnect closes WS connections, revokes relay_token, and marks offline.
  const doId = c.env.GATEWAY_SESSION.idFromName(sessionId);
  const stub = c.env.GATEWAY_SESSION.get(doId);
  try {
    await stub.fetch(
      new Request(`http://do/force-disconnect?session_id=${sessionId}`, { method: "POST" }),
    );
  } catch {
    // Best effort — continue with delete even if DO is unreachable
  }

  await c.env.DB.prepare("DELETE FROM gateway_sessions WHERE id = ?")
    .bind(sessionId)
    .run();

  return c.json({ ok: true });
});

// ── RELAY — gateway WebSocket ─────────────────────────────────────────────

app.get("/relay/:sessionId", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "WebSocket upgrade required" }, 426);
  }

  const sessionId = c.req.param("sessionId");
  // Rate limit per session_id: 60 req/min.
  const rlKey = `rl:relay:${sessionId}`;
  if (!(await kvRateLimitOk(c.env.KV, rlKey, 60, 60))) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  const doId = c.env.GATEWAY_SESSION.idFromName(sessionId);
  const stub = c.env.GATEWAY_SESSION.get(doId);
  return stub.fetch(
    new Request(
      `http://do/?session_id=${sessionId}`,
      c.req.raw,
    ),
  );
});

// ── RELAY — mobile HTTP (status / control / stream) ───────────────────────

async function relayToSession(
  c: Context<{ Bindings: Env }>,
  sessionId: string,
  path: string,
): Promise<Response> {
  const session = await requireSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  // Rate limit: 30 req/min per user for control.
  if (path === "/control") {
    const rlKey = `rl:ctrl:${session.user_id}`;
    if (!(await kvRateLimitOk(c.env.KV, rlKey, 30, 60))) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
  }

  // Verify user owns this session.
  const row = await c.env.DB.prepare(
    "SELECT user_id FROM gateway_sessions WHERE id = ?",
  )
    .bind(sessionId)
    .first<{ user_id: string }>();
  if (!row || row.user_id !== session.user_id) {
    return c.json({ error: "Not found" }, 404);
  }

  const doId = c.env.GATEWAY_SESSION.idFromName(sessionId);
  const stub = c.env.GATEWAY_SESSION.get(doId);
  return stub.fetch(
    new Request(`http://do${path}`, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: path !== "/status" && path !== "/stream" ? c.req.raw.body : undefined,
    }),
  );
}

app.get("/api/sessions/:id/status", async (c) =>
  relayToSession(c as Context<{ Bindings: Env }>, c.req.param("id"), "/status"),
);
app.post("/api/sessions/:id/control", async (c) =>
  relayToSession(c as Context<{ Bindings: Env }>, c.req.param("id"), "/control"),
);
app.get("/api/sessions/:id/stream", async (c) =>
  relayToSession(c as Context<{ Bindings: Env }>, c.req.param("id"), "/stream"),
);

// ── Mobile one-time token endpoint ─────────────────────────────────────────
// After OAuth/magic link on mobile web-browser, issue a short-lived OTP and
// redirect to the deep link so the native app can exchange it.
app.get("/api/auth/mobile-redirect", async (c) => {
  const session = await requireSession(c as Context<{ Bindings: Env }>);
  if (!session) return Response.redirect("https://www.zintus.ai/login?mobile=true");

  const otp = crypto.randomUUID() + "-" + crypto.randomUUID();
  const hash = await sha256Hex(otp);
  await c.env.KV.put(
    `motp:${hash}`,
    JSON.stringify({ email: session.email }),
    { expirationTtl: 60 },
  );
  return Response.redirect(`zintus://auth?token=${otp}`, 302);
});

// ── Billing routes ────────────────────────────────────────────────────────

app.post('/api/billing/checkout', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const { tier, ref } = await c.req.json<{ tier: 'starter' | 'growth' | 'scale'; ref?: string }>();
  if (!['starter', 'growth', 'scale'].includes(tier)) {
    return c.json({ error: 'Invalid tier' }, 400);
  }

  // Managed-key tiers (starter/growth/scale) sell Zintus-managed key custody,
  // whose backend was removed (scaffold, never wired). Until it actually ships
  // these are NOT purchasable — block checkout so no one pays for an unbuilt
  // feature. Single re-enable toggle: MANAGED_KEYS_AVAILABLE in tiers.ts.
  if (!MANAGED_KEYS_AVAILABLE && (MANAGED_KEY_TIERS as readonly string[]).includes(tier)) {
    return c.json(
      {
        error: {
          code: 'managed_keys_unavailable',
          message: 'Managed-key tiers are coming soon and not yet available for purchase.',
        },
      },
      503,
    );
  }

  const user = await c.env.DB.prepare('SELECT email FROM zintus_users WHERE id = ?')
    .bind(session.user_id).first<{ email: string }>();
  if (!user) return c.json({ error: 'User not found' }, 404);

  try {
    const url = await createCheckoutSession(session.user_id, user.email, tier, ref ?? null, c.env);
    return c.json({ url });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.get('/api/billing/status', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const sub = await c.env.DB.prepare(
    'SELECT * FROM subscriptions WHERE user_id = ? AND status IN (?, ?)'
  ).bind(session.user_id, 'active', 'past_due').first<SubscriptionRow>();

  const referralCode = await getOrCreateReferralCode(session.user_id, c.env);

  const periodKey = new Date().toISOString().slice(0, 7);
  const tokensUsed = parseInt(await c.env.KV.get(`quota:${session.user_id}:${periodKey}`) ?? '0', 10);

  return c.json({
    tier: sub?.tier ?? 'free',
    status: sub?.status ?? 'active',
    tokens_used: tokensUsed,
    tokens_limit: sub?.tokens_limit ?? null,
    period_end: sub?.current_period_end ?? null,
    referral_code: referralCode,
  });
});

app.post('/api/billing/portal', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const sub = await c.env.DB.prepare(
    'SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?'
  ).bind(session.user_id).first<{ stripe_customer_id: string | null }>();

  if (!sub?.stripe_customer_id) return c.json({ error: 'No billing account' }, 404);

  const url = await createPortalSession(sub.stripe_customer_id, c.env);
  return c.json({ url });
});

app.post('/api/billing/webhook', async (c) => {
  return handleStripeWebhook(c.req.raw, c.env);
});

// ── Usage routes ──────────────────────────────────────────────────────────

app.get('/api/usage/current', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const periodKey = new Date().toISOString().slice(0, 7);
  const used = parseInt(await c.env.KV.get(`quota:${session.user_id}:${periodKey}`) ?? '0', 10);

  const sub = await c.env.DB.prepare(
    'SELECT tokens_limit, current_period_end FROM subscriptions WHERE user_id = ? AND status = ?'
  ).bind(session.user_id, 'active').first<{ tokens_limit: number | null; current_period_end: number | null }>();

  return c.json({
    tokens_used: used,
    tokens_limit: sub?.tokens_limit ?? null,
    period: periodKey,
    percent_used: sub?.tokens_limit ? Math.round((used / sub.tokens_limit) * 100) : null,
    period_end: sub?.current_period_end ?? null,
  });
});

app.get('/api/usage/history', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const rows = await c.env.DB.prepare(`
    SELECT date(created_at, 'unixepoch') as day, SUM(total_tokens) as tokens
    FROM usage_log
    WHERE user_id = ? AND created_at >= unixepoch() - 60*60*24*30
    GROUP BY day ORDER BY day ASC
  `).bind(session.user_id).all<{ day: string; tokens: number }>();

  return c.json({ history: rows.results });
});

app.post('/api/usage/report', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const { provider, model, input_tokens, output_tokens } = await c.req.json<{
    provider: string; model: string; input_tokens: number; output_tokens: number;
  }>();

  await recordUsage(session.user_id, provider, model, input_tokens, output_tokens, c.env);
  return c.json({ ok: true });
});

// ── Referral routes ───────────────────────────────────────────────────────

app.get('/api/referral/code', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const code = await getOrCreateReferralCode(session.user_id, c.env);
  const link = `https://www.zintus.ai/r/${code}`;

  const earnings = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(commission_cents),0) as total FROM referrals WHERE referrer_id=? AND status=?'
  ).bind(session.user_id, 'confirmed').first<{ total: number }>();

  return c.json({ code, link, earnings_cents: earnings?.total ?? 0 });
});

app.get('/api/referral/stats', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const stats = await c.env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) as confirmed,
      SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) as pending,
      COALESCE(SUM(CASE WHEN status='confirmed' THEN commission_cents ELSE 0 END),0) as earned_cents
    FROM referrals WHERE referrer_id=?
  `).bind(session.user_id).first<{ total: number; confirmed: number; pending: number; earned_cents: number }>();

  return c.json(stats ?? { total: 0, confirmed: 0, pending: 0, earned_cents: 0 });
});

app.get('/api/referral/resolve', async (c) => {
  const code = c.req.query('code') ?? '';
  const userId = await resolveReferralCode(code, c.env);
  return c.json({ valid: !!userId });
});

// ── Referral short-link redirect ──────────────────────────────────────────

app.get('/r/:code', async (c) => {
  const code = c.req.param('code');
  const userId = await resolveReferralCode(code, c.env);
  if (!userId) return c.redirect('https://www.zintus.ai/pricing', 302);

  const cookieDomain = c.env.COOKIE_DOMAIN ?? '';
  const cookieStr = [
    `zintus_ref=${code}`,
    'Max-Age=2592000', // 30 days
    'Path=/',
    'SameSite=Lax',
    ...(cookieDomain ? [`Domain=${cookieDomain}`] : []),
  ].join('; ');

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://www.zintus.ai/pricing?ref=${code}`,
      'Set-Cookie': cookieStr,
    },
  });
});

export default app;
