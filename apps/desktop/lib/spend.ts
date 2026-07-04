/**
 * Local, honest daily-spend ledger for the top-bar meter. Accumulates the
 * gateway's per-turn `meta.costUsd` ESTIMATES (BYOK turns; managed turns bill
 * plan tokens, not dollars, so they add $0 here) under a per-day localStorage
 * key. Display-only — the gateway/relay own real accounting.
 */

const EVENT = "zintus:spend-changed";

function dayKey(now: Date = new Date()): string {
  return `zintus:spend:${now.toISOString().slice(0, 10)}`;
}

export function todaySpendUsd(): number {
  if (typeof localStorage === "undefined") return 0;
  const raw = localStorage.getItem(dayKey());
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

/** Add a turn's estimated cost; returns the new daily total. */
export function addSpendUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return todaySpendUsd();
  const next = todaySpendUsd() + usd;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(dayKey(), String(next));
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  }
  return next;
}

/** Subscribe to same-window spend updates. Returns unsubscribe. */
export function onSpendChange(callback: (totalUsd: number) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => callback(todaySpendUsd());
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

export function formatSpend(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

// ── Daily budget (soft cap) ─────────────────────────────────────────────────

const BUDGET_KEY = "zintus:budget-usd";

/** User-set soft daily budget in USD; null = no budget set. */
export function getBudgetUsd(): number | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(BUDGET_KEY);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function setBudgetUsd(value: number | null): void {
  if (typeof localStorage === "undefined") return;
  if (value == null || !Number.isFinite(value) || value <= 0) {
    localStorage.removeItem(BUDGET_KEY);
  } else {
    localStorage.setItem(BUDGET_KEY, String(value));
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: todaySpendUsd() }));
  }
}

/** True when today's estimated spend has crossed the soft budget. */
export function overBudget(): boolean {
  const budget = getBudgetUsd();
  return budget != null && todaySpendUsd() >= budget;
}

// ── Per-day usage ledger (requests + per-model tokens + saved) ──────────────
// Same honesty contract as the spend keys above: local estimates for display,
// accumulated per calendar day so Usage can show Today / 7d / 30d without
// inventing history. The gateway/relay stay the source of billing truth.

export interface DayUsage {
  requests: number;
  /** key = `${providerId}·${model}` */
  models: Record<string, { in: number; out: number }>;
  /** Estimated USD saved this day (compression + free-tier routing). */
  savedUsd: number;
}

function usageKey(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return `zintus:usage:${d.toISOString().slice(0, 10)}`;
}

function readDay(key: string): DayUsage {
  if (typeof localStorage === "undefined") return { requests: 0, models: {}, savedUsd: 0 };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { requests: 0, models: {}, savedUsd: 0 };
    const parsed = JSON.parse(raw) as Partial<DayUsage>;
    return {
      requests: parsed.requests ?? 0,
      models: parsed.models ?? {},
      savedUsd: parsed.savedUsd ?? 0,
    };
  } catch {
    return { requests: 0, models: {}, savedUsd: 0 };
  }
}

/** Record one completed turn into today's ledger. */
export function recordTurnUsage(entry: {
  providerId: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  savedUsd?: number;
}): void {
  if (typeof localStorage === "undefined") return;
  const key = usageKey();
  const day = readDay(key);
  day.requests += 1;
  const modelKey = `${entry.providerId}·${entry.model}`;
  const m = day.models[modelKey] ?? { in: 0, out: 0 };
  m.in += entry.tokensIn ?? 0;
  m.out += entry.tokensOut ?? 0;
  day.models[modelKey] = m;
  if (entry.savedUsd && Number.isFinite(entry.savedUsd)) day.savedUsd += entry.savedUsd;
  localStorage.setItem(key, JSON.stringify(day));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: todaySpendUsd() }));
  }
}

/** Merge the last `days` calendar days of the ledger (1 = today only). */
export function usageForDays(days: number): DayUsage {
  const merged: DayUsage = { requests: 0, models: {}, savedUsd: 0 };
  for (let i = 0; i < days; i += 1) {
    const day = readDay(usageKey(i));
    merged.requests += day.requests;
    merged.savedUsd += day.savedUsd;
    for (const [k, v] of Object.entries(day.models)) {
      const m = merged.models[k] ?? { in: 0, out: 0 };
      m.in += v.in;
      m.out += v.out;
      merged.models[k] = m;
    }
  }
  return merged;
}

/** Sum estimated spend over the last `days` calendar days (1 = today). */
export function spendUsdForDays(days: number): number {
  if (typeof localStorage === "undefined") return 0;
  let total = 0;
  for (let i = 0; i < days; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const raw = localStorage.getItem(`zintus:spend:${d.toISOString().slice(0, 10)}`);
    const value = raw ? Number(raw) : 0;
    if (Number.isFinite(value)) total += value;
  }
  return total;
}
