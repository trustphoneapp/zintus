import { computeCooldownMs, isInCooldown } from "./cooldown.js";
import type { ProviderLimits } from "./limits.js";

/**
 * Storage-agnostic quota logic shared by every platform.
 *
 * The router package's `QuotaLedger` (bun:sqlite), the desktop app
 * (localStorage), and the mobile app (expo-sqlite) all persist quota state
 * differently, but the *decisions* — when to reset counters, whether a provider
 * is available, how much budget remains, how long to cool down — must be
 * identical everywhere. They live here, as pure functions over a plain row, so
 * there is exactly one source of truth and no drift between platforms.
 */
export interface QuotaRow {
  requestsToday: number;
  tokensToday: number;
  lastReset: number | null;
  cooldownUntil: number | null;
}

export function emptyQuotaRow(): QuotaRow {
  return {
    requestsToday: 0,
    tokensToday: 0,
    lastReset: null,
    cooldownUntil: null,
  };
}

export function startOfUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Returns the fields to persist when a counter reset is due, or null when no
 * reset is needed. Daily-quota providers reset at the UTC day boundary;
 * rolling-window providers (e.g. Groq) reset when their stored reset timestamp
 * has elapsed.
 */
export function resetPatch(
  row: QuotaRow,
  limits: ProviderLimits,
  now: number,
): Partial<QuotaRow> | null {
  if (limits.rollingWindow) {
    if (row.lastReset != null && now >= row.lastReset) {
      return {
        requestsToday: 0,
        tokensToday: 0,
        lastReset: null,
        cooldownUntil: null,
      };
    }
    return null;
  }

  const dayStart = startOfUtcDay(now);
  if (row.lastReset == null || row.lastReset < dayStart) {
    return { requestsToday: 0, tokensToday: 0, lastReset: dayStart };
  }
  return null;
}

export function applyResetPatch(
  row: QuotaRow,
  patch: Partial<QuotaRow> | null,
): QuotaRow {
  return patch ? { ...row, ...patch } : row;
}

/**
 * Whether the provider can accept a request right now. Expects `row` to already
 * reflect any due reset (callers should apply `resetPatch` first).
 */
export function isQuotaAvailable(
  row: QuotaRow,
  limits: ProviderLimits,
  now: number,
): boolean {
  if (isInCooldown(row.cooldownUntil, now)) {
    return false;
  }
  if (limits.rollingWindow && row.lastReset != null && row.lastReset > now) {
    return false;
  }
  if (limits.requestsPerDay != null && row.requestsToday >= limits.requestsPerDay) {
    return false;
  }
  if (limits.tokensPerDay != null && row.tokensToday >= limits.tokensPerDay) {
    return false;
  }
  return true;
}

/** Fraction of quota remaining (0..1), using whichever limit is tightest. */
export function remainingRatio(row: QuotaRow, limits: ProviderLimits): number {
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

/** Absolute timestamp until which the provider should be cooled down. */
export function cooldownUntil(retries: number, now: number): number {
  return now + computeCooldownMs(retries);
}

/** Apply one recorded request to a row, returning the updated counters. */
export function applyUsage(
  row: QuotaRow,
  tokensIn: number,
  tokensOut: number,
): Pick<QuotaRow, "requestsToday" | "tokensToday"> {
  return {
    requestsToday: row.requestsToday + 1,
    tokensToday: row.tokensToday + tokensIn + tokensOut,
  };
}
