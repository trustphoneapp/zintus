import { afterEach, describe, expect, test } from "bun:test";
import {
  embedBatch,
  embedBatchWithMetadata,
  embeddingMode,
  embedText,
} from "./embeddings.js";

// Honesty guard for the embedding mode: when OLLAMA_HOST is unset (the default),
// `embedBatch`/`embedText` return a deterministic keyword-hash fallback whose
// cosine similarity is token OVERLAP, not semantic meaning. These tests pin that
// `embeddingMode()` reports the degraded mode and that the fallback vectors are
// deterministic + correctly dimensioned, and that the one-time warning fires
// once and never logs user content.

const ORIGINAL_OLLAMA_HOST = process.env.OLLAMA_HOST;

afterEach(() => {
  if (ORIGINAL_OLLAMA_HOST === undefined) {
    delete process.env.OLLAMA_HOST;
  } else {
    process.env.OLLAMA_HOST = ORIGINAL_OLLAMA_HOST;
  }
});

describe("embeddingMode honesty", () => {
  // First fallback use in this module so the one-time warning is observable here.
  test("keyword-hash fallback warns once and never logs user content", async () => {
    delete process.env.OLLAMA_HOST;
    const secret = "supersecretuserphrase";

    const calls: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      calls.push(args.map(String).join(" "));
    };
    try {
      await embedBatch([`${secret} alpha beta`]);
      await embedText("gamma delta epsilon");
    } finally {
      console.warn = original;
    }

    // Fires exactly once across the two fallback calls.
    expect(calls).toHaveLength(1);
    for (const message of calls) {
      expect(message).not.toContain(secret);
      expect(message.toLowerCase()).toContain("ollama_host");
    }
  });

  test("embeddingMode() is keyword-hash when OLLAMA_HOST is unset", () => {
    delete process.env.OLLAMA_HOST;
    expect(embeddingMode()).toBe("keyword-hash");
  });

  test("embeddingMode() is keyword-hash when OLLAMA_HOST is blank/whitespace", () => {
    process.env.OLLAMA_HOST = "   ";
    expect(embeddingMode()).toBe("keyword-hash");
  });

  test("embeddingMode() is ollama when OLLAMA_HOST is configured", () => {
    process.env.OLLAMA_HOST = "http://localhost:11434";
    expect(embeddingMode()).toBe("ollama");
  });

  test("keyword-hash vectors are deterministic, 256-dim, and unit-normalized", async () => {
    delete process.env.OLLAMA_HOST;

    const first = await embedText("alpha beta gamma");
    const second = await embedText("alpha beta gamma");

    expect(first).toEqual(second);
    expect(first).toHaveLength(256);

    const magnitude = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 6);
  });

  test("embedBatchWithMetadata reports the keyword-hash fallback honestly", async () => {
    delete process.env.OLLAMA_HOST;

    const { embeddings, metadata } = await embedBatchWithMetadata(["alpha beta", "gamma"]);

    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toHaveLength(256);
    expect(metadata).toMatchObject({
      provider: "fallback",
      model: "fallback-hash-v1",
      dimensions: 256,
    });
  });
});
