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
import type { Env, GatewaySessionRow, UserRow } from "./types.js";
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

// Re-export the Durable Object class for wrangler to find.
export { GatewaySession } from "./GatewaySession.js";

const app = new Hono<{ Bindings: Env }>();

// ── Security headers + CORS ────────────────────────────────────────────────

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
    origin: (origin) => origin ?? "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

// ── Helpers ───────────────────────────────────────────────────────────────

function isSecure(request: Request): boolean {
  return (
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https"
  );
}

async function requireSession(
  c: Context<{ Bindings: Env }>,
): Promise<SessionPayload | null> {
  const cookie = parseSessionCookie(c.req.header("Cookie") ?? null);
  if (!cookie) return null;
  return verifySessionToken(c.env.KV, cookie);
}

async function kvRateLimitOk(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSecs: number,
): Promise<boolean> {
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) return false;
  await kv.put(key, String(count + 1), { expirationTtl: windowSecs });
  return true;
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
  secure: boolean,
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
  return buildSessionCookie(token, secure);
}

// ── Health ────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ ok: true }));

// ── AUTH — magic link ─────────────────────────────────────────────────────

app.post("/api/auth/magic-link", async (c) => {
  const { email } = (await c.req.json<{ email?: string }>()) ?? {};
  if (!email || !email.includes("@")) {
    return c.json({ error: "Valid email required" }, 400);
  }

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const rlKey = `rl:ml:${email.toLowerCase()}`;
  if (!(await kvRateLimitOk(c.env.KV, rlKey, 3, 3600))) {
    return c.json({ error: "Too many magic link requests (3/hour)" }, 429);
  }

  // Store a short-lived token in KV (15 min).
  const token = crypto.randomUUID() + "-" + crypto.randomUUID();
  const hash = await sha256Hex(token);
  const redirectTo = c.req.query("redirect_to") ?? "https://www.zintus.ai/dashboard";
  await c.env.KV.put(
    `ml:${hash}`,
    JSON.stringify({ email, redirect_to: redirectTo }),
    { expirationTtl: 900 },
  );

  const verifyUrl = `${c.env.RELAY_BASE_URL}/api/auth/verify?token=${token}`;

  await fetch("https://api.resend.com/emails", {
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
  }).catch(() => {
    // Log but don't fail — Resend errors shouldn't expose internals.
    void ip;
  });

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
  const secure = isSecure(c.req.raw);
  const cookieValue = await createUserSession(c.env.KV, c.env.DB, user, secure);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect_to,
      "Set-Cookie": cookieValue,
    },
  });
});

// ── AUTH — Google OAuth ───────────────────────────────────────────────────

app.get("/api/auth/google", async (c) => {
  const state = crypto.randomUUID();
  const redirectTo = c.req.query("redirect_to") ?? "https://www.zintus.ai/dashboard";
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

  // Decode the id_token (no verify needed — came from Google).
  const parts = tokens.id_token?.split(".") ?? [];
  if (parts.length < 2) return c.json({ error: "Invalid id_token" }, 502);
  const claims = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as {
    email?: string;
  };
  if (!claims.email) return c.json({ error: "No email in token" }, 502);

  const user = await findOrCreateUser(c.env.DB, claims.email);
  const secure = isSecure(c.req.raw);
  const cookieValue = await createUserSession(c.env.KV, c.env.DB, user, secure);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect_to,
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
      "Set-Cookie": clearSessionCookie(isSecure(c.req.raw)),
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

  // Invalidate relay_token in KV (all entries for this session expire naturally,
  // but we proactively mark offline so the DO knows it's gone).
  const doId = c.env.GATEWAY_SESSION.idFromName(sessionId);
  const stub = c.env.GATEWAY_SESSION.get(doId);
  await stub.fetch(
    new Request(`http://do/offline?session_id=${sessionId}`, { method: "POST" }),
  );

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

export default app;
