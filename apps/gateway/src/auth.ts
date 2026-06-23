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

export function resolveCorsOrigin(
  origins: string[] | "*",
  requestOrigin: string | null,
): string | null {
  if (origins === "*") {
    return "*";
  }
  if (requestOrigin && origins.includes(requestOrigin)) {
    return requestOrigin;
  }
  return null;
}

export interface GatewayConfig {
  port: number;
  host: string;
  token: string;
  corsOrigins: string[] | "*";
  /** Reject request bodies larger than this many bytes with 413. */
  maxBodyBytes?: number;
  /** Reject requests with more than this many messages with 413. */
  maxMessages?: number;
  /** Abort a chat request that takes longer than this to start streaming (408). */
  requestTimeoutMs?: number;
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
  const exposesNetwork = host === "0.0.0.0" || host === "::";
  if (exposesNetwork && !token) {
    throw new Error(
      "Refusing to bind to a public interface without GATEWAY_TOKEN set. " +
        "Set GATEWAY_TOKEN to require authentication, or bind to 127.0.0.1.",
    );
  }

  return {
    port,
    host,
    token,
    corsOrigins: parseCorsOrigins(env.GATEWAY_CORS_ORIGIN),
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
    tavilyApiKey: env.TAVILY_API_KEY?.trim() || undefined,
    serperApiKey: env.SERPER_API_KEY?.trim() || undefined,
  };
}
