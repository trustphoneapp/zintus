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
 *   ACCOUNT (user cookie auth):
 *     DELETE /api/account   — self-service account + data deletion
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
import { MagicLinkRequestSchema, VerifyCodeRequestSchema } from "@zintus/schemas";
import { redactSecrets } from "./redact.js";
import type { Env, GatewaySessionRow, UserRow, SubscriptionRow } from "./types.js";
import {
  sha256Hex,
  verifyGatewaySecret,
  issueSessionToken,
  verifySessionToken,
  revokeSessionToken,
  tombstoneDeletedUser,
  isUserDeleted,
  parseSessionCookie,
  buildSessionCookie,
  clearSessionCookie,
  type SessionPayload,
} from "./auth.js";
import { createCheckoutSession, createPortalSession, handleStripeWebhook, cancelStripeSubscription } from "./billing.js";
import { checkoutAvailability } from "./tiers.js";
import { handleManagedChat, handleManagedModels } from "./managed.js";
import { handleResearchSession } from "./research.js";
import {
  handleManagedServices,
  handleManagedImage,
  handleManagedTranscribe,
} from "./services.js";
import { corsOrigin, validateRedirectTo } from "./http-security.js";
import { enforceQuota, recordUsage, getQuotaUsed, resetQuota } from "./middleware/quota.js";
import { createErrorSink } from "./observability.js";
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
  verifyCodeKey,
  VERIFY_CODE_LIMIT,
  VERIFY_CODE_WINDOW_SECS,
  usageReportKey,
  USAGE_REPORT_LIMIT,
  USAGE_REPORT_WINDOW_SECS,
  accountDeleteKey,
  ACCOUNT_DELETE_LIMIT,
  ACCOUNT_DELETE_WINDOW_SECS,
} from "./rate-limit.js";

// Re-export the Durable Object classes for wrangler to find.
export { GatewaySession } from "./GatewaySession.js";
export { QuotaCounter } from "./QuotaCounter.js";

const app = new Hono<{ Bindings: Env }>();

// ── Error handler ──────────────────────────────────────────────────────────
// Uncaught errors (e.g. `throw new Error("Stripe checkout error: ...")` in
// billing.ts) must not leak internal detail to the client, and any secret in
// the message/stack must be scrubbed before the platform captures it. Returns a
// generic 500; logs the error REDACTED (this is the relay's only error log).
app.onError((err, c) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error("relay.error", redactSecrets(detail));

  // Opt-in error sink: when SENTRY_DSN is configured, report the (redacted)
  // error out-of-band. No-op + zero overhead when unset. Never let reporting
  // throw — fall through to the generic 500 regardless.
  const sink = createErrorSink(c.env ?? {});
  if (sink) {
    const reported = sink(err, { path: c.req.path, method: c.req.method });
    try {
      c.executionCtx.waitUntil(reported);
    } catch {
      // No execution context (e.g. unit tests via app.request) — let it run.
      void reported;
    }
  }

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
  // Cookie (browser) OR `Authorization: Bearer <session_token>` (desktop/mobile
  // native clients, which cannot set cross-origin cookies). Both carry the SAME
  // KV-verified session token — the bearer path adds no new credential class.
  // Gateway secrets are a different token family and fail verifySessionToken,
  // so they cannot masquerade as user sessions here.
  const cookie = parseSessionCookie(c.req.header("Cookie") ?? null);
  const presented = cookie || parseBearerToken(c.req.header("Authorization") ?? null);
  if (!presented) return null;
  const session = await verifySessionToken(c.env.KV, presented);
  if (!session) return null;
  // Reject ANY still-cached session token for a deleted user. Account deletion
  // only revokes the presented cookie's KV token; this tombstone check (one KV
  // read on the cookie-auth control path) invalidates the user's orphan tokens
  // immediately, before its ~30-day TTL would expire them. The high-volume
  // gateway WebSocket path (`/relay/:sessionId`) uses relay_token auth, not
  // requireSession, so it pays no extra read.
  if (await isUserDeleted(c.env.KV, session.user_id)) return null;
  return session;
}

