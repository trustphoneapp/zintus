/**
 * Ephemeral, origin-bound loopback handshake authority.
 *
 * PROBLEM this replaces: a tokenless ("loopback") gateway previously trusted any
 * request whose `Origin` was on a *static* allowlist (localhost / the desktop
 * webview / the official web app). That made a permanent, unauthenticated origin
 * grant — a compromised trusted origin (e.g. a hijacked www.zintus.ai) could
 * silently drive the user's local gateway, burning their BYOK quota and reading
 * their AI responses, purely because its `Origin` header was on the list.
 *
 * MECHANISM (why it is enterprise-safe): trust is no longer derived from a
 * spoofable/static identity. On boot the gateway holds a per-process *bootstrap
 * secret* that is only obtainable by a process with LOCAL machine access (the
 * desktop shell that spawns the sidecar injects it via env, and it is also
 * written to a 0600 session file). To operate a tokenless gateway a browser
 * origin must complete a challenge–response handshake:
 *
 *   1. GET  /v1/handshake            → server issues a single-use, short-TTL
 *                                      challenge nonce (no secret revealed).
 *   2. POST /v1/handshake {challenge, proof}
 *        proof = HMAC-SHA256(bootstrapSecret, challenge), hex
 *      → server verifies the proof (knowledge of the secret, secret never on the
 *        wire), burns the nonce (SINGLE-USE), and mints an ORIGIN-BOUND session
 *        token with a bounded lifetime.
 *   3. Subsequent requests present `Authorization: Bearer <sessionToken>`; the
 *        gateway accepts only a token that is known, unexpired, AND bound to the
 *        exact request Origin.
 *
 * A compromised remote origin can fetch a challenge but cannot compute a valid
 * proof (it lacks the bootstrap secret), so it cannot mint a session and cannot
 * operate the gateway. Replaying a captured handshake POST fails because the
 * nonce is burned on first use. A stolen session token is useless from a
 * different origin (origin-bound) and after its TTL (expiry).
 *
 * This module is deliberately transport-free so it can be unit-tested directly.
 */
import { createHmac, randomBytes } from "node:crypto";
import { timingSafeEqual } from "./auth.js";

export interface LoopbackSession {
  /** The exact browser Origin this session token is bound to. */
  origin: string;
  /** Epoch-ms after which the session token is no longer valid. */
  expiresAt: number;
}

export interface LoopbackAuthorityOptions {
  /**
   * Per-process bootstrap secret. Only a LOCAL process can read it (env-injected
   * by the desktop shell, or the 0600 session file). An empty secret disables
   * the authority (handshake always fails) — the handler then treats it as
   * "no authority wired".
   */
  bootstrapSecret: string;
  /** How long an unredeemed challenge nonce stays valid (default 30s). */
  challengeTtlMs?: number;
  /** How long a minted session token stays valid (default 12h). */
  sessionTtlMs?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_CHALLENGE_TTL_MS = 30_000;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class LoopbackAuthority {
  private readonly bootstrapSecret: string;
  private readonly challengeTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly clock: () => number;
  /** Unredeemed challenge nonces → their expiry (epoch-ms). Single-use. */
  private readonly challenges = new Map<string, number>();
  /** Live session tokens → their binding. */
  private readonly sessions = new Map<string, LoopbackSession>();

  constructor(options: LoopbackAuthorityOptions) {
    this.bootstrapSecret = options.bootstrapSecret ?? "";
    this.challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.clock = options.now ?? Date.now;
  }

  /** True only when a non-empty bootstrap secret is configured. */
  hasBootstrapSecret(): boolean {
    return this.bootstrapSecret.length > 0;
  }

  /**
   * The proof a client must present for a given challenge: an HMAC over the
   * challenge keyed by the bootstrap secret. The raw secret never travels on the
   * wire, and the proof is bound to that specific single-use challenge.
   */
  proofFor(challenge: string): string {
    return createHmac("sha256", this.bootstrapSecret)
      .update(challenge)
      .digest("hex");
  }

  /** Step 1 — issue a fresh single-use challenge nonce. */
  issueChallenge(now = this.clock()): { challenge: string; expiresAt: number } {
    this.prune(now);
    const challenge = randomBytes(32).toString("hex");
    const expiresAt = now + this.challengeTtlMs;
    this.challenges.set(challenge, expiresAt);
    return { challenge, expiresAt };
  }

  /**
   * Step 2 — redeem a challenge + proof for an origin-bound session token.
   * Returns null on any failure (unknown/replayed/expired challenge, missing
   * origin, wrong proof, or no bootstrap secret). The challenge is burned on ANY
   * redeem attempt that references it, so a wrong proof cannot be retried and a
   * captured POST cannot be replayed.
   */
  redeem(
    input: { challenge: string; proof: string; origin: string | null },
    now = this.clock(),
  ): { token: string; expiresAt: number } | null {
    if (!this.hasBootstrapSecret()) {
      return null;
    }
    const { challenge, proof, origin } = input;
    // A missing/empty challenge would collide in the map on the empty string.
    if (!challenge) {
      return null;
    }
    const challengeExpiry = this.challenges.get(challenge);
    // Unknown or already-consumed (replayed) challenge.
    if (challengeExpiry === undefined) {
      return null;
    }
    // SINGLE-USE: consume the nonce now, regardless of the outcome below, so a
    // failed proof cannot be brute-forced against the same challenge and a
    // captured POST cannot be replayed.
    this.challenges.delete(challenge);
    if (now >= challengeExpiry) {
      return null;
    }
    if (!origin) {
      return null;
    }
    const expected = this.proofFor(challenge);
    if (!timingSafeEqual(proof, expected)) {
      return null;
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = now + this.sessionTtlMs;
    this.sessions.set(token, { origin, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Per-request check: is this bearer token a live session bound to this exact
   * origin? Rejects a missing/unknown token, an expired token, and a token
   * presented from a different origin than it was minted for.
   */
  verify(
    token: string | null,
    origin: string | null,
    now = this.clock(),
  ): boolean {
    if (!token || !origin) {
      return false;
    }
    const session = this.sessions.get(token);
    if (!session) {
      return false;
    }
    if (now >= session.expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    // Origin-bound: constant-time compare so a token minted for origin A cannot
    // be replayed from origin B.
    return timingSafeEqual(session.origin, origin);
  }

  /** Drop expired challenges and sessions. Cheap; called opportunistically. */
  prune(now = this.clock()): void {
    for (const [challenge, expiresAt] of this.challenges) {
      if (now >= expiresAt) {
        this.challenges.delete(challenge);
      }
    }
    for (const [token, session] of this.sessions) {
      if (now >= session.expiresAt) {
        this.sessions.delete(token);
      }
    }
  }
}

/**
 * Extract a bearer credential from an Authorization header, or null. Shared by
 * the handshake verifier so the session token is presented the same way as a
 * configured GATEWAY_TOKEN.
 */
export function bearerCredential(
  authorizationHeader: string | null,
): string | null {
  const prefix = "Bearer ";
  if (!authorizationHeader || !authorizationHeader.startsWith(prefix)) {
    return null;
  }
  const value = authorizationHeader.slice(prefix.length);
  return value.length > 0 ? value : null;
}
