import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCCRStore } from "../src/ccr/store";
import { retrieve } from "../src/ccr/retrieve";

describe("CCR store", () => {
  const dbPath = join(tmpdir(), `tokzen-test-${Date.now()}.db`);
  const store = createCCRStore(dbPath);

  it("stores and retrieves content by hash", () => {
    const content = "This is some test content that needs to be stored.";
    const hash = store.store(content, "prose");
    expect(hash).toHaveLength(16);
    const retrieved = store.retrieve(hash);
    expect(retrieved).toBe(content);
  });

  it("returns null for unknown hash", () => {
    const result = store.retrieve("nonexistent000000");
    expect(result).toBeNull();
  });

  it("deduplicates identical content (same hash)", () => {
    const content = "Identical content stored twice.";
    const hash1 = store.store(content, "json");
    const hash2 = store.store(content, "json");
    expect(hash1).toBe(hash2);
  });

  it("stores different content types", () => {
    const types = ["json", "code", "log", "diff", "prose", "conversation"] as const;
    for (const type of types) {
      const content = `${type} content: ${Math.random()}`;
      const hash = store.store(content, type);
      const retrieved = store.retrieve(hash);
      expect(retrieved).toBe(content);
    }
  });

  it("lossless round-trip for large content", () => {
    const large = "This is a very long document. ".repeat(500);
    const hash = store.store(large, "prose");
    const retrieved = store.retrieve(hash);
    expect(retrieved).toBe(large);
  });

  it("BM25 retrieve returns relevant sections", () => {
    const content = `
Introduction to machine learning.
Deep learning uses neural networks with many layers.
The cat sat on the mat in the garden.
Gradient descent optimizes model parameters.
Neural networks can recognize images and text.
    `.trim();
    const hash = store.store(content, "prose");
    const result = retrieve(hash, "neural network deep learning", store);
    // Should return content containing the relevant sections
    expect(result).toBeTruthy();
    expect(result).not.toBeNull();
  });

  it("BM25 retrieve returns full content when no query", () => {
    const content = "Full content for retrieval without query.";
    const hash = store.store(content, "prose");
    const result = retrieve(hash, undefined, store);
    expect(result).toBe(content);
  });
});