/** Parse a Bearer token from an Authorization header. "" if absent/malformed. */
function parseBearerToken(authHeader: string | null): string {
  if (!authHeader) return "";
  const m = /^Bearer\s+(.+)$/.exec(authHeader.trim());
  return m ? m[1]!.trim() : "";
}

type SessionAuthz =
  | { ok: true; via: "cookie" | "bearer"; user_id: string }
  | { ok: false; status: 401 | 404; body: { error: string } };

/**
 * Authorize a request that targets ONE specific gateway session `:id`.
 *
 * Two independent paths are accepted:
 *   (a) a valid user-session cookie whose user OWNS session `:id` (web/dashboard);
 *   (b) ONLY when `allowGatewaySecret` is true — an `Authorization: Bearer
 *       <gateway_secret>` whose SHA-256 matches the stored `gateway_secret_hash`
 *       of THIS session `:id` (the CLI, which holds the secret but has no cookie).
 *
 * ISOLATION INVARIANT (critical): the row is fetched by `:id`, and the Bearer is
 * compared ONLY against THAT row's `gateway_secret_hash`. A gateway_secret can
 * therefore authorize ONLY the single session it belongs to — session B's secret
 * presented against session A's id never matches A's stored hash, so it falls
 * through to the cookie path and ends at 401. Comparison reuses the timing-safe
 * `verifyGatewaySecret` — the exact scheme the WS register handshake uses
 * (GatewaySession.ts) — so we never invent a new check or compare raw secrets.
 *
 * `requireSession` (and every cookie-only route) is left untouched; only callers
 * that opt in via `allowGatewaySecret` gain the Bearer alternative.
 */
async function authorizeSessionScoped(
  c: Context<{ Bindings: Env }>,
  sessionId: string,
  allowGatewaySecret: boolean,
): Promise<SessionAuthz> {
  const row = await c.env.DB.prepare(
    "SELECT user_id, gateway_secret_hash FROM gateway_sessions WHERE id = ?",
  )
    .bind(sessionId)
    .first<{ user_id: string; gateway_secret_hash: string }>();

  // (b) Bearer gateway_secret — bound to THIS session id only.
  if (allowGatewaySecret) {
    const bearer = parseBearerToken(c.req.header("Authorization") ?? null);
    if (
      bearer &&
      row?.gateway_secret_hash &&
      (await verifyGatewaySecret(bearer, row.gateway_secret_hash))
    ) {
      return { ok: true, via: "bearer", user_id: row.user_id };
    }
  }

  // (a) Session cookie — user must own this session.
  const cookieSession = await requireSession(c);
  if (cookieSession) {
    if (row && row.user_id === cookieSession.user_id) {
      return { ok: true, via: "cookie", user_id: cookieSession.user_id };
    }
    // Authenticated but not the owner (or session gone): 404, never leak existence.
    return { ok: false, status: 404, body: { error: "Not found" } };
  }

  return { ok: false, status: 401, body: { error: "Unauthorized" } };
}

