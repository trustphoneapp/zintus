import * as SQLite from "expo-sqlite";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_IDS } from "@zintus/types";
import { parseGroqResetHeader } from "@zintus/router/groq-reset";
import {
  applyUsage,
  cooldownUntil,
  isQuotaAvailable as coreIsQuotaAvailable,
  remainingRatio as coreRemainingRatio,
  resetPatch,
} from "@zintus/router/quota-core";
import { PROVIDER_LIMITS, type ProviderQuotaRow } from "./limits";

const DB_NAME = "zintus-quota.db";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME).then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;

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
      return db;
    });
  }

  return dbPromise;
}

async function getProvider(
  db: SQLite.SQLiteDatabase,
  id: ProviderId,
): Promise<ProviderQuotaRow | null> {
  const row = await db.getFirstAsync<{
    id: string;
    requests_today: number;
    tokens_today: number;
    last_reset: number | null;
    cooldown_until: number | null;
  }>("SELECT * FROM providers WHERE id = ?", id);

  if (!row) {
    return null;
  }

  return {
    id: row.id as ProviderId,
    requestsToday: row.requests_today,
    tokensToday: row.tokens_today,
    lastReset: row.last_reset,
    cooldownUntil: row.cooldown_until,
  };
}

async function ensureProvider(
  db: SQLite.SQLiteDatabase,
  id: ProviderId,
): Promise<ProviderQuotaRow> {
  const existing = await getProvider(db, id);
  if (existing) {
    return existing;
  }

  await db.runAsync("INSERT INTO providers (id) VALUES (?)", id);
  return (await getProvider(db, id))!;
}

// All quota *decisions* come from @zintus/router/quota-core; this file only
// owns the expo-sqlite persistence adapter.
async function maybeResetDailyCounters(
  db: SQLite.SQLiteDatabase,
  id: ProviderId,
  now = Date.now(),
): Promise<ProviderQuotaRow> {
  const row = await ensureProvider(db, id);
  const patch = resetPatch(row, PROVIDER_LIMITS[id], now);
  if (!patch) {
    return row;
  }
  await db.runAsync(
    `UPDATE providers
     SET requests_today = ?, tokens_today = ?, last_reset = ?, cooldown_until = ?
     WHERE id = ?`,
    patch.requestsToday ?? row.requestsToday,
    patch.tokensToday ?? row.tokensToday,
    patch.lastReset !== undefined ? patch.lastReset : row.lastReset,
    patch.cooldownUntil !== undefined ? patch.cooldownUntil : row.cooldownUntil,
    id,
  );
  return (await getProvider(db, id))!;
}

export async function remainingRatio(
  id: ProviderId,
  now = Date.now(),
): Promise<number> {
  const db = await getDb();
  const row = await maybeResetDailyCounters(db, id, now);
  return coreRemainingRatio(row, PROVIDER_LIMITS[id]);
}

export async function isQuotaAvailable(
  id: ProviderId,
  now = Date.now(),
): Promise<boolean> {
  const db = await getDb();
  const row = await maybeResetDailyCounters(db, id, now);
  return coreIsQuotaAvailable(row, PROVIDER_LIMITS[id], now);
}

export async function recordUsage(
  id: ProviderId,
  input: {
    tokensIn?: number;
    tokensOut?: number;
    status: string;
    errorCode?: number;
  },
  now = Date.now(),
): Promise<void> {
  const db = await getDb();
  const row = await maybeResetDailyCounters(db, id, now);
  const tokensIn = input.tokensIn ?? 0;
  const tokensOut = input.tokensOut ?? 0;
  const next = applyUsage(row, tokensIn, tokensOut);

  await db.runAsync(
    `UPDATE providers
     SET requests_today = ?, tokens_today = ?
     WHERE id = ?`,
    next.requestsToday,
    next.tokensToday,
    id,
  );

  await db.runAsync(
    `INSERT INTO usage_log
      (provider_id, timestamp, requests, tokens_in, tokens_out, status, error_code)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
    id,
    now,
    tokensIn,
    tokensOut,
    input.status,
    input.errorCode ?? null,
  );
}

export async function setCooldown(
  id: ProviderId,
  retries: number,
  now = Date.now(),
): Promise<void> {
  const db = await getDb();
  await ensureProvider(db, id);
  await db.runAsync(
    "UPDATE providers SET cooldown_until = ? WHERE id = ?",
    cooldownUntil(retries, now),
    id,
  );
}

export async function clearCooldown(id: ProviderId): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE providers SET cooldown_until = NULL WHERE id = ?",
    id,
  );
}

export async function applyGroqRollingReset(
  id: ProviderId,
  resetHeader: string,
  now = Date.now(),
): Promise<void> {
  const resetAt = parseGroqResetHeader(resetHeader, now);

  const db = await getDb();
  await db.runAsync(
    `UPDATE providers
     SET requests_today = 0, tokens_today = 0, last_reset = ?, cooldown_until = ?
     WHERE id = ?`,
    resetAt,
    resetAt,
    id,
  );
}

export async function getQuotaSnapshot(
  id: ProviderId,
  now = Date.now(),
): Promise<{
  requestsUsed: number;
  tokensUsed: number;
  inCooldown: boolean;
  limits: (typeof PROVIDER_LIMITS)[ProviderId];
}> {
  const db = await getDb();
  const row = await maybeResetDailyCounters(db, id, now);
  return {
    requestsUsed: row.requestsToday,
    tokensUsed: row.tokensToday,
    inCooldown: row.cooldownUntil != null && row.cooldownUntil > now,
    limits: PROVIDER_LIMITS[id],
  };
}

/**
 * Which quota source the usage UI should trust. The phone routes ONLY through
 * the gateway, so its local expo-sqlite ledger is never updated by real traffic
 * — when the gateway is reachable its `/health` is authoritative; when it is
 * not, quota is genuinely unknown and must NOT be shown as authoritative zeros.
 */
export function resolveQuotaSource(
  gatewayOnline: boolean,
): "gateway" | "unknown" {
  return gatewayOnline ? "gateway" : "unknown";
}

export async function getAllQuotaSnapshots(
  now = Date.now(),
): Promise<
  Array<{
    providerId: ProviderId;
    requestsUsed: number;
    tokensUsed: number;
    inCooldown: boolean;
    limits: (typeof PROVIDER_LIMITS)[ProviderId];
  }>
> {
  return Promise.all(
    PROVIDER_IDS.map(async (providerId) => {
      const snapshot = await getQuotaSnapshot(providerId, now);
      return { providerId, ...snapshot };
    }),
  );
}
