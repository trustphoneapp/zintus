/**
 * Pure filter logic for the sidebar's Recents list (Claude/ChatGPT-inspired
 * chat filters, built ONLY from attributes Zintus threads really have). There
 * is deliberately no "project" filter — threads carry no project linkage, and
 * a filter that can't honestly resolve is worse than no filter.
 *
 * Kept structural so this module never imports app-store (same reasoning as
 * lib/chat-client.ts's `StoredTurn`) — Sidebar.tsx passes real `Thread`s in,
 * which satisfy `RecentsFilterThread` structurally.
 */

export interface RecentsFilterMessage {
  role: "user" | "assistant";
  /** Present only on assistant turns; `managed` distinguishes a
   *  membership-routed reply (relay-served, plan tokens) from BYOK. */
  meta?: { managed?: boolean };
}

export interface RecentsFilterThread {
  id: string;
  updatedAt: number;
  messages: readonly RecentsFilterMessage[];
}

export interface RecentsFilters {
  pinned: "all" | "pinned";
  activity: "all" | "today" | "week" | "month";
  route: "all" | "membership" | "byok";
}

export const DEFAULT_RECENTS_FILTERS: RecentsFilters = {
  pinned: "all",
  activity: "all",
  route: "all",
};

/** View concern, deliberately kept OUT of filterRecents — the Sidebar decides
 *  whether to run groupThreadsByDate ("date") or render one flat pinned-first
 *  list ("none"). */
export type RecentsGroupBy = "date" | "none";

export function isDefaultRecentsFilters(f: RecentsFilters): boolean {
  return (
    f.pinned === DEFAULT_RECENTS_FILTERS.pinned &&
    f.activity === DEFAULT_RECENTS_FILTERS.activity &&
    f.route === DEFAULT_RECENTS_FILTERS.route
  );
}

function matchesActivity(
  updatedAt: number,
  activity: RecentsFilters["activity"],
  now: number,
): boolean {
  if (activity === "all") return true;
  if (activity === "today") {
    // Mirrors Sidebar.tsx's groupThreadsByDate day boundary EXACTLY (local
    // calendar midnight, not a rolling 24h window) so this filter and the
    // "Today" group label never disagree about which threads count.
    const d = new Date(now);
    const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return updatedAt >= startToday;
  }
  if (activity === "week") return updatedAt >= now - 7 * 86_400_000;
  return updatedAt >= now - 30 * 86_400_000; // month
}

function matchesRoute(
  messages: readonly RecentsFilterMessage[],
  route: RecentsFilters["route"],
): boolean {
  if (route === "all") return true;
  if (route === "membership") {
    return messages.some((m) => m.role === "assistant" && m.meta?.managed === true);
  }
  // byok: at least one assistant turn carries transparency meta and was NOT
  // managed. A thread with both membership AND BYOK turns matches both
  // filters — that's honest (it really did route both ways).
  return messages.some(
    (m) => m.role === "assistant" && m.meta !== undefined && m.meta.managed !== true,
  );
}

/**
 * Apply pinned/activity/route filters to an already-sorted thread list.
 * Order is preserved — this only removes entries, it never re-sorts. `now` is
 * a parameter (not `Date.now()`) so activity windows are deterministic in tests.
 */
export function filterRecents<T extends RecentsFilterThread>(
  threads: readonly T[],
  pinnedSet: Set<string>,
  filters: RecentsFilters,
  now: number,
): T[] {
  return threads.filter((t) => {
    if (filters.pinned === "pinned" && !pinnedSet.has(t.id)) return false;
    if (!matchesActivity(t.updatedAt, filters.activity, now)) return false;
    if (!matchesRoute(t.messages, filters.route)) return false;
    return true;
  });
}