// Exported for unit tests (duplicate-prevention). Normalises the email before
// both the lookup and the insert so case/whitespace variants of the SAME address
// (e.g. "User@Example.com " vs "user@example.com") resolve to one row instead of
// silently creating duplicate users. The rate-limit path already lowercases the
// email (magicLinkEmailKey); the persisted user row must agree, or two "users"
// share one inbox. Gmail-style dot/plus aliasing is intentionally NOT collapsed
// (those are distinct addresses at many providers) — only case + surrounding
// whitespace, which never change identity.
export async function findOrCreateUser(
  db: D1Database,
  rawEmail: string,
): Promise<UserRow> {
  const email = rawEmail.trim().toLowerCase();
  const existing = await db
    .prepare("SELECT * FROM zintus_users WHERE email = ?")
    .bind(email)
    .first<UserRow>();
  if (existing) return existing;
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await db
    .prepare(
      "INSERT INTO zintus_users (id, email, created_at) VALUES (?, ?, ?)",
    )
    .bind(id, email, createdAt)
    .run();
  return { id, email, created_at: createdAt };
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

/** Uniform 6-digit code via rejection sampling (no modulo bias). */
function randomSixDigitCode(): string {
  const limit = 4_294_000_000; // largest multiple of 1e6 ≤ 2^32
  let v: number;
  do {
    v = crypto.getRandomValues(new Uint32Array(1))[0]!;
  } while (v >= limit);
  return String(v % 1_000_000).padStart(6, "0");
}

/** KV pointer to the newest link+code pair for an email (latest-wins). */
function latestArtifactKey(email: string): string {
  return `mlatest:${email.toLowerCase()}`;
}

/** Single-use consumption: redeeming EITHER artifact deletes the whole
 *  family (link, code, latest pointer) so nothing outlives a successful
 *  sign-in. Pass whichever hash was presented; the other is resolved from
 *  the latest pointer. */
async function consumeArtifactFamily(
  kv: KVNamespace,
  email: string,
  tokenHash: string | null,
  codeHash: string | null,
): Promise<void> {
  const raw = await kv.get(latestArtifactKey(email));
  if (raw) {
    try {
      const latest = JSON.parse(raw) as { tokenHash?: string; codeHash?: string };
      tokenHash = tokenHash ?? latest.tokenHash ?? null;
      codeHash = codeHash ?? latest.codeHash ?? null;
    } catch { /* stale pointer */ }
  }
  if (tokenHash) await kv.delete(`ml:${tokenHash}`);
  if (codeHash) await kv.delete(`mlcode:${codeHash}`);
  await kv.delete(latestArtifactKey(email));
}

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

  // One email carries BOTH artifacts (the canonical passwordless pattern —
  // see docs/auth: Anthropic's same-device link + cross-device code):
  //   • magic link — same-device happy path, one click
  //   • 6-digit code — typed on the ORIGINAL device when the email is opened
  //     elsewhere (the desktop device-flow case a bare link cannot complete)
  // Both are single-use, share the 15-min TTL, and are invalidated together.
  const token = crypto.randomUUID() + "-" + crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const code = randomSixDigitCode();
  const codeHash = await sha256Hex(`${email.toLowerCase()}:${code}`);
  const redirectTo = validateRedirectTo(
    c.req.query("redirect_to") ?? parsed.data.redirectTo,
  );

  // Latest-artifact-wins (Auth0/NIST pattern): requesting a new email kills
  // the previous link AND code, so only the newest email ever signs in.
  const prevRaw = await c.env.KV.get(latestArtifactKey(email));
  if (prevRaw) {
    try {
      const prev = JSON.parse(prevRaw) as { tokenHash?: string; codeHash?: string };
      if (prev.tokenHash) await c.env.KV.delete(`ml:${prev.tokenHash}`);
      if (prev.codeHash) await c.env.KV.delete(`mlcode:${prev.codeHash}`);
    } catch { /* stale pointer — nothing to revoke */ }
  }

  const artifactPayload = JSON.stringify({ email, redirect_to: redirectTo });
  await c.env.KV.put(`ml:${tokenHash}`, artifactPayload, { expirationTtl: 900 });
  await c.env.KV.put(`mlcode:${codeHash}`, artifactPayload, { expirationTtl: 900 });
  await c.env.KV.put(
    latestArtifactKey(email),
    JSON.stringify({ tokenHash, codeHash }),
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
        <p style="margin-top:20px;">Reading this on a different device? Enter this code on the sign-in screen instead:</p>
        <p style="font-size:28px;letter-spacing:6px;font-weight:700;font-family:monospace;">${code}</p>
        <p style="color:#888;font-size:13px;">If you didn't request this, you can ignore this email. Requesting a new email invalidates this one.</p>
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
  // Browser-facing endpoint: failures REDIRECT to the login page with a
  // reason (the page shows "link expired — get a new one" and preserves the
  // flow) instead of dead-ending the user on raw JSON.
  const failRedirect = new Response(null, {
    status: 302,
    headers: { Location: "https://www.zintus.ai/login?error=link_expired" },
  });

  const token = c.req.query("token");
  if (!token) return failRedirect;

  const hash = await sha256Hex(token);
  const raw = await c.env.KV.get(`ml:${hash}`);
  if (!raw) return failRedirect;

  const { email, redirect_to } = JSON.parse(raw) as {
    email: string;
    redirect_to: string;
  };
  await consumeArtifactFamily(c.env.KV, email, hash, null);

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

// ── AUTH — verify fallback code (wrong-device recovery) ──────────────────

app.post("/api/auth/verify-code", async (c) => {
  const parsed = VerifyCodeRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json({ error: "Valid email and 6-digit code required" }, 400);
  const { email, code } = parsed.data;

  // Attempt throttle BEFORE any lookup — 6 digits is low entropy by design;
  // the limiter is what makes it safe (see rate-limit.ts for the math).
  if (!(await kvRateLimitOk(c.env.KV, verifyCodeKey(email), VERIFY_CODE_LIMIT, VERIFY_CODE_WINDOW_SECS))) {
    return c.json({ error: "Too many code attempts — request a new email" }, 429);
  }

  const codeHash = await sha256Hex(`${email.toLowerCase()}:${code}`);
  const raw = await c.env.KV.get(`mlcode:${codeHash}`);
  if (!raw) return c.json({ error: "Invalid or expired code", code: "code_invalid" }, 400);

  const { redirect_to } = JSON.parse(raw) as { email: string; redirect_to: string };
  await consumeArtifactFamily(c.env.KV, email, null, codeHash);

  const user = await findOrCreateUser(c.env.DB, email);
  const cookieValue = await createUserSession(c.env.KV, c.env.DB, user, c.env.COOKIE_DOMAIN);

  // fetch()-based caller (login page) — JSON + Set-Cookie, client navigates.
  return new Response(
    JSON.stringify({ ok: true, redirect_to: validateRedirectTo(redirect_to) }),
    { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": cookieValue } },
  );
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

  // Also mint a USER session token for the polling client. The desktop app
  // completes this same device flow and then needs to call billing/usage/
  // managed endpoints as the user — which the gateway_secret (a per-gateway
  // credential) deliberately cannot do. Issued while the dashboard's
  // authenticated cookie session is present, exactly like /api/auth/mobile-verify.
  const clientSession = await issueSessionToken(c.env.KV, {
    session_id: crypto.randomUUID(),
    user_id: session.user_id,
    email: session.email,
  });

  await c.env.KV.put(
    `cli:${state}`,
    JSON.stringify({ session_id, gateway_secret, session_token: clientSession, email: session.email }),
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

// ── ACCOUNT — self-service deletion (Google Play / store requirement) ────────
//
// DELETE /api/account — a signed-in user deletes THEIR OWN account and all data.
// Hard rules (the whole point of this route):
//   • The user id is taken ONLY from the verified session cookie
//     (`session.user_id`), NEVER from the request body or a URL param — so one
//     user can never delete another's data. There is intentionally no
//     admin/bulk delete and no id input of any kind.
//   • Every D1 statement is scoped `WHERE user_id = ?`/`email = ?` for THIS user.
//   • Destructive + irreversible → 401 without a session, rate-limited per user,
//     and the session cookie is cleared in the response.
//   • Idempotent: every DELETE simply affects 0 rows once data is gone, so a
//     repeat call (e.g. via a second still-cached session token for the same
//     user) returns 200, not 500.
app.delete("/api/account", async (c) => {
  const session = await requireSession(c as Context<{ Bindings: Env }>);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  // Per-user rate limit on the destructive path (hijacked cookie / buggy client).
  if (
    !(await kvRateLimitOk(
      c.env.KV,
      accountDeleteKey(session.user_id),
      ACCOUNT_DELETE_LIMIT,
      ACCOUNT_DELETE_WINDOW_SECS,
    ))
  ) {
    return c.json({ error: "Too many account-deletion requests" }, 429);
  }

  // The ONLY identity used for the whole operation — never trust client input.
  const userId = session.user_id;
  const email = session.email;

  // Best-effort Stripe cancellation. Managed keys are disabled so there is
  // usually no Stripe subscription, but if one exists AND Stripe is configured,
  // cancel it. A Stripe error must NEVER block the account deletion (the user's
  // right to erasure wins) — log it redacted and continue.
  if (c.env.STRIPE_SECRET_KEY) {
    const sub = await c.env.DB.prepare(
      "SELECT stripe_subscription_id FROM subscriptions WHERE user_id = ? AND stripe_subscription_id IS NOT NULL",
    )
      .bind(userId)
      .first<{ stripe_subscription_id: string | null }>();
    if (sub?.stripe_subscription_id) {
      try {
        await cancelStripeSubscription(sub.stripe_subscription_id, c.env);
      } catch (err) {
        console.error("account.delete.stripe", redactSecrets(String(err)));
      }
    }
  }

  // Wipe the current-period quota counter (Durable Object). Best-effort: a DO
  // hiccup must not strand the D1 deletion — the counter self-prunes anyway.
  try {
    await resetQuota(c.env, userId);
  } catch {
    // Best effort — continue with the D1 deletion.
  }

  // Force-disconnect every LIVE gateway session for this user BEFORE the rows are
  // deleted: closes the relay WebSocket, revokes its relay_token (DO storage + KV
  // `relay:<hash>`) and marks it offline — otherwise an active relay would keep
  // serving the now-deleted account until the 1h token TTL. Best-effort per
  // session (mirrors the per-session DELETE); a DO hiccup must not strand the wipe.
  const gwSessions = await c.env.DB.prepare(
    "SELECT id FROM gateway_sessions WHERE user_id = ?",
  )
    .bind(userId)
    .all<{ id: string }>();
  for (const row of gwSessions.results ?? []) {
    try {
      const stub = c.env.GATEWAY_SESSION.get(
        c.env.GATEWAY_SESSION.idFromName(row.id),
      );
      await stub.fetch(
        new Request(`http://do/force-disconnect?session_id=${row.id}`, {
          method: "POST",
        }),
      );
    } catch {
      // A DO hiccup must not block the account deletion.
    }
  }

  // Delete this user's referral-code → user_id KV maps (referral.ts writes
  // `referral_code:<code>` on creation). The D1 DELETE below drops the rows;
  // without this the KV entries orphan, still resolving to a now-deleted user.
  const referralCodes = await c.env.DB.prepare(
    "SELECT code FROM referral_codes WHERE user_id = ?",
  )
    .bind(userId)
    .all<{ code: string }>();
  for (const row of referralCodes.results ?? []) {
    await c.env.KV.delete(`referral_code:${row.code}`);
  }

  // Delete every D1 row owned by THIS user. Children first, the users row last
  // (matches the FK order; explicit so it works whether or not D1 enforces the
  // ON DELETE CASCADE in schema.sql). All scoped to the session's user id/email.
  await c.env.DB.prepare("DELETE FROM gateway_sessions WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM user_sessions WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM usage_log WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM referrals WHERE referrer_id = ? OR referred_id = ?")
    .bind(userId, userId)
    .run();
  await c.env.DB.prepare("DELETE FROM referral_codes WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM auth_tokens WHERE email = ?").bind(email).run();
  await c.env.DB.prepare("DELETE FROM zintus_users WHERE id = ?").bind(userId).run();

  // Tombstone the user so EVERY still-cached KV session token for them (not just
  // the presented cookie) is rejected by requireSession immediately. Without
  // this, a second independently-issued session token would keep authenticating
  // the deleted user until its ~30-day TTL and could write orphan child rows.
  // TTL matches the max session-token lifetime so the tombstone outlives any
  // token that could still be in KV.
  await tombstoneDeletedUser(c.env.KV, userId);

  // Revoke the presented session token in KV and clear the cookie so the now-
  // deleted user is no longer authenticated. (Other cached KV session tokens for
  // this user are blocked by the tombstone above and expire by TTL; their D1
  // user_sessions rows are already gone.)
  const cookie = parseSessionCookie(c.req.header("Cookie") ?? null);
  if (cookie) await revokeSessionToken(c.env.KV, cookie);

  return new Response(JSON.stringify({ ok: true, deleted: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookie(c.env.COOKIE_DOMAIN),
    },
  });
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
  const sessionId = c.req.param("id");
  // Cookie (owner) OR this session's own gateway_secret via Bearer — so the CLI
  // (`zintus cloud logout`) can delete the row it created without a cookie.
  const authz = await authorizeSessionScoped(
    c as Context<{ Bindings: Env }>,
    sessionId,
    true,
  );
  if (!authz.ok) return c.json(authz.body, authz.status);

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

// Control actions that configure BYOK key custody on the home gateway. They
// perform NO inference, so they consume no tokens and MUST stay usable even when
// a paid user is over their token budget — otherwise an exhausted user is locked
// out of switching to their own key until the month rolls over. This is an
// explicit allow-list: the quota gate is fail-closed, so anything NOT listed here
// (including an unknown or missing action, or malformed JSON) is treated as
// token-consuming and gated. Safe because the home gateway dispatches strictly on
// `action` — a request labelled `set_key` performs key management, not inference,
// so it cannot be used to slip a token-consuming request past the gate.
const QUOTA_EXEMPT_ACTIONS = new Set<string>(["set_key", "remove_key"]);

/** True only for known non-token-consuming (key-management) control actions. */
export function isQuotaExemptControl(bodyText: string): boolean {
  try {
    const action = (JSON.parse(bodyText) as { action?: unknown }).action;
    return typeof action === "string" && QUOTA_EXEMPT_ACTIONS.has(action);
  } catch {
    return false; // unparseable → not exempt → gated (gateway will reject it)
  }
}

async function relayToSession(
  c: Context<{ Bindings: Env }>,
  sessionId: string,
  path: string,
  allowGatewaySecret = false,
): Promise<Response> {
  // Authorize + ownership in one shot. Only the read-only `/status` route opts
  // into the Bearer gateway_secret alternative; `/control` and `/stream` stay
  // cookie-only (allowGatewaySecret defaults to false).
  const authz = await authorizeSessionScoped(c, sessionId, allowGatewaySecret);
  if (!authz.ok) return c.json(authz.body, authz.status);
  const userId = authz.user_id;

  // Rate limit: 30 req/min per user for control.
  if (path === "/control") {
    const rlKey = `rl:ctrl:${userId}`;
    if (!(await kvRateLimitOk(c.env.KV, rlKey, 30, 60))) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
  }

  // For /control we read the body once here to (a) decide whether the action is
  // token-consuming and (b) forward it (the request stream can only be consumed
  // once, so it is buffered into `controlBody`).
  let controlBody: string | undefined;
  if (path === "/control") {
    controlBody = await c.req.text();

    // Quota gate (B3): /control is the user-initiated action that drives token
    // consumption on the home gateway, so this is the "before serving" point.
    // /status and /stream are read-only and not gated; key-management actions
    // (set_key/remove_key) are exempt — see QUOTA_EXEMPT_ACTIONS. Over-budget
    // users get a clear 429 with reset info + LiteLLM/OpenRouter-style headers,
    // instead of silently exceeding their tier.
    //
    // NOTE: enforcement is only as honest as the home gateway — usage is the
    // gateway's self-reported figure via POST /api/usage/report, so a modified
    // gateway could under-report to stay under cap. This is the pre-existing
    // BYOK trust model (the gateway holds the keys and does the inference), not
    // a regression introduced by the gate.
    if (!isQuotaExemptControl(controlBody)) {
      const q = await enforceQuota(userId, c.env);
      if (!q.allowed) {
        const retryAfter = Math.max(1, q.reset - Math.floor(Date.now() / 1000));
        return c.json(
          {
            error: {
              code: "quota_exceeded",
              message: `Monthly token budget exceeded for the ${q.tier} tier.`,
              tier: q.tier,
              limit: q.limit,
              used: q.used,
              reset: q.reset,
            },
          },
          429,
          {
            "Retry-After": String(retryAfter),
            "X-Quota-Limit": String(q.limit ?? ""),
            "X-Quota-Used": String(q.used),
            "X-Quota-Reset": String(q.reset),
          },
        );
      }
    }
  }

  const doId = c.env.GATEWAY_SESSION.idFromName(sessionId);
  const stub = c.env.GATEWAY_SESSION.get(doId);
  return stub.fetch(
    new Request(`http://do${path}`, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: path === "/control" ? controlBody : undefined,
    }),
  );
}

app.get("/api/sessions/:id/status", async (c) =>
  // Read-only status: cookie OR this session's gateway_secret (Bearer) — lets the
  // CLI (`zintus cloud status`) poll without a cookie. Bearer is bound to :id.
  relayToSession(c as Context<{ Bindings: Env }>, c.req.param("id"), "/status", true),
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

  const { tier, ref } = await c.req.json<{ tier: 'starter' | 'pro' | 'max' | 'ultra'; ref?: string }>();
  if (!['starter', 'pro', 'max', 'ultra'].includes(tier)) {
    return c.json({ error: 'Invalid tier' }, 400);
  }

  // Pre-flight gate (see checkoutAvailability in tiers.ts). Returns 503 when:
  //   • managed-key tiers are gated off (MANAGED_KEYS_AVAILABLE=false — the
  //     backend was removed; no one pays for an unbuilt feature), OR
  //   • the flag is flipped on but STRIPE_PRICES are still `price_FILL…`
  //     placeholders — a clear "billing not configured" 503 instead of a 500
  //     bubbling up from the Stripe API.
  const block = checkoutAvailability(tier);
  if (block) {
    return c.json({ error: { code: block.code, message: block.message } }, block.status);
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

  const tokensUsed = await getQuotaUsed(c.env, session.user_id);

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
  const used = await getQuotaUsed(c.env, session.user_id);

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

  // Per-user cap on the self-reported usage path (BYOK trust boundary). Keeps a
  // compromised/abusive cookie from flooding D1 + the QuotaCounter DO; honest
  // report rates stay well under the cap. See rate-limit.ts for the rationale.
  if (!(await kvRateLimitOk(
    c.env.KV, usageReportKey(session.user_id), USAGE_REPORT_LIMIT, USAGE_REPORT_WINDOW_SECS,
  ))) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }

  const { provider, model, input_tokens, output_tokens } = await c.req.json<{
    provider: string; model: string; input_tokens: number; output_tokens: number;
  }>();

  // BYOK self-report: burn 0 — the member pays their own provider, so this
  // is dashboard analytics only and must never debit plan balance. (Before
  // the economics change this path silently consumed paid members' plan
  // tokens at 1:1.) Tier 'free' keeps the display conversion a no-op.
  await recordUsage(session.user_id, provider, model, input_tokens, output_tokens, c.env, 0, 'free');
  return c.json({ ok: true });
});

// ── Managed membership (Zintus-served models) ─────────────────────────────
// See managed.ts. Models list is public (pricing/capability info only); the
// chat path requires an authenticated member session.

app.get('/v1/managed/models', (c) => handleManagedModels(c));

app.post('/v1/managed/chat/completions', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  return handleManagedChat(c, session);
});

// Research session reservation (PRICING-FINAL Part 8) — the gateway calls
// this before starting a deep-research run; see research.ts.
app.post('/v1/managed/research-session', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  return handleResearchSession(c, session);
});

// Flat-fee managed services (PRICING-FINAL Part 4) — see services.ts.
app.get('/v1/managed/services', (c) => handleManagedServices(c));

app.post('/v1/managed/images', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  return handleManagedImage(c, session);
});

app.post('/v1/managed/transcribe', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  return handleManagedTranscribe(c, session);
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
