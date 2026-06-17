import { expect, test, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { ResponseCache } from "./cache.js";
import type { ChatMessage } from "@multipleai/types";
import { rmSync } from "node:fs";

const TEST_DB_PATH = `${import.meta.dirname}/test_cache.db`;

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${path}${suffix}`);
    } catch {}
  }
}

describe("ResponseCache", () => {
  let cache: ResponseCache;

  beforeAll(() => {
    cleanup(TEST_DB_PATH);
    cache = new ResponseCache(TEST_DB_PATH);
  });

  afterAll(() => {
    cleanup(TEST_DB_PATH);
  });

  test("exact L1 hit and miss", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello, what is the capital of France?" },
    ];
    const options = {
      model: "test-model",
      providerId: "test-provider",
      temperature: 0.7,
    };

    const key = cache.generateKey(messages, options);

    // Miss initially
    expect(cache.getL1(key)).toBeNull();

    // Set value
    await cache.set(messages, "The capital of France is Paris.", options);

    // Hit now
    expect(cache.getL1(key)).toBe("The capital of France is Paris.");
  });

  test("cache expiration (TTL)", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Explain gravity in one sentence." },
    ];
    const options = {
      model: "test-model",
      providerId: "test-provider",
      ttlMs: 50, // very short TTL
    };

    const key = cache.generateKey(messages, options);
    await cache.set(messages, "Gravity is a force that pulls objects together.", options);

    // Instant hit
    expect(cache.getL1(key)).toBe("Gravity is a force that pulls objects together.");

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Expiration check
    expect(cache.getL1(key)).toBeNull();
  });
});

describe("ResponseCache - L2 gating (Phase 3.1)", () => {
  const dbPath = `${import.meta.dirname}/test_cache_l2.db`;
  const originalFlag = process.env.CACHE_L2;
  const originalHost = process.env.OLLAMA_HOST;

  beforeEach(() => {
    cleanup(dbPath);
    // Ensure no real embedder so we exercise the deterministic fallback path.
    delete process.env.OLLAMA_HOST;
  });

  afterAll(() => {
    cleanup(dbPath);
    if (originalFlag === undefined) delete process.env.CACHE_L2;
    else process.env.CACHE_L2 = originalFlag;
    if (originalHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = originalHost;
  });

  test("L2 disabled by default without a real embedder", async () => {
    delete process.env.CACHE_L2;
    const cache = new ResponseCache(dbPath);
    const messages: ChatMessage[] = [{ role: "user", content: "alpha beta gamma" }];
    const options = { model: "m", providerId: "p" };
    await cache.set(messages, "RESP", options);

    // Even an identical query is gated off because L2 is disabled by default.
    const result = await cache.getL2("alpha beta gamma", "m", "p");
    expect(result).toBeNull();
  });

  test("CACHE_L2=1 enables near-exact fallback dedupe and flags it", async () => {
    process.env.CACHE_L2 = "1";
    const cache = new ResponseCache(dbPath);
    const messages: ChatMessage[] = [{ role: "user", content: "alpha beta gamma delta" }];
    const options = { model: "m", providerId: "p" };
    await cache.set(messages, "RESP", options);

    // Identical prompt => near-exact => hit, flagged as fallback embedding.
    const detailed = await cache.getL2Detailed("alpha beta gamma delta", "m", "p");
    expect(detailed).not.toBeNull();
    expect(detailed!.responseText).toBe("RESP");
    expect(detailed!.fallbackEmbedding).toBe(true);
  });

  test("fallback L2 does NOT match semantically-different prompts", async () => {
    process.env.CACHE_L2 = "1";
    const cache = new ResponseCache(dbPath);
    await cache.set(
      [{ role: "user", content: "How does the sun shine?" }],
      "Nuclear fusion.",
      { model: "m", providerId: "p" },
    );
    // Different wording: with the weak fallback the threshold is clamped to
    // near-exact, so this must be a miss even at a generous requested threshold.
    const result = await cache.getL2("How does the sun produce light?", "m", "p", 0.3);
    expect(result).toBeNull();
  });
});

describe("ResponseCache - sqlite-vec indexed path (bug fix)", () => {
  const dbPath = `${import.meta.dirname}/test_cache_vec.db`;
  const originalFlag = process.env.CACHE_L2;
  const originalHost = process.env.OLLAMA_HOST;

  beforeAll(() => {
    cleanup(dbPath);
    delete process.env.OLLAMA_HOST;
    process.env.CACHE_L2 = "1";
  });

  afterAll(() => {
    cleanup(dbPath);
    if (originalFlag === undefined) delete process.env.CACHE_L2;
    else process.env.CACHE_L2 = originalFlag;
    if (originalHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = originalHost;
  });

  test("indexed vec0 cosine path serves a near-duplicate hit without falling back to the scan", async () => {
    const cache = new ResponseCache(dbPath);
    const prompt = "the quick brown fox jumps over the lazy dog";
    await cache.set(
      [{ role: "user", content: prompt }],
      "FOX-RESPONSE",
      { model: "m", providerId: "p" },
    );

    // Identical prompt => identical embedding => distance ~0.
    const detailed = await cache.getL2Detailed(prompt, "m", "p");
    expect(detailed).not.toBeNull();
    expect(detailed!.responseText).toBe("FOX-RESPONSE");

    if (cache.vectorIndexAvailable) {
      // Where sqlite-vec loads (proper SQLite build), the hit must come from the
      // indexed vec0 path, NOT the linear scan. Before the fix the unregistered
      // hashToken() SQL function threw and this would have been false.
      expect(detailed!.usedVectorIndex).toBe(true);
      expect(cache.lastL2UsedVectorIndex).toBe(true);
    } else {
      // Bun's bundled SQLite can't load extensions; L2 still serves the hit via
      // the linear-scan fallback. The indexed assertion is not applicable here.
      expect(detailed!.usedVectorIndex).toBe(false);
    }
  });
});

describe("ResponseCache - controls (Phase 3.2)", () => {
  const dbPath = `${import.meta.dirname}/test_cache_ctrl.db`;
  const originalFlag = process.env.CACHE_L2;
  const originalHost = process.env.OLLAMA_HOST;

  beforeAll(() => {
    delete process.env.OLLAMA_HOST;
    process.env.CACHE_L2 = "1";
  });

  beforeEach(() => {
    cleanup(dbPath);
  });

  afterAll(() => {
    cleanup(dbPath);
    if (originalFlag === undefined) delete process.env.CACHE_L2;
    else process.env.CACHE_L2 = originalFlag;
    if (originalHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = originalHost;
  });

  test("constructor accepts a plain string path (backward compatible)", async () => {
    const cache = new ResponseCache(dbPath);
    const opts = { model: "m", providerId: "p" };
    const key = cache.generateKey([{ role: "user", content: "x" }], opts);
    await cache.set([{ role: "user", content: "x" }], "Y", opts);
    expect(cache.getL1(key)).toBe("Y");
  });

  test("default L1 TTL from constructor expires entries", async () => {
    const cache = new ResponseCache({ dbPath, l1TtlMs: 40 });
    const opts = { model: "m", providerId: "p" };
    const msgs: ChatMessage[] = [{ role: "user", content: "ttl-test" }];
    const key = cache.generateKey(msgs, opts);
    await cache.set(msgs, "Z", opts);
    expect(cache.getL1(key)).toBe("Z");
    await new Promise((r) => setTimeout(r, 55));
    expect(cache.getL1(key)).toBeNull();
  });

  test("per-call ttlMs overrides the constructor default", async () => {
    const cache = new ResponseCache({ dbPath, l1TtlMs: 5 });
    const opts = { model: "m", providerId: "p", ttlMs: 10_000 };
    const msgs: ChatMessage[] = [{ role: "user", content: "override" }];
    const key = cache.generateKey(msgs, opts);
    await cache.set(msgs, "LONG", opts);
    await new Promise((r) => setTimeout(r, 30));
    // Still present because per-call ttlMs (10s) wins over the 5ms default.
    expect(cache.getL1(key)).toBe("LONG");
  });

  test("bypass option skips L1 cache", async () => {
    const cache = new ResponseCache(dbPath);
    const opts = { model: "m", providerId: "p" };
    const msgs: ChatMessage[] = [{ role: "user", content: "bypass-me" }];
    const key = cache.generateKey(msgs, opts);
    await cache.set(msgs, "STORED", opts);

    expect(cache.getL1(key)).toBe("STORED");
    expect(cache.getL1(key, { bypass: true })).toBeNull();
    // numeric `now` arg still works (backward compatible).
    expect(cache.getL1(key, Date.now())).toBe("STORED");
  });

  test("bypass option skips L2 cache", async () => {
    const cache = new ResponseCache(dbPath);
    const opts = { model: "m", providerId: "p" };
    const prompt = "semantic bypass probe sentence";
    await cache.set([{ role: "user", content: prompt }], "L2RESP", opts);

    expect(await cache.getL2(prompt, "m", "p")).toBe("L2RESP");
    expect(await cache.getL2(prompt, "m", "p", { bypass: true })).toBeNull();
  });
});

describe("ResponseCache - concurrency (Phase 3.3)", () => {
  const dbPath = `${import.meta.dirname}/test_cache_conc.db`;

  beforeAll(() => {
    cleanup(dbPath);
  });

  afterAll(() => {
    cleanup(dbPath);
  });

  test("concurrent get/set on distinct keys is safe", async () => {
    const cache = new ResponseCache(dbPath);
    const opts = { model: "m", providerId: "p" };

    const writes = Array.from({ length: 25 }, (_, i) =>
      cache.set([{ role: "user", content: `concurrent ${i}` }], `R${i}`, opts),
    );
    await Promise.all(writes);

    const keys = Array.from({ length: 25 }, (_, i) =>
      cache.generateKey([{ role: "user", content: `concurrent ${i}` }], opts),
    );
    for (let i = 0; i < keys.length; i += 1) {
      expect(cache.getL1(keys[i]!)).toBe(`R${i}`);
    }
  });

  test("concurrent set on the same key converges to a single stored value", async () => {
    const cache = new ResponseCache(dbPath);
    const opts = { model: "m", providerId: "p" };
    const msgs: ChatMessage[] = [{ role: "user", content: "same key race" }];
    const key = cache.generateKey(msgs, opts);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => cache.set(msgs, `V${i}`, opts)),
    );

    const stored = cache.getL1(key);
    expect(stored).not.toBeNull();
    // Whatever the last writer was, it must be one of the values we wrote.
    expect(/^V\d+$/.test(stored!)).toBe(true);
  });
});
