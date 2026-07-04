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
