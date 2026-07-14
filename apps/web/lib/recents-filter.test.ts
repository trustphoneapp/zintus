import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RECENTS_FILTERS,
  filterRecents,
  isDefaultRecentsFilters,
  type RecentsFilters,
  type RecentsFilterThread,
} from "./recents-filter";

const DAY = 86_400_000;
// Fixed "now" mid-day so calendar-day math in matchesActivity is unambiguous.
const NOW = new Date(2026, 6, 14, 12, 0, 0).getTime();
const startOfToday = new Date(2026, 6, 14, 0, 0, 0).getTime();

function thread(overrides: Partial<RecentsFilterThread> = {}): RecentsFilterThread {
  return {
    id: "t1",
    updatedAt: NOW,
    messages: [],
    ...overrides,
  };
}

function filters(overrides: Partial<RecentsFilters> = {}): RecentsFilters {
  return { ...DEFAULT_RECENTS_FILTERS, ...overrides };
}

describe("isDefaultRecentsFilters", () => {
  test("true for the default value", () => {
    expect(isDefaultRecentsFilters(DEFAULT_RECENTS_FILTERS)).toBe(true);
  });
  test("false when any single dimension is non-default", () => {
    expect(isDefaultRecentsFilters(filters({ pinned: "pinned" }))).toBe(false);
    expect(isDefaultRecentsFilters(filters({ activity: "today" }))).toBe(false);
    expect(isDefaultRecentsFilters(filters({ route: "membership" }))).toBe(false);
  });
});

describe("filterRecents — pinned", () => {
  test("all passes every thread through", () => {
    const threads = [thread({ id: "a" }), thread({ id: "b" })];
    const result = filterRecents(threads, new Set(), filters({ pinned: "all" }), NOW);
    expect(result.map((t) => t.id)).toEqual(["a", "b"]);
  });
  test("pinned keeps only threads in the pinned set", () => {
    const threads = [thread({ id: "a" }), thread({ id: "b" })];
    const result = filterRecents(
      threads,
      new Set(["b"]),
      filters({ pinned: "pinned" }),
      NOW,
    );
    expect(result.map((t) => t.id)).toEqual(["b"]);
  });
});

describe("filterRecents — activity", () => {
  test("today keeps only threads updated since local midnight (mirrors groupThreadsByDate)", () => {
    const threads = [
      thread({ id: "today", updatedAt: startOfToday + 60_000 }),
      thread({ id: "yesterday", updatedAt: startOfToday - 60_000 }),
    ];
    const result = filterRecents(threads, new Set(), filters({ activity: "today" }), NOW);
    expect(result.map((t) => t.id)).toEqual(["today"]);
  });
  test("week keeps the last 7 days, excludes older", () => {
    const threads = [
      thread({ id: "in", updatedAt: NOW - 6 * DAY }),
      thread({ id: "boundary", updatedAt: NOW - 7 * DAY }),
      thread({ id: "out", updatedAt: NOW - 8 * DAY }),
    ];
    const result = filterRecents(threads, new Set(), filters({ activity: "week" }), NOW);
    expect(result.map((t) => t.id)).toEqual(["in", "boundary"]);
  });
  test("month keeps the last 30 days, excludes older", () => {
    const threads = [
      thread({ id: "in", updatedAt: NOW - 29 * DAY }),
      thread({ id: "boundary", updatedAt: NOW - 30 * DAY }),
      thread({ id: "out", updatedAt: NOW - 31 * DAY }),
    ];
    const result = filterRecents(threads, new Set(), filters({ activity: "month" }), NOW);
    expect(result.map((t) => t.id)).toEqual(["in", "boundary"]);
  });
});

describe("filterRecents — route", () => {
  test("membership keeps threads with at least one managed assistant turn", () => {
    const threads = [
      thread({
        id: "managed",
        messages: [{ role: "assistant", meta: { managed: true } }],
      }),
      thread({
        id: "byok",
        messages: [{ role: "assistant", meta: { managed: false } }],
      }),
      thread({ id: "no-meta", messages: [{ role: "assistant" }] }),
    ];
    const result = filterRecents(threads, new Set(), filters({ route: "membership" }), NOW);
    expect(result.map((t) => t.id)).toEqual(["managed"]);
  });
  test("byok keeps threads with an assistant turn that has meta but isn't managed", () => {
    const threads = [
      thread({
        id: "managed",
        messages: [{ role: "assistant", meta: { managed: true } }],
      }),
      thread({
        id: "byok",
        messages: [{ role: "assistant", meta: { managed: false } }],
      }),
      thread({ id: "no-meta", messages: [{ role: "assistant" }] }),
    ];
    const result = filterRecents(threads, new Set(), filters({ route: "byok" }), NOW);
    expect(result.map((t) => t.id)).toEqual(["byok"]);
  });
  test("a mixed thread (both managed AND BYOK turns) matches both route filters", () => {
    const threads = [
      thread({
        id: "mixed",
        messages: [
          { role: "assistant", meta: { managed: true } },
          { role: "assistant", meta: { managed: false } },
        ],
      }),
    ];
    expect(
      filterRecents(threads, new Set(), filters({ route: "membership" }), NOW).map((t) => t.id),
    ).toEqual(["mixed"]);
    expect(
      filterRecents(threads, new Set(), filters({ route: "byok" }), NOW).map((t) => t.id),
    ).toEqual(["mixed"]);
  });
  test("user turns never satisfy a route filter, even with meta-shaped content", () => {
    const threads = [
      thread({ id: "user-only", messages: [{ role: "user" }] }),
    ];
    expect(
      filterRecents(threads, new Set(), filters({ route: "membership" }), NOW),
    ).toEqual([]);
    expect(filterRecents(threads, new Set(), filters({ route: "byok" }), NOW)).toEqual([]);
  });
});

describe("filterRecents — combined dimensions", () => {
  test("pinned + activity + route all apply together (AND, not OR)", () => {
    const threads = [
      thread({
        id: "match",
        updatedAt: startOfToday + 60_000,
        messages: [{ role: "assistant", meta: { managed: true } }],
      }),
      // Right route + activity, but not pinned.
      thread({
        id: "not-pinned",
        updatedAt: startOfToday + 60_000,
        messages: [{ role: "assistant", meta: { managed: true } }],
      }),
      // Pinned + right route, but stale.
      thread({
        id: "stale",
        updatedAt: NOW - 40 * DAY,
        messages: [{ role: "assistant", meta: { managed: true } }],
      }),
    ];
    const result = filterRecents(
      threads,
      new Set(["match", "stale"]),
      filters({ pinned: "pinned", activity: "today", route: "membership" }),
      NOW,
    );
    expect(result.map((t) => t.id)).toEqual(["match"]);
  });

  test("order is preserved — filterRecents never re-sorts", () => {
    const threads = [thread({ id: "b", updatedAt: NOW }), thread({ id: "a", updatedAt: NOW })];
    const result = filterRecents(threads, new Set(), filters(), NOW);
    expect(result.map((t) => t.id)).toEqual(["b", "a"]);
  });
});
