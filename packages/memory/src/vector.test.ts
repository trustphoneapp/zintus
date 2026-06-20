import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkText, embedBatch, embedText } from "./embeddings.js";
import { MemoryStore } from "./memory-store.js";

const tempDbPaths: string[] = [];

afterEach(() => {
  while (tempDbPaths.length) {
    const dbPath = tempDbPaths.pop();
    if (!dbPath) {
      continue;
    }
    rmSync(dbPath, { force: true });
  }
});

function createStore(): MemoryStore {
  const dbPath = join(tmpdir(), `zintus-memory-${Date.now()}-${Math.random()}.db`);
  tempDbPaths.push(dbPath);
  const store = new MemoryStore(dbPath);
  store.init();
  return store;
}

describe("embeddings", () => {
  test("chunkText splits with overlap", () => {
    const chunks = chunkText("abcdefghijklmnopqrstuvwxyz", 10, 2);
    expect(chunks).toEqual(["abcdefghij", "ijklmnopqr", "qrstuvwxyz"]);
  });

  test("embedText fallback is deterministic when OLLAMA_HOST missing", async () => {
    const previousHost = process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_HOST;

    const first = await embedText("alpha beta gamma");
    const second = await embedText("alpha beta gamma");

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);

    if (previousHost) {
      process.env.OLLAMA_HOST = previousHost;
    }
  });

  test("embedBatch fallback is deterministic when OLLAMA_HOST missing", async () => {
    const previousHost = process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_HOST;

    const texts = ["alpha beta gamma", "delta epsilon zeta"];
    const first = await embedBatch(texts);
    const second = await embedBatch(texts);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]?.length).toBeGreaterThan(0);

    if (previousHost) {
      process.env.OLLAMA_HOST = previousHost;
    }
  });
});

describe("MemoryStore vector retrieval", () => {
  test("sqlite-vec virtual table is created when extension is available", () => {
    const store = createStore();
    const internal = store as unknown as {
      sqlite: {
        query<T>(sql: string): { all(...params: unknown[]): T[] };
      };
      sqliteVecAvailable: boolean;
    };

    if (!internal.sqliteVecAvailable) {
      expect(internal.sqliteVecAvailable).toBe(false);
      return;
    }

    store.appendChunk({
      threadId: "thread-a",
      content: "vector indexing bootstrap",
      embedding: [0.5, 0.25, 0.125],
    });

    const rows = internal.sqlite
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_chunk_vectors'",
      )
      .all();
    expect(rows).toHaveLength(1);
  });

  test("embedAndStoreChunk persists chunk embeddings", async () => {
    const store = createStore();
    const rows = await store.embedAndStoreChunk(
      "thread-a",
      "Bun test runs quickly. Vector search should find this sentence.",
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.embedding?.length).toBeGreaterThan(0);
    expect(rows[0]?.metadata).toMatchObject({
      provider: "fallback",
      model: "fallback-hash-v1",
    });
    expect(typeof rows[0]?.metadata?.dimensions).toBe("number");
  });

  test("searchChunks ranks semantically similar chunks", async () => {
    const store = createStore();

    await store.embedAndStoreChunk(
      "thread-a",
      "Install Bun dependencies with bun install before running tests.",
    );
    await store.embedAndStoreChunk(
      "thread-a",
      "SQLite databases are useful for local-first storage.",
    );

    const matches = await store.searchChunks("thread-a", "How do I run bun tests?", 2);

    expect(matches).toHaveLength(2);
    expect(matches[0]?.content.toLowerCase()).toContain("bun");
    expect((matches[0]?.relevance ?? 0) >= (matches[1]?.relevance ?? 0)).toBe(true);
  });

  test("searchChunks gracefully falls back when sqlite-vec path is unavailable", async () => {
    const store = createStore();
    (store as unknown as { sqliteVecAvailable: boolean }).sqliteVecAvailable = false;

    await store.embedAndStoreChunk(
      "thread-a",
      "Install Bun dependencies with bun install before running tests.",
    );
    await store.embedAndStoreChunk(
      "thread-a",
      "SQLite databases are useful for local-first storage.",
    );

    const matches = await store.searchChunks("thread-a", "How do I run bun tests?", 2);
    expect(matches).toHaveLength(2);
    expect(matches[0]?.content.toLowerCase()).toContain("bun");
  });
});
