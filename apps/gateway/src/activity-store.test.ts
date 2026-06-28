import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVITY_RETENTION_DAYS,
  ActivityStore,
  activityRecordToEntry,
  type ActivityRecord,
} from "./activity-store.js";

const NOW = Math.floor(Date.UTC(2026, 5, 28, 12, 0, 0) / 1000);

function sample(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    traceId: "trace-1",
    created: NOW,
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    inputTokens: 100,
    outputTokens: 40,
    costUsd: 0,
    savedVsBaselineUsd: 0.0009,
    latencyMs: 120,
    cacheHit: false,
    routeReason: "cheapest-healthy",
    ...overrides,
  };
}

describe("ActivityStore", () => {
  let dbPath: string;
  let store: ActivityStore;

  afterEach(() => {
    store?.close();
    if (dbPath) {
      rmSync(dbPath, { force: true });
    }
  });

  function open(): ActivityStore {
    const dir = mkdtempSync(join(tmpdir(), "zintus-activity-"));
    dbPath = join(dir, "activity.db");
    store = new ActivityStore(dbPath);
    return store;
  }

  it("round-trips the normalized record shape through recordActivity → listActivity", () => {
    open();
    const entry = sample();
    store.recordActivity(entry);

    const rows = store.listActivity();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(entry);
  });

  it("preserves nulls — no fabricated tokens/latency/savings/route_reason", () => {
    open();
    store.recordActivity(
      sample({
        traceId: "bare",
        inputTokens: null,
        outputTokens: null,
        savedVsBaselineUsd: null,
        latencyMs: null,
        routeReason: null,
        provider: null,
        model: null,
      }),
    );

    const rows = store.listActivity();
    const row = rows[0]!;
    expect(row.inputTokens).toBeNull();
    expect(row.outputTokens).toBeNull();
    expect(row.savedVsBaselineUsd).toBeNull();
    expect(row.latencyMs).toBeNull();
    expect(row.routeReason).toBeNull();
    expect(row.provider).toBeNull();
    expect(row.model).toBeNull();
    // Free-core: cost is the only value that is honestly a hard 0, never invented.
    expect(row.costUsd).toBe(0);
  });

  it("orders newest-first and honors ?limit", () => {
    open();
    store.recordActivity(sample({ traceId: "a", created: NOW - 30 }));
    store.recordActivity(sample({ traceId: "b", created: NOW - 20 }));
    store.recordActivity(sample({ traceId: "c", created: NOW - 10 }));

    const all = store.listActivity();
    expect(all.map((r) => r.traceId)).toEqual(["c", "b", "a"]);

    const page = store.listActivity({ limit: 2 });
    expect(page.map((r) => r.traceId)).toEqual(["c", "b"]);
  });

  it("filters by ?since (unix seconds)", () => {
    open();
    store.recordActivity(sample({ traceId: "old", created: NOW - 1_000 }));
    store.recordActivity(sample({ traceId: "new", created: NOW - 5 }));

    const recent = store.listActivity({ since: NOW - 100 });
    expect(recent.map((r) => r.traceId)).toEqual(["new"]);
  });

  it("filters by ?provider and ?model", () => {
    open();
    store.recordActivity(
      sample({ traceId: "g", provider: "groq", model: "llama-3.3-70b-versatile" }),
    );
    store.recordActivity(
      sample({ traceId: "c", provider: "cerebras", model: "llama-3.1-8b" }),
    );

    expect(store.listActivity({ provider: "groq" }).map((r) => r.traceId)).toEqual([
      "g",
    ]);
    expect(store.listActivity({ model: "llama-3.1-8b" }).map((r) => r.traceId)).toEqual([
      "c",
    ]);
  });

  it("is idempotent on traceId (re-record overwrites, never duplicates)", () => {
    open();
    store.recordActivity(sample({ traceId: "t", latencyMs: 100 }));
    store.recordActivity(sample({ traceId: "t", latencyMs: 250 }));

    const rows = store.listActivity();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.latencyMs).toBe(250);
  });

  it("returns an empty list when nothing has been recorded", () => {
    open();
    expect(store.listActivity()).toEqual([]);
    expect(store.count()).toBe(0);
  });

  it("prunes rows older than the 30-day retention window on open", () => {
    open();
    const nowMs = NOW * 1000;
    const dayMs = 86_400 * 1000;
    // One inside the window, one well past it.
    store.recordActivity(sample({ traceId: "fresh", created: NOW - 60 }));
    store.recordActivity(
      sample({ traceId: "stale", created: NOW - (ACTIVITY_RETENTION_DAYS + 5) * 86_400 }),
    );
    expect(store.count()).toBe(2);

    const removed = store.pruneOld(nowMs + dayMs);
    expect(removed).toBe(1);
    expect(store.listActivity().map((r) => r.traceId)).toEqual(["fresh"]);
  });

  it("activityRecordToEntry maps to the exact Phase-5 entry shape", () => {
    const entry = activityRecordToEntry(sample());
    expect(entry).toEqual({
      id: "trace-1",
      created: NOW,
      created_at: new Date(NOW * 1000).toISOString(),
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      tokens: { input: 100, output: 40, total: 140 },
      cost_usd: 0,
      saved_vs_baseline_usd: 0.0009,
      latency_ms: 120,
      cache_hit: false,
      route_reason: "cheapest-healthy",
    });
  });

  it("activityRecordToEntry emits honest zeros for null tokens and omits route_reason", () => {
    const entry = activityRecordToEntry(
      sample({
        inputTokens: null,
        outputTokens: null,
        savedVsBaselineUsd: null,
        latencyMs: null,
        routeReason: null,
      }),
    );
    expect(entry.tokens).toEqual({ input: 0, output: 0, total: 0 });
    expect(entry.saved_vs_baseline_usd).toBe(0);
    expect(entry.latency_ms).toBeNull();
    expect(entry).not.toHaveProperty("route_reason");
  });
});
