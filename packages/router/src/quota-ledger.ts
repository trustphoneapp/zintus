import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
/// <reference types="bun-types" />
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { PolicyLimits, ProviderId } from "@zintus/types";
import { parseGroqResetHeader } from "./groq-reset.js";
import {
  paidEquivalentUsdPerMTok,
  resolveLimits,
  type ProviderLimits,
} from "./limits.js";
import {
  applyUsage,
  cooldownUntil as computeCooldownUntil,
  isQuotaAvailable as coreIsQuotaAvailable,
  remainingRatio as coreRemainingRatio,
  resetPatch,
  startOfUtcDay,
  type QuotaRow,
} from "./quota-core.js";
import { providers, usageLog, virtualKeys, vkUsage } from "./schema.js";

export interface ProviderRow extends QuotaRow {
  id: ProviderId;
}

const ROLLING_WINDOW_MS = 60_000;

export class QuotaLedger {
  private readonly db: ReturnType<typeof drizzle>;
  private readonly sqlite: Database;
  private readonly limits: Record<ProviderId, ProviderLimits>;

  constructor(
    dbPath: string,
    limitOverrides?: Partial<Record<ProviderId, PolicyLimits>>,
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.db = drizzle(this.sqlite);
    this.limits = resolveLimits(limitOverrides);
    this.initSchema();
  }

  /** Replace the live quota limits (e.g. after a policy.json hot-reload). */
  setLimits(limitOverrides?: Partial<Record<ProviderId, PolicyLimits>>): void {
    Object.assign(this.limits, resolveLimits(limitOverrides));
  }

  private initSchema(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        requests_today INTEGER NOT NULL DEFAULT 0,
        tokens_today INTEGER NOT NULL DEFAULT 0,
        last_reset INTEGER,
        cooldown_until INTEGER
      );

      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        model TEXT,
        timestamp INTEGER NOT NULL,
        requests INTEGER NOT NULL DEFAULT 1,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_code INTEGER,
        latency_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_usage_provider_ts
        ON usage_log (provider_id, timestamp);

      CREATE TABLE IF NOT EXISTS virtual_keys (
        id TEXT PRIMARY KEY,
        name TEXT,
        requests_today INTEGER NOT NULL DEFAULT 0,
        tokens_today INTEGER NOT NULL DEFAULT 0,
        last_reset INTEGER,
        requests_limit INTEGER,
        tokens_limit INTEGER,
        requests_per_minute INTEGER,
        tokens_per_minute INTEGER
      );

