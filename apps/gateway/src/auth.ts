/**
 * Pure, side-effect-free gateway auth/config helpers. Kept separate from the
 * server entrypoint so they can be unit-tested without starting Bun.serve.
 */

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Returns true when the request is authorized. When `token` is empty, auth is
 * disabled and all requests pass (only safe on a loopback bind).
 */
export function bearerAuthorized(
  authorizationHeader: string | null,
  token: string,
): boolean {
  if (!token) {
    return true;
  }
  const prefix = "Bearer ";
  if (!authorizationHeader || !authorizationHeader.startsWith(prefix)) {
    return false;
  }
  return timingSafeEqual(authorizationHeader.slice(prefix.length), token);
}

export function parseCorsOrigins(raw: string | undefined): string[] | "*" {
  const value = raw?.trim();
  if (!value || value === "*") {
    return "*";
  }
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

// Origins always allowed for a tokenless ("loopback") gateway in addition to
// any localhost origin: the desktop (Tauri) webview and the official Zintus web
// app. A self-hoster on a different web origin sets GATEWAY_CORS_ORIGIN.
const TAURI_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];
const OFFICIAL_WEB_ORIGINS = ["https://www.zintus.ai", "https://zintus.ai"];

/** True for http(s)://localhost | 127.0.0.1 | [::1] on ANY port. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

/**
 * True only for loopback BIND hosts — `localhost`, the 127.0.0.0/8 range, or
 * IPv6 `::1`. Every other value (`0.0.0.0`, `::`, a LAN IP like 192.168.x / 10.x,
 * a public IP, or a hostname) is network-exposed and must require a
 * GATEWAY_TOKEN. Takes a bare host (unlike `isLoopbackOrigin`, which takes a URL).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  if (h === "localhost") return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // 127.0.0.0/8 — the whole loopback range, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function resolveCorsOrigin(
  origins: string[] | "*" | "loopback",
  requestOrigin: string | null,
): string | null {
  if (origins === "*") {
    return "*";
  }
  if (!requestOrigin) {
    return null;
  }
  if (origins === "loopback") {
    // Tokenless local gateway: allow local dev (any localhost port), the desktop
    // webview, and the official web app — but NOT arbitrary websites, which could
    // otherwise drive the user's gateway and read their AI responses (CORS lets
    // them read the body). Reflect the specific origin, never "*".
    return isLoopbackOrigin(requestOrigin) ||
      TAURI_ORIGINS.includes(requestOrigin) ||
      OFFICIAL_WEB_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : null;
  }
  return origins.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * Default CORS policy when GATEWAY_CORS_ORIGIN is unset: a token-protected
 * gateway may safely allow any origin ("*", auth gates it); a tokenless gateway
 * restricts to local/official origins ("loopback") so a random website can't
 * reach it. An explicit GATEWAY_CORS_ORIGIN always wins (may be "*").
 */
export function resolveDefaultCors(
  raw: string | undefined,
  token: string,
): string[] | "*" | "loopback" {
  if (raw && raw.trim()) {
    return parseCorsOrigins(raw);
  }
  return token ? "*" : "loopback";
}

export interface GatewayConfig {
  port: number;
  host: string;
  token: string;
  corsOrigins: string[] | "*" | "loopback";
  /** Reject request bodies larger than this many bytes with 413. */
  maxBodyBytes?: number;
  /** Reject requests with more than this many messages with 413. */
  maxMessages?: number;
  /** Abort a chat request that takes longer than this to start streaming (408). */
  requestTimeoutMs?: number;
  /**
   * Mid-stream idle watchdog: abort the upstream and surface an error if no
   * chunk arrives within this many ms while a stream is open. 0 disables the
   * watchdog; undefined falls back to the handler default.
   */
  streamIdleTimeoutMs?: number;
  /** Tavily API key — enables web search on providers without native support. */
  tavilyApiKey?: string;
  /** Serper API key — automatic fallback when Tavily quota is exhausted. */
  serperApiKey?: string;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

/**
 * Like parsePositiveInt but permits 0, which callers use as an explicit
 * "disabled" sentinel (e.g. the mid-stream idle watchdog).
 */
function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

/**
 * Validate environment into a GatewayConfig, throwing on invalid or unsafe
 * combinations (e.g. binding to a public interface with no auth token).
 */
export function buildGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const port = Number(env.GATEWAY_PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid GATEWAY_PORT: ${env.GATEWAY_PORT}`);
  }

  const token = env.GATEWAY_TOKEN?.trim() ?? "";
  const host = env.GATEWAY_HOST?.trim() || "127.0.0.1";
  // ANY non-loopback bind is network-exposed — not just 0.0.0.0/::. A tokenless
  // gateway on a LAN IP (e.g. 192.168.x, set to reach it from a phone) is an open
  // denial-of-wallet: a no-Origin LAN client skips the CORS/Origin guard and can
  // burn the user's BYOK quota / read responses. Require a token for all of them.
  const exposesNetwork = !isLoopbackHost(host);
  if (exposesNetwork && !token) {
    throw new Error(
      `Refusing to bind the gateway to a non-loopback host (${host}) without ` +
        "GATEWAY_TOKEN set — that exposes your BYOK gateway to the LAN/internet " +
        "(denial-of-wallet, prompt/response exposure). Set GATEWAY_TOKEN to " +
        "require authentication, or bind to 127.0.0.1.",
    );
  }

  return {
    port,
    host,
    token,
    corsOrigins: resolveDefaultCors(env.GATEWAY_CORS_ORIGIN, token),
    maxBodyBytes: parsePositiveInt(
      env.GATEWAY_MAX_BODY_BYTES,
      1_000_000,
      "GATEWAY_MAX_BODY_BYTES",
    ),
    maxMessages: parsePositiveInt(
      env.GATEWAY_MAX_MESSAGES,
      200,
      "GATEWAY_MAX_MESSAGES",
    ),
    requestTimeoutMs: parsePositiveInt(
      env.GATEWAY_REQUEST_TIMEOUT_MS,
      60_000,
      "GATEWAY_REQUEST_TIMEOUT_MS",
    ),
    // Mid-stream idle watchdog. Defaults to 60s of allowed silence between
    // chunks; set GATEWAY_STREAM_IDLE_TIMEOUT_MS=0 to disable it entirely.
    streamIdleTimeoutMs: parseNonNegativeInt(
      env.GATEWAY_STREAM_IDLE_TIMEOUT_MS,
      60_000,
      "GATEWAY_STREAM_IDLE_TIMEOUT_MS",
    ),
    tavilyApiKey: env.TAVILY_API_KEY?.trim() || undefined,
    serperApiKey: env.SERPER_API_KEY?.trim() || undefined,
  };
}
