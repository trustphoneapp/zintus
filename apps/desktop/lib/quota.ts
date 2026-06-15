import type { ProviderId } from "@multipleai/types";
import { PROVIDER_LIMITS } from "@multipleai/router/limits";
import { computeCooldownMs, isInCooldown } from "@multipleai/router/cooldown";
import { parseGroqResetHeader } from "@multipleai/router/groq-reset";
import { isTauri } from "./tauri";

export interface ProviderQuotaRow {
  id: ProviderId;
  requestsToday: number;
  tokensToday: number;
  lastReset: number | null;
  cooldownUntil: number | null;
}

const STORAGE_KEY = "multipleai.desktop.quota";

function startOfUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function loadLocalRows(): Record<string, ProviderQuotaRow> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ProviderQuotaRow>) : {};
  } catch {
    return {};
  }
}

function saveLocalRows(rows: Record<string, ProviderQuotaRow>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
}

async function invokeQuota<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

async function getRow(id: ProviderId): Promise<ProviderQuotaRow> {
  if (isTauri()) {
    const row = await invokeQuota<{
      id: string;
      requests_today: number;
      tokens_today: number;
      last_reset: number | null;
      cooldown_until: number | null;
    }>("quota_get_provider", { providerId: id });
    return {
      id: row.id as ProviderId,
      requestsToday: row.requests_today,
      tokensToday: row.tokens_today,
      lastReset: row.last_reset,
      cooldownUntil: row.cooldown_until,
    };
  }

  const rows = loadLocalRows();
  return (
    rows[id] ?? {
      id,
      requestsToday: 0,
      tokensToday: 0,
      lastReset: null,
      cooldownUntil: null,
    }
  );
}

async function setRow(row: ProviderQuotaRow): Promise<void> {
  if (isTauri()) {
    await invokeQuota("quota_update_provider", {
      providerId: row.id,
      requestsToday: row.requestsToday,
      tokensToday: row.tokensToday,
      lastReset: row.lastReset,
      cooldownUntil: row.cooldownUntil,
    });
    return;
  }

  const rows = loadLocalRows();
  rows[row.id] = row;
  saveLocalRows(rows);
}

export async function maybeResetDailyCounters(
  id: ProviderId,
  now = Date.now(),
): Promise<ProviderQuotaRow> {
  const limits = PROVIDER_LIMITS[id];
  const row = await getRow(id);

  if (limits.rollingWindow) {
    if (row.lastReset != null && now >= row.lastReset) {
      const reset: ProviderQuotaRow = {
        ...row,
        requestsToday: 0,
        tokensToday: 0,
        lastReset: null,
        cooldownUntil: null,
      };
      await setRow(reset);
      return reset;
    }
    return row;
  }

  const dayStart = startOfUtcDay(now);
  if (row.lastReset == null || row.lastReset < dayStart) {
    const reset: ProviderQuotaRow = {
      ...row,
      requestsToday: 0,
      tokensToday: 0,
      lastReset: dayStart,
    };
    await setRow(reset);
    return reset;
  }

  return row;
}

export async function remainingRatio(
  id: ProviderId,
  now = Date.now(),
): Promise<number> {
  const limits = PROVIDER_LIMITS[id];
  const row = await maybeResetDailyCounters(id, now);

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
  const limits = PROVIDER_LIMITS[id];
  const row = await maybeResetDailyCounters(id, now);

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

export async function recordUsage(
  id: ProviderId,
  input: {
    tokensIn?: number;
    tokensOut?: number;
    status: string;
    errorCode?: number;
  },
): Promise<void> {
  const tokensIn = input.tokensIn ?? 0;
  const tokensOut = input.tokensOut ?? 0;

  if (isTauri()) {
    await invokeQuota("quota_record_usage", {
      providerId: id,
      tokensIn,
      tokensOut,
      status: input.status,
      errorCode: input.errorCode ?? null,
    });
    return;
  }

  const row = await maybeResetDailyCounters(id);
  await setRow({
    ...row,
    requestsToday: row.requestsToday + 1,
    tokensToday: row.tokensToday + tokensIn + tokensOut,
  });
}

export async function setCooldown(
  id: ProviderId,
  retries: number,
  now = Date.now(),
): Promise<void> {
  const until = now + computeCooldownMs(retries);
  if (isTauri()) {
    await invokeQuota("quota_set_cooldown", {
      providerId: id,
      cooldownUntil: until,
    });
    return;
  }

  const row = await getRow(id);
  await setRow({ ...row, cooldownUntil: until });
}

export async function clearCooldown(id: ProviderId): Promise<void> {
  if (isTauri()) {
    await invokeQuota("quota_clear_cooldown", { providerId: id });
    return;
  }

  const row = await getRow(id);
  await setRow({ ...row, cooldownUntil: null });
}

export async function applyGroqRollingReset(
  id: ProviderId,
  resetHeader: string,
  now = Date.now(),
): Promise<void> {
  const resetAt = parseGroqResetHeader(resetHeader, now);
  const row = await getRow(id);
  await setRow({
    ...row,
    requestsToday: 0,
    tokensToday: 0,
    lastReset: resetAt,
    cooldownUntil: resetAt,
  });
}

export async function applyGroqRateLimitFromHeaders(
  id: ProviderId,
  remainingRequests: string | null,
  resetRequests: string | null,
): Promise<void> {
  if (remainingRequests === "0" && resetRequests) {
    await applyGroqRollingReset(id, resetRequests);
  }
}