      CREATE TABLE IF NOT EXISTS vk_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vk_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_vk_usage_id_ts
        ON vk_usage (vk_id, timestamp);
    `);

    // Migrate pre-existing databases that lack newer columns.
    for (const ddl of [
      `ALTER TABLE usage_log ADD COLUMN latency_ms INTEGER`,
      `ALTER TABLE usage_log ADD COLUMN model TEXT`,
      `ALTER TABLE virtual_keys ADD COLUMN requests_per_minute INTEGER`,
      `ALTER TABLE virtual_keys ADD COLUMN tokens_per_minute INTEGER`,
    ]) {
      try {
        this.sqlite.exec(ddl);
      } catch {
        // Column already exists — nothing to do.
      }
    }
  }

  ensureProvider(id: ProviderId): ProviderRow {
    const existing = this.getProvider(id);
    if (existing) {
      return existing;
    }

    this.db.insert(providers).values({ id }).run();
    return this.getProvider(id)!;
  }

  getProvider(id: ProviderId): ProviderRow | null {
    const row = this.db.select().from(providers).where(eq(providers.id, id)).get();
    if (!row) {
      return null;
    }

    return {
      id: row.id as ProviderId,
      requestsToday: row.requestsToday,
      tokensToday: row.tokensToday,
      lastReset: row.lastReset,
      cooldownUntil: row.cooldownUntil,
    };
  }

  maybeResetDailyCounters(id: ProviderId, now = Date.now()): ProviderRow {
    const limits = this.limits[id];
    const row = this.ensureProvider(id);
    const patch = resetPatch(row, limits, now);
    if (!patch) {
      return row;
    }
    this.db.update(providers).set(patch).where(eq(providers.id, id)).run();
    return this.getProvider(id)!;
  }

  isQuotaAvailable(id: ProviderId, now = Date.now()): boolean {
    const limits = this.limits[id];
    const row = this.maybeResetDailyCounters(id, now);
    if (!coreIsQuotaAvailable(row, limits, now)) {
      return false;
    }
    // Rolling 60s windows (TPM/RPM): many free tiers are per-minute bound, so a
    // burst can blow an RPM limit long before the daily counter notices.
    if (limits.requestsPerMinute != null || limits.tokensPerMinute != null) {
      const recent = this.countRecentUsage(id, ROLLING_WINDOW_MS, now);
      if (
        limits.requestsPerMinute != null &&
        recent.requests >= limits.requestsPerMinute
      ) {
        return false;
      }
      if (
        limits.tokensPerMinute != null &&
        recent.tokens >= limits.tokensPerMinute
      ) {
        return false;
      }
    }
    return true;
  }

  remainingRatio(id: ProviderId, now = Date.now()): number {
    const limits = this.limits[id];
    const row = this.maybeResetDailyCounters(id, now);
    return coreRemainingRatio(row, limits);
  }

  /** Request count and token sum recorded for a provider in the last `windowMs`. */
  countRecentUsage(
    id: ProviderId,
    windowMs: number,
    now = Date.now(),
  ): { requests: number; tokens: number } {
    const since = now - windowMs;
    const row = this.sqlite
      .query(
        `SELECT COALESCE(SUM(requests), 0) AS requests,
                COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens
         FROM usage_log
         WHERE provider_id = ? AND timestamp >= ?`,
      )
      .get(id, since) as { requests: number; tokens: number };
    return { requests: row.requests, tokens: row.tokens };
  }

  /**
   * p95 latency (ms) over the provider's recent successful requests, or null
   * when there are fewer than `minSamples`. Drives the latency-based `fastest`
   * strategy.
   */
  recentLatencyP95(
    id: ProviderId,
    opts: { windowMs?: number; minSamples?: number } = {},
    now = Date.now(),
  ): number | null {
    const windowMs = opts.windowMs ?? 10 * 60_000;
    const minSamples = opts.minSamples ?? 3;
    const since = now - windowMs;
    const rows = this.sqlite
      .query(
        `SELECT latency_ms FROM usage_log
         WHERE provider_id = ? AND status = 'success'
           AND latency_ms IS NOT NULL AND timestamp >= ?
         ORDER BY latency_ms ASC`,
      )
      .all(id, since) as Array<{ latency_ms: number }>;
    if (rows.length < minSamples) {
      return null;
    }
    const idx = Math.max(
      0,
      Math.min(rows.length - 1, Math.ceil(0.95 * rows.length) - 1),
    );
    return rows[idx]?.latency_ms ?? null;
  }

  /**
   * Count of error/rate-limited attempts in the last `windowMs`. Used for
   * health-aware routing: a provider with a recent error streak is skipped even
   * if it never tripped a formal cooldown.
   */
  recentErrorCount(
    id: ProviderId,
    windowMs: number,
    now = Date.now(),
  ): number {
    const since = now - windowMs;
    const row = this.sqlite
      .query(
        `SELECT COUNT(*) AS n FROM usage_log
         WHERE provider_id = ? AND timestamp >= ?
           AND status IN ('error', 'rate_limited')`,
      )
      .get(id, since) as { n: number };
    return row.n;
  }

  /**
   * Estimated USD saved by serving free-tier tokens that a paid API would have
   * billed. Returns per-provider and total. This is an estimate (see
   * PAID_EQUIVALENT_USD_PER_MTOK), labelled as such in the UI.
   */
  savingsUsd(): { byProvider: Record<string, number>; total: number } {
    // Group by (provider, model) so each model is valued at its own paid
    // equivalent — Groq 8B is far cheaper than 70B, several OpenRouter :free
    // models are smaller than the provider anchor assumes. Rows logged before
    // the model column existed have NULL model and fall back to the provider
    // anchor via paidEquivalentUsdPerMTok.
    const rows = this.sqlite
      .query(
        `SELECT provider_id, model, COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens
         FROM usage_log WHERE status = 'success'
         GROUP BY provider_id, model`,
      )
      .all() as Array<{ provider_id: string; model: string | null; tokens: number }>;
    const byProvider: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const price = paidEquivalentUsdPerMTok(
        row.provider_id as ProviderId,
        row.model ?? undefined,
      );
      const usd = (row.tokens / 1_000_000) * price;
      byProvider[row.provider_id] = (byProvider[row.provider_id] ?? 0) + usd;
      total += usd;
    }
    return { byProvider, total };
  }

  setCooldown(id: ProviderId, retries: number, now = Date.now()): void {
    const until = computeCooldownUntil(retries, now);
    this.ensureProvider(id);
    this.db
      .update(providers)
      .set({ cooldownUntil: until })
      .where(eq(providers.id, id))
      .run();
  }

  clearCooldown(id: ProviderId): void {
    this.db
      .update(providers)
      .set({ cooldownUntil: null })
      .where(eq(providers.id, id))
      .run();
  }

  applyGroqRollingReset(
    id: ProviderId,
    resetHeader: string,
    now = Date.now(),
  ): void {
    const resetAt = parseGroqResetHeader(resetHeader, now);
    this.ensureProvider(id);
    this.db
      .update(providers)
      .set({
        lastReset: resetAt,
        cooldownUntil: resetAt,
      })
      .where(eq(providers.id, id))
      .run();
  }

  applyGroqRateLimitFromHeaders(
    id: ProviderId,
    remainingRequests: string | undefined,
    resetHeader: string | undefined,
    now = Date.now(),
  ): void {
    if (!resetHeader) {
      return;
    }

    const resetAt = parseGroqResetHeader(resetHeader, now);
    this.ensureProvider(id);
    this.db.update(providers).set({ lastReset: resetAt }).where(eq(providers.id, id)).run();

    if (remainingRequests === "0") {
      this.db
        .update(providers)
        .set({ cooldownUntil: resetAt })
        .where(eq(providers.id, id))
        .run();
    }
  }

  recordUsage(
    id: ProviderId,
    input: {
      tokensIn?: number;
      tokensOut?: number;
      status: string;
      errorCode?: number;
      latencyMs?: number;
      /** Model served, so savings can be valued per-model (not just provider). */
      model?: string;
    },
    now = Date.now(),
  ): void {
    const row = this.maybeResetDailyCounters(id, now);
    const tokensIn = input.tokensIn ?? 0;
    const tokensOut = input.tokensOut ?? 0;
    // Zero-cost failed requests (Phase 2.4): only successful runs debit the
    // daily token budget. Failed/rate-limited attempts are still logged (for
    // observability and RPM windows) but do not consume token quota.
    const billable = input.status === "success";

    if (billable) {
      this.db
        .update(providers)
        .set(applyUsage(row, tokensIn, tokensOut))
        .where(eq(providers.id, id))
        .run();
    } else {
      // Count the request against daily request budget without charging tokens.
      this.db
        .update(providers)
        .set({ requestsToday: row.requestsToday + 1 })
        .where(eq(providers.id, id))
        .run();
    }

    this.db
      .insert(usageLog)
      .values({
        providerId: id,
        model: input.model ?? null,
        timestamp: now,
        requests: 1,
        tokensIn: billable ? tokensIn : 0,
        tokensOut: billable ? tokensOut : 0,
        status: input.status,
        errorCode: input.errorCode ?? null,
        latencyMs: input.latencyMs ?? null,
      })
      .run();
  }

  getLimits(id: ProviderId): ProviderLimits {
    return this.limits[id];
  }

  createVirtualKey(
    id: string,
    name: string,
    requestsLimit?: number | null,
    tokensLimit?: number | null,
    limits?: { requestsPerMinute?: number | null; tokensPerMinute?: number | null },
  ): void {
    const existing = this.db
      .select()
      .from(virtualKeys)
      .where(eq(virtualKeys.id, id))
      .get();
    if (!existing) {
      this.db
        .insert(virtualKeys)
        .values({
          id,
          name,
          requestsLimit: requestsLimit ?? null,
          tokensLimit: tokensLimit ?? null,
          requestsPerMinute: limits?.requestsPerMinute ?? null,
          tokensPerMinute: limits?.tokensPerMinute ?? null,
          lastReset: Date.now(),
        })
        .run();
    }
  }

  /** Request count and token sum recorded for a virtual key in the last `windowMs`. */
  countRecentVkUsage(
    id: string,
    windowMs: number,
    now = Date.now(),
  ): { requests: number; tokens: number } {
    const since = now - windowMs;
    const row = this.sqlite
      .query(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(tokens), 0) AS tokens
         FROM vk_usage WHERE vk_id = ? AND timestamp >= ?`,
      )
      .get(id, since) as { requests: number; tokens: number };
    return { requests: row.requests, tokens: row.tokens };
  }

  getVirtualKey(id: string) {
    return this.db
      .select()
      .from(virtualKeys)
      .where(eq(virtualKeys.id, id))
      .get() ?? null;
  }

  validateVirtualKey(id: string, now = Date.now()): boolean {
    const keyRow = this.getVirtualKey(id);
    if (!keyRow) {
      return false;
    }

    const dayStart = startOfUtcDay(now);
    let requestsToday = keyRow.requestsToday;
    let tokensToday = keyRow.tokensToday;
    let lastReset = keyRow.lastReset;

    if (lastReset === null || lastReset < dayStart) {
      requestsToday = 0;
      tokensToday = 0;
      lastReset = dayStart;
      this.db
        .update(virtualKeys)
        .set({ requestsToday: 0, tokensToday: 0, lastReset: dayStart })
        .where(eq(virtualKeys.id, id))
        .run();
    }

    if (keyRow.requestsLimit !== null && requestsToday >= keyRow.requestsLimit) {
      return false;
    }
    if (keyRow.tokensLimit !== null && tokensToday >= keyRow.tokensLimit) {
      return false;
    }

    // Rolling 60s RPM/TPM windows (in addition to daily caps).
    if (
      keyRow.requestsPerMinute !== null ||
      keyRow.tokensPerMinute !== null
    ) {
      const recent = this.countRecentVkUsage(id, ROLLING_WINDOW_MS, now);
      if (
        keyRow.requestsPerMinute !== null &&
        recent.requests >= keyRow.requestsPerMinute
      ) {
        return false;
      }
      if (
        keyRow.tokensPerMinute !== null &&
        recent.tokens >= keyRow.tokensPerMinute
      ) {
        return false;
      }
    }

    return true;
  }

  recordVirtualKeyUsage(
    id: string,
    tokensIn: number,
    tokensOut: number,
    now = Date.now(),
  ): void {
    const keyRow = this.getVirtualKey(id);
    if (!keyRow) {
      return;
    }

    const dayStart = startOfUtcDay(now);
    let requestsToday = keyRow.requestsToday;
    let tokensToday = keyRow.tokensToday;
    let lastReset = keyRow.lastReset;

    if (lastReset === null || lastReset < dayStart) {
      requestsToday = 0;
      tokensToday = 0;
      lastReset = dayStart;
    }

    this.db
      .update(virtualKeys)
      .set({
        requestsToday: requestsToday + 1,
        tokensToday: tokensToday + tokensIn + tokensOut,
        lastReset,
      })
      .where(eq(virtualKeys.id, id))
      .run();

    // Timestamped event for the rolling 60s RPM/TPM windows.
    this.db
      .insert(vkUsage)
      .values({ vkId: id, timestamp: now, tokens: tokensIn + tokensOut })
      .run();
  }

  close(): void {
    this.sqlite.close();
  }
}
