import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "./memory-store.js";

// Facts CRUD on memory-store (vector.test.ts covers the chunk/embedding path).
// Also pins the vec0-safe write: repeated chunk inserts must not crash on the
// sqlite-vec UNIQUE-constraint path that has bitten Linux CI before.

describe("MemoryStore facts", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zintus-mem-"));
    store = new MemoryStore(join(dir, "memory.db"));
    store.init();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("upsertFact by the same id UPDATES in place (one row, preserved createdAt)", () => {
    const first = store.upsertFact({ id: "f1", threadId: "t1", key: "name", value: "Ada" });
    const second = store.upsertFact({ id: "f1", threadId: "t1", key: "name", value: "Grace" });

    const facts = store.listFacts("t1");
    expect(facts.length).toBe(1);
    expect(facts[0]!.value).toBe("Grace");
    // createdAt is preserved across the update; updatedAt moves forward.
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  test("distinct ids produce distinct facts", () => {
    store.upsertFact({ id: "a", threadId: "t1", key: "k", value: "1" });
    store.upsertFact({ id: "b", threadId: "t1", key: "k", value: "2" });
    expect(store.listFacts("t1").length).toBe(2);
  });

  test("listFacts is scoped to its thread", () => {
    store.upsertFact({ id: "a", threadId: "t1", key: "k", value: "1" });
    store.upsertFact({ id: "b", threadId: "t2", key: "k", value: "2" });
    expect(store.listFacts("t1").map((f) => f.id)).toEqual(["a"]);
    expect(store.listFacts("t2").map((f) => f.id)).toEqual(["b"]);
    expect(store.listFacts("nonexistent")).toEqual([]);
  });

  test("deleteFact removes a fact and reports whether it existed", () => {
    store.upsertFact({ id: "a", threadId: "t1", key: "k", value: "1" });
    expect(store.deleteFact("t1", "a")).toBe(true);
    expect(store.listFacts("t1")).toEqual([]);
    // deleting again / a missing id returns false, no throw
    expect(store.deleteFact("t1", "a")).toBe(false);
  });

  test("repeated chunk inserts do not crash on the sqlite-vec UNIQUE path", () => {
    const embedding = Array.from({ length: 8 }, (_, i) => i / 8);
    expect(() => {
      store.appendChunk({ threadId: "t1", content: "hello world", embedding });
      store.appendChunk({ threadId: "t1", content: "hello world", embedding });
      store.appendChunk({ threadId: "t1", content: "different content", embedding });
    }).not.toThrow();
  });

  test("re-opening the db re-inserts existing vec0 rowids (upsert path) without crashing", async () => {
    const reopenDir = mkdtempSync(join(tmpdir(), "zintus-mem-reopen-"));
    const dbPath = join(reopenDir, "memory.db");
    try {
      const first = new MemoryStore(dbPath);
      first.init();
      await first.embedAndStoreChunk("t1", "bun install fetches the project dependencies");
      await first.embedAndStoreChunk("t1", "sqlite keeps data in one local file");
      (first as unknown as { sqlite: { close(): void } }).sqlite.close();

      // Re-open: init() -> restoreVectorTable() -> backfillVectorTable() re-inserts
      // every already-persisted rowid into the vec0 table. INSERT OR REPLACE raises
      // a UNIQUE constraint on the vec0 vtable on Linux CI; DELETE-then-INSERT is
      // the supported upsert idiom, so the re-insert must not throw...
      const second = new MemoryStore(dbPath);
      expect(() => second.init()).not.toThrow();

      // ...and the rows survive the upsert and stay retrievable.
      const matches = await second.searchChunks("t1", "how do I install bun dependencies?", 2);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.content.includes("bun install"))).toBe(true);
      (second as unknown as { sqlite: { close(): void } }).sqlite.close();
    } finally {
      rmSync(reopenDir, { recursive: true, force: true });
    }
  });

  test("appendChunk round-trips the embedding it was given", () => {
    const embedding = [0.1, 0.2, 0.3, 0.4];
    const row = store.appendChunk({ threadId: "t1", content: "x", embedding });
    expect(row.embedding).toEqual(embedding);
  });
});
