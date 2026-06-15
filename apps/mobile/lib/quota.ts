import * as SQLite from "expo-sqlite";
import type { ProviderId } from "@multipleai/types";
import { PROVIDER_IDS } from "@multipleai/types";
import { PROVIDER_LIMITS, type ProviderQuotaRow } from "./limits";

const DB_NAME = "multipleai-quota.db";

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

function startOfUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

async function maybeResetDailyCounters(
  db: SQLite.SQLiteDatabase,
  id: ProviderId,
  now = Date.now(),
): Promise<ProviderQuotaRow> {
  const limits = PROVIDER_LIMITS[id];
  const row = await ensureProvider(db, id);

  if (limits.rollingWindow) {
    if (row.lastReset != null && now >= row.lastReset) {
      await db.runAsync(
        `UPDATE providers
         SET requests_today = 0, tokens_today = 0, last_reset = NULL, cooldown_until = NULL
         WHERE id = ?`,
        id,
      );
      return (await getProvider(db, id))!;
    }
    return row;
  }

  const dayStart = startOfUtcDay(now);
  if (row.lastReset == null || row.lastReset < dayStart) {
    await db.runAsync(
      `UPDATE providers
       SET requests_today = 0, tokens_today = 0, last_reset = ?
       WHERE id = ?`,
      dayStart,
      id,
    );
    return (await getProvider(db, id))!;
  }

  return row;
}

export async function remainingRatio(
  id: ProviderId,
  now = Date.now(),
): Promise<number> {
  const db = await getDb();
  const limits = PROVIDER_LIMITS[id];
  const row = await maybeResetDailyCounters(db, id, now);

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

export async function isQuotaAvailable(
  id: ProviderId,
  now = Date.now(),
): Promise<boolean> {
  const db = await getDb();
  const limits = PROVIDER_LIMITS[id];
  const row = await maybeResetDailyCounters(db, id, now);

  if (row.cooldownUntil != null && row.cooldownUntil > now) {
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

  await db.runAsync(
    `UPDATE providers
     SET requests_today = ?, tokens_today = ?
     WHERE id = ?`,
    row.requestsToday + 1,
    row.tokensToday + tokensIn + tokensOut,
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
  const base = 30_000 * 2 ** Math.max(retries, 0);
  const until = now + Math.min(base, 1_800_000);
  await db.runAsync(
    "UPDATE providers SET cooldown_until = ? WHERE id = ?",
    until,
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
  const trimmed = resetHeader.trim().toLowerCase();
  let resetAt = now + 60_000;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
  if (match) {
    const amount = Number.parseFloat(match[1]!);
    const unit = match[2] ?? "s";
    switch (unit) {
      case "ms":
        resetAt = now + amount;
        break;
      case "m":
        resetAt = now + amount * 60_000;
        break;
      case "h":
        resetAt = now + amount * 3_600_000;
        break;
      default:
        resetAt = now + amount * 1_000;
    }
  }

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
