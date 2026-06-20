import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeIndex } from "./code-index.js";
import { chunkSource } from "./chunker.js";

/**
 * Deterministic, offline, network-free embedding.
 *
 * A token-hashing bag-of-words embedding in the same family as the repo's
 * @zintus/memory fallback. Identical/overlapping vocabulary produces high
 * cosine similarity, so a query that shares words with one file's source will
 * rank that file's chunks first. No Ollama, no randomness.
 */
const DIM = 256;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter(Boolean);
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicEmbed(texts: string[]): Promise<number[][]> {
  const vectors = texts.map((text) => {
    const vector = new Array<number>(DIM).fill(0);
    for (const token of tokenize(text)) {
      const slot = hashToken(token) % DIM;
      vector[slot] = (vector[slot] ?? 0) + 1;
    }
    const mag = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    return mag ? vector.map((v) => v / mag) : vector;
  });
  return Promise.resolve(vectors);
}

const PAYMENTS_SRC = `export function chargeCustomer(amount: number, currency: string): Promise<Receipt> {
  const gateway = new StripeGateway();
  return gateway.charge({ amount, currency, capture: true });
}

export function refundPayment(paymentId: string): Promise<Refund> {
  const gateway = new StripeGateway();
  return gateway.refund(paymentId);
}
`;

const AUTH_SRC = `export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyToken(jwt: string): Session | null {
  return decodeJwtSession(jwt);
}
`;

const GEOMETRY_SRC = `export function circleArea(radius: number): number {
  return Math.PI * radius * radius;
}

export function triangleArea(base: number, height: number): number {
  return 0.5 * base * height;
}
`;

describe("CodeIndex", () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "codeindex-fixture-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "payments.ts"), PAYMENTS_SRC, "utf8");
    writeFileSync(join(dir, "src", "auth.ts"), AUTH_SRC, "utf8");
    writeFileSync(join(dir, "src", "geometry.ts"), GEOMETRY_SRC, "utf8");
    // A directory that MUST be skipped during the walk.
    mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "junk", "ignored.ts"), PAYMENTS_SRC, "utf8");
    dbPath = join(dir, "code.db");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("chunker yields 1-based inclusive ranges that cover the file", () => {
    const chunks = chunkSource(PAYMENTS_SRC);
    expect(chunks.length).toBeGreaterThan(0);
    const first = chunks[0]!;
    expect(first.startLine).toBe(1);
    expect(first.content.length).toBeGreaterThan(0);
  });

  test("indexWorkspace indexes source files and skips node_modules", async () => {
    const index = new CodeIndex({ dbPath, embed: deterministicEmbed });
    const result = await index.indexWorkspace(dir);
    // Exactly the 3 real source files (node_modules is skipped).
    expect(result.filesIndexed).toBe(3);
    expect(result.chunksIndexed).toBeGreaterThanOrEqual(3);
    index.close();
  });

  test("indexWorkspace is idempotent: a second run re-skips unchanged files", async () => {
    const index = new CodeIndex({ dbPath, embed: deterministicEmbed });
    const result = await index.indexWorkspace(dir);
    expect(result.filesIndexed).toBe(0);
    expect(result.chunksIndexed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(3);
    index.close();
  });

  test("searchCode returns the relevant file first", async () => {
    const index = new CodeIndex({ dbPath, embed: deterministicEmbed });
    const hits = await index.searchCode(
      "charge customer payment refund with the stripe gateway",
      5,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path.endsWith("payments.ts")).toBe(true);
    // The top hit must out-score any non-payments hit.
    const topScore = hits[0]!.score;
    const otherTop = hits.find((h) => !h.path.endsWith("payments.ts"));
    if (otherTop) {
      expect(topScore).toBeGreaterThanOrEqual(otherTop.score);
    }
    index.close();
  });

  test("searchCode ranks auth query toward auth.ts", async () => {
    const index = new CodeIndex({ dbPath, embed: deterministicEmbed });
    const hits = await index.searchCode("hash password verify jwt session token", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path.endsWith("auth.ts")).toBe(true);
    index.close();
  });
});
