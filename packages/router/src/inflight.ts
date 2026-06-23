import type { ProviderLimits } from "./limits.js";

/**
 * In-flight reservation tracking — the fix for the concurrent-overshoot race
 * (the LiteLLM #18730 pattern).
 *
 * The persistent ledger only records usage AFTER a response drains, so between
 * the pre-dispatch `isQuotaAvailable` check and `recordUsage`, N concurrent
 * requests all see the same "completed" counters and all dispatch — blowing the
 * cap. This tracker holds a count of requests/tokens that are dispatched but not
 * yet recorded, so a burst is gated against (completed + in-flight).
 *
 * It needs NO mutex: `tryReserve` is fully synchronous with no `await` inside,
 * and JavaScript runs one event-loop turn to completion atomically. Two
 * concurrent callers therefore cannot both observe the same pre-reservation
 * state — the read-decide-increment runs as one indivisible step. (A mutex would
 * only matter if the critical section awaited between the check and the write.)
 */
export interface InFlightCounts {
  requests: number;
  tokens: number;
}

/** Already-committed (persisted) usage the reservation must be added on top of. */
export interface CommittedUsage {
  /** Requests counted in the current daily window. */
  dailyRequests: number;
  /** Tokens counted in the current daily window. */
  dailyTokens: number;
  /** Requests in the rolling 60s window. */
  minuteRequests: number;
  /** Tokens in the rolling 60s window. */
  minuteTokens: number;
}

export class InFlightReservations {
  private readonly map = new Map<string, InFlightCounts>();

  /** Current in-flight counts for a provider (zeroes when none). */
  current(id: string): InFlightCounts {
    return this.map.get(id) ?? { requests: 0, tokens: 0 };
  }

  /**
   * Atomically admit-or-reject one request and, on admit, reserve its estimated
   * tokens. Returns true when admitted. Synchronous by design — see class doc.
   *
   * Admission rule: after adding this request (+1 request, +estTokens), the
   * combined `committed + in-flight` must not EXCEED any configured limit.
   */
  tryReserve(
    id: string,
    estTokens: number,
    committed: CommittedUsage,
    limits: ProviderLimits,
  ): boolean {
    const cur = this.current(id);
    const reqMinute = committed.minuteRequests + cur.requests + 1;
    const tokMinute = committed.minuteTokens + cur.tokens + estTokens;
    const reqDay = committed.dailyRequests + cur.requests + 1;
    const tokDay = committed.dailyTokens + cur.tokens + estTokens;

    if (limits.requestsPerMinute != null && reqMinute > limits.requestsPerMinute) {
      return false;
    }
    if (limits.tokensPerMinute != null && tokMinute > limits.tokensPerMinute) {
      return false;
    }
    if (limits.requestsPerDay != null && reqDay > limits.requestsPerDay) {
      return false;
    }
    if (limits.tokensPerDay != null && tokDay > limits.tokensPerDay) {
      return false;
    }

    this.map.set(id, {
      requests: cur.requests + 1,
      tokens: cur.tokens + estTokens,
    });
    return true;
  }

  /**
   * Release a previously-reserved request. Call exactly once per successful
   * `tryReserve`, on every terminal path (success, failover, error, abort).
   * Idempotent-safe: never goes negative.
   */
  release(id: string, estTokens: number): void {
    const cur = this.map.get(id);
    if (!cur) return;
    const requests = Math.max(0, cur.requests - 1);
    const tokens = Math.max(0, cur.tokens - estTokens);
    if (requests === 0 && tokens === 0) {
      this.map.delete(id);
    } else {
      this.map.set(id, { requests, tokens });
    }
  }
}
