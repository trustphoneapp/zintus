// BUSL-1.1 License — Business Source License 1.1
// Additional Use Grant: free for personal, non-commercial use until 2028-01-01
// See LICENSE file for full terms.
import type { CompressContext } from "../pipeline/types.js";

export type AggressivenessLevel = 1 | 2 | 3 | 4;

export interface QuotaSignals {
  /** 0.0–1.0 ratio remaining from provider rate-limit headers */
  remainingRequests?: number;
  remainingTokens?: number;
  /** User-configured budget signal (0.0–1.0) */
  budgetRemaining?: number;
  /** From Zintus router ledger */
  routerRemaining?: number;
}

export interface QuotaControllerOptions {
  dailyBudgetUsd?: number;
  tokenBudgetPerRequest?: number;
}

/**
 * Reads quota signals from provider headers, Zintus router ledger, or user
 * config and produces a 0.0–1.0 quotaRemaining value for CompressContext.
 *
 * Aggressiveness levels:
 *   > 0.5   → Level 1: CacheAligner only
 *   0.3–0.5 → Level 2: + JSON / log / diff compression
 *   0.15–0.3→ Level 3: + code compression + CCR for history
 *   < 0.15  → Level 4: + prose compression + aggressive CCR
 */
export class QuotaController {
  private lastRateLimitHeaders: Record<string, string> = {};

  constructor(_opts: QuotaControllerOptions = {}) {}

  /** Record rate-limit headers from a provider response. */
  recordResponseHeaders(headers: Record<string, string | null>): void {
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (v !== null && (lk.startsWith("x-ratelimit") || lk.startsWith("anthropic-ratelimit"))) {
        this.lastRateLimitHeaders[lk] = v;
      }
    }
  }

  /** Compute quotaRemaining (0.0–1.0) from all available signals. */
  getQuotaRemaining(signals: QuotaSignals = {}): number {
    const candidates: number[] = [];

    // Parse from cached rate-limit headers (support both OpenAI and Anthropic formats)
    const remaining =
      this.lastRateLimitHeaders["anthropic-ratelimit-requests-remaining"] ??
      this.lastRateLimitHeaders["x-ratelimit-remaining-requests"];
    const limit =
      this.lastRateLimitHeaders["anthropic-ratelimit-requests-limit"] ??
      this.lastRateLimitHeaders["x-ratelimit-limit-requests"];
    if (remaining !== undefined && limit !== undefined) {
      const r = parseInt(remaining);
      const l = parseInt(limit);
      if (!isNaN(r) && !isNaN(l) && l > 0) candidates.push(r / l);
    }

    const remainingTok =
      this.lastRateLimitHeaders["anthropic-ratelimit-tokens-remaining"] ??
      this.lastRateLimitHeaders["x-ratelimit-remaining-tokens"];
    const limitTok =
      this.lastRateLimitHeaders["anthropic-ratelimit-tokens-limit"] ??
      this.lastRateLimitHeaders["x-ratelimit-limit-tokens"];
    if (remainingTok !== undefined && limitTok !== undefined) {
      const r = parseInt(remainingTok);
      const l = parseInt(limitTok);
      if (!isNaN(r) && !isNaN(l) && l > 0) candidates.push(r / l);
    }

    // Signals passed in directly
    if (signals.remainingRequests !== undefined) candidates.push(signals.remainingRequests);
    if (signals.remainingTokens !== undefined) candidates.push(signals.remainingTokens);
    if (signals.budgetRemaining !== undefined) candidates.push(signals.budgetRemaining);
    if (signals.routerRemaining !== undefined) candidates.push(signals.routerRemaining);

    if (candidates.length === 0) return 1.0; // No quota info → assume full
    return Math.min(...candidates);
  }

  /** Determine aggressiveness level based on quotaRemaining. */
  static getLevel(quotaRemaining: number): AggressivenessLevel {
    if (quotaRemaining > 0.5) return 1;
    if (quotaRemaining > 0.3) return 2;
    if (quotaRemaining > 0.15) return 3;
    return 4;
  }

  /** Build a CompressContext enriched with quota signals. */
  enrichContext(
    base: Omit<CompressContext, "quotaRemaining">,
    signals?: QuotaSignals,
  ): CompressContext {
    return {
      ...base,
      quotaRemaining: this.getQuotaRemaining(signals ?? {}),
    };
  }
}
