/**
 * In-process sliding-window rate limiter for the gateway.
 *
 * The gateway runs as a single home-machine process, so an in-memory limiter is
 * sufficient — no KV/Redis needed (the cloud relay, which is multi-tenant and
 * distributed, has its own KV limiter). A stolen GATEWAY_TOKEN can otherwise
 * hammer /v1/chat/completions and burn provider quota or CPU unthrottled.
 *
 * Keying: by default the (unspoofable) bearer token, so a stolen token's total
 * throughput is bounded. X-Forwarded-For / X-Real-IP are used only when
 * trustProxy is set (behind a reverse proxy that overwrites them); otherwise a
 * client could forge a fresh IP per request to evade an IP-keyed limit. Falls
 * back to a constant bucket for fully anonymous traffic.
 */

export interface RateLimiter {
  /** Returns ok=false with retryAfterMs once the window budget is exhausted. */
  check(key: string): { ok: boolean; retryAfterMs: number };
  /** Derive a stable client key from a request. */
  keyFor(request: Request): string;
}

export interface RateLimitConfig {
  /** Max requests allowed per window. <= 0 disables limiting entirely. */
  limit: number;
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /**
   * Whether to trust X-Forwarded-For / X-Real-IP for the client key. Default
   * false: those headers are client-spoofable, so a directly-exposed gateway
   * would let an attacker bypass an IP-keyed limit by forging a fresh IP per
   * request. When false we key by the (unspoofable) bearer token instead. Set
   * true ONLY when the gateway sits behind a trusted reverse proxy that
   * overwrites these headers.
   */
  trustProxy?: boolean;
}

interface Bucket {
  /** Request timestamps (ms) within the current window, oldest first. */
  hits: number[];
}

function hashToken(token: string): string {
  // Small, fast non-cryptographic hash — we only need a stable bucket key, not
  // secrecy. Avoids holding the raw token as a map key.
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `tok:${(h >>> 0).toString(36)}`;
}

export function createRateLimiter(cfg: RateLimitConfig): RateLimiter {
  const { limit, windowMs } = cfg;
  const trustProxy = cfg.trustProxy ?? false;
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  function sweep(now: number): void {
    // Periodically drop empty/expired buckets so memory stays bounded under a
    // churn of distinct keys.
    if (now - lastSweep < windowMs) {
      return;
    }
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      const cutoff = now - windowMs;
      bucket.hits = bucket.hits.filter((t) => t > cutoff);
      if (bucket.hits.length === 0) {
        buckets.delete(key);
      }
    }
  }

  return {
    keyFor(request: Request): string {
      // Only trust forwarding headers behind a configured trusted proxy — they
      // are client-spoofable otherwise.
      if (trustProxy) {
        const fwd = request.headers.get("x-forwarded-for");
        if (fwd) {
          const first = fwd.split(",")[0]?.trim();
          if (first) {
            return `ip:${first}`;
          }
        }
        const realIp = request.headers.get("x-real-ip");
        if (realIp) {
          return `ip:${realIp.trim()}`;
        }
      }
      // Default: key by the (unspoofable) bearer token. For a single-token
      // gateway this throttles total throughput per token — exactly what limits
      // the blast radius of a stolen token.
      const auth = request.headers.get("authorization");
      if (auth) {
        return hashToken(auth);
      }
      return "anon";
    },

    check(key: string): { ok: boolean; retryAfterMs: number } {
      if (limit <= 0) {
        return { ok: true, retryAfterMs: 0 };
      }
      const now = Date.now();
      sweep(now);
      const cutoff = now - windowMs;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { hits: [] };
        buckets.set(key, bucket);
      }
      // Drop hits that have aged out of the window.
      if (bucket.hits.length && bucket.hits[0]! <= cutoff) {
        bucket.hits = bucket.hits.filter((t) => t > cutoff);
      }
      if (bucket.hits.length >= limit) {
        const oldest = bucket.hits[0]!;
        return { ok: false, retryAfterMs: Math.max(0, oldest + windowMs - now) };
      }
      bucket.hits.push(now);
      return { ok: true, retryAfterMs: 0 };
    },
  };
}
