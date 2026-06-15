import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
/// <reference types="bun-types" />
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { ProviderId } from "@multipleai/types";
import { computeCooldownMs, isInCooldown } from "./cooldown.js";
import { parseGroqResetHeader } from "./groq-reset.js";
import { PROVIDER_LIMITS, type ProviderLimits } from "./limits.js";
import { providers, usageLog } from "./schema.js";

export interface ProviderRow {
  id: ProviderId;
  requestsToday: number;
  tokensToday: number;
  lastReset: number | null;
  cooldownUntil: number | null;
}

export class QuotaLedger {
  private readonly db: ReturnType<typeof drizzle>;
  private readonly sqlite: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.db = drizzle(this.sqlite);
    this.initSchema();
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
        timestamp INTEGER NOT NULL,
        requests INTEGER NOT NULL DEFAULT 1,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_code INTEGER
      );
    `);
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
    const limits = PROVIDER_LIMITS[id];
    const row = this.ensureProvider(id);

    if (limits.rollingWindow) {
      if (row.lastReset != null && now >= row.lastReset) {
        this.db
          .update(providers)
          .set({
            requestsToday: 0,
            tokensToday: 0,
            lastReset: null,
            cooldownUntil: null,
          })
          .where(eq(providers.id, id))
          .run();
        return this.getProvider(id)!;
      }
      return row;
    }

    const startOfUtcDay = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );

    if (row.lastReset == null || row.lastReset < startOfUtcDay) {
      this.db
        .update(providers)
        .set({
          requestsToday: 0,
          tokensToday: 0,
          lastReset: startOfUtcDay,
        })
        .where(eq(providers.id, id))
        .run();
      return this.getProvider(id)!;
    }

    return row;
  }

  isQuotaAvailable(id: ProviderId, now = Date.now()): boolean {
    const limits = PROVIDER_LIMITS[id];
    const row = this.maybeResetDailyCounters(id, now);

    if (isInCooldown(row.cooldownUntil, now)) {
      return false;
    }

    if (limits.rollingWindow && row.lastReset != null && row.lastReset > now) {
      return false;
    }

    if (
      limits.requestsPerDay != null &&
      row.requestsToday >= limits.requestsPerDay
    ) {
      return false;
    }

    if (limits.tokensPerDay != null && row.tokensToday >= limits.tokensPerDay) {
      return false;
    }

    return true;
  }

  remainingRatio(id: ProviderId, now = Date.now()): number {
    const limits = PROVIDER_LIMITS[id];
    const row = this.maybeResetDailyCounters(id, now);

    const requestRatio =
      limits.requestsPerDay != null
        ? 1 - row.requestsToday / limits.requestsPerDay
        : 1;
    const tokenRatio =
      limits.tokensPerDay != null
        ? 1 - row.tokensToday / limits.tokensPerDay
        : 1;

    return Math.min(requestRatio, tokenRatio);
  }

  setCooldown(id: ProviderId, retries: number, now = Date.now()): void {
    const until = now + computeCooldownMs(retries);
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
    },
    now = Date.now(),
  ): void {
    const row = this.maybeResetDailyCounters(id, now);
    const tokensIn = input.tokensIn ?? 0;
    const tokensOut = input.tokensOut ?? 0;

    this.db
      .update(providers)
      .set({
        requestsToday: row.requestsToday + 1,
        tokensToday: row.tokensToday + tokensIn + tokensOut,
      })
      .where(eq(providers.id, id))
      .run();

    this.db
      .insert(usageLog)
      .values({
        providerId: id,
        timestamp: now,
        requests: 1,
        tokensIn,
        tokensOut,
        status: input.status,
        errorCode: input.errorCode ?? null,
      })
      .run();
  }

  getLimits(id: ProviderId): ProviderLimits {
    return PROVIDER_LIMITS[id];
  }

  close(): void {
    this.sqlite.close();
  }
}
