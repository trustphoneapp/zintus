import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { MemoryStore } from "./memory-store.js";

/**
 * Governance layer (Phase 3a): scope-aware facts, curation (pin / last-used),
 * id-based edit/delete, and a safe, idempotent migration of pre-governance DBs.
 */

describe("MemoryStore governance", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zintus-gov-"));
    dbPath = join(dir, "memory.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function store(): MemoryStore {
    const s = new MemoryStore(dbPath);
    s.init();
    return s;
  }

  test("upsert + list facts by scope: global / thread / project", () => {
    const s = store();
    s.upsertFact({ scope: "global", key: "name", value: "Alice" });
    s.upsertFact({ scope: "thread", threadId: "t1", key: "goal", value: "ship" });
    s.upsertFact({
      scope: "project",
      projectId: "p1",
      key: "stack",
      value: "bun",
    });

    expect(s.listFactsByScope({ scope: "global" }).map((f) => f.value)).toEqual([
      "Alice",
    ]);
    expect(
      s.listFactsByScope({ scope: "thread", threadId: "t1" }).map((f) => f.value),
    ).toEqual(["ship"]);
    expect(
      s.listFactsByScope({ scope: "project", projectId: "p1" }).map((f) => f.value),
    ).toEqual(["bun"]);
    // Global facts have no owning thread.
    expect(s.listFactsByScope({ scope: "global" })[0]?.threadId).toBeNull();
  });

  test("pinned facts sort first", () => {
    const s = store();
    s.upsertFact({ id: "a", scope: "global", key: "a", value: "1" });
    s.upsertFact({ id: "b", scope: "global", key: "b", value: "2", pinned: true });
    const ordered = s.listFactsByScope({ scope: "global" }).map((f) => f.id);
    expect(ordered[0]).toBe("b"); // pinned first regardless of recency
  });

  test("updateFactById edits value and pin; deleteFactById removes it", () => {
    const s = store();
    const created = s.upsertFact({ scope: "global", key: "k", value: "old" });
    const updated = s.updateFactById(created.id, { value: "new", pinned: true });
    expect(updated?.value).toBe("new");
    expect(updated?.pinned).toBe(true);
    expect(s.deleteFactById(created.id)).toBe(true);
    expect(s.deleteFactById(created.id)).toBe(false); // already gone
    expect(s.listFactsByScope({ scope: "global" })).toHaveLength(0);
  });

  test("touchFactsUsed stamps lastUsedAt on the included facts only", () => {
    const s = store();
    const used = s.upsertFact({ scope: "global", key: "u", value: "1" });
    const unused = s.upsertFact({ scope: "global", key: "n", value: "2" });
    s.touchFactsUsed([used.id]);
    const rows = s.listFactsByScope({ scope: "global" });
    expect(rows.find((f) => f.id === used.id)?.lastUsedAt).toBeGreaterThan(0);
    expect(rows.find((f) => f.id === unused.id)?.lastUsedAt).toBeUndefined();
  });

  test("auto-upsert (thread/key/value only) never resets a fact's governance fields", () => {
    const s = store();
    const f = s.upsertFact({
      id: "g",
      scope: "global",
      key: "name",
      value: "Alice",
      pinned: true,
    });
    // The engine's auto path calls upsertFact with only thread/key/value/source.
    const after = s.upsertFact({ id: f.id, key: "name", value: "Alice B." });
    expect(after.scope).toBe("global"); // preserved, not reset to "thread"
    expect(after.pinned).toBe(true); // preserved
    expect(after.value).toBe("Alice B.");
  });

  test("global facts influence getTopFacts for ANY thread (not just thread facts)", async () => {
    const s = store();
    s.upsertFact({ scope: "global", key: "name", value: "Alice" });
    s.upsertFact({ scope: "thread", threadId: "t1", key: "goal", value: "ship" });

    // A thread with NO facts of its own still sees the global fact.
    const forOtherThread = await s.getTopFacts("t-other", "who am I", 6);
    expect(forOtherThread.some((f) => f.content.includes("Alice"))).toBe(true);

    // The owning thread sees both its own fact and the global one.
    const forT1 = await s.getTopFacts("t1", "goal", 6);
    expect(forT1.some((f) => f.content.includes("ship"))).toBe(true);
    expect(forT1.some((f) => f.content.includes("Alice"))).toBe(true);
  });

  test("a pinned global fact floats to the top of getTopFacts", async () => {
    const s = store();
    // Many unpinned facts + one pinned — the pinned one must rank first even with
    // no query match.
    for (let i = 0; i < 8; i++) {
      s.upsertFact({ scope: "global", key: `k${i}`, value: `v${i}` });
    }
    s.upsertFact({ scope: "global", key: "critical", value: "pinned fact", pinned: true });
    const top = await s.getTopFacts("t", "", 3);
    expect(top[0]?.content).toContain("pinned fact");
  });

  test("migration is idempotent: init() twice is a no-op", () => {
    const s = store();
    s.upsertFact({ scope: "global", key: "k", value: "v" });
    // Re-running init must not throw or lose data.
    expect(() => s.init()).not.toThrow();
    expect(s.listFactsByScope({ scope: "global" })).toHaveLength(1);
  });

  test("upgrades a PRE-governance DB: preserves rows, backfills scope='thread', relaxes NOT NULL", () => {
    // Hand-build the OLD schema (thread_id NOT NULL, no governance columns).
    const raw = new Database(dbPath, { create: true });
    raw.exec(`
      CREATE TABLE memory_facts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO memory_facts (id, thread_id, key, value, source, created_at, updated_at)
        VALUES ('old1', 't-legacy', 'name', 'Alice', 'llm', 1000, 2000);
    `);
    raw.close();

    // Opening + init() must migrate in place without losing the legacy fact.
    const s = store();
    const legacy = s.listFacts("t-legacy");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.value).toBe("Alice");
    expect(legacy[0]?.scope).toBe("thread"); // backfilled
    expect(legacy[0]?.pinned).toBe(false);

    // And the NOT NULL constraint is relaxed: a global fact (null thread) inserts.
    s.upsertFact({ scope: "global", key: "g", value: "ok" });
    expect(s.listFactsByScope({ scope: "global" })[0]?.threadId).toBeNull();
  });
});
