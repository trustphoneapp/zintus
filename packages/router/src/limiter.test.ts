import { afterEach, describe, expect, test } from "bun:test";
import { LocalRateLimiter, ZintusRateLimitError, globalLimiter } from "./limiter.js";

// ACTUAL API (limiter.ts) — differs from a typical token-bucket:
//   new LocalRateLimiter()    // no constructor args
//   acquire(): void           // THROWS ZintusRateLimitError when over a limit
//   release(): void           // frees one concurrency slot
// Hardcoded module constants: MAX_PER_MINUTE = 60, MAX_CONCURRENT = 10,
// WINDOW_MS = 60_000. It is a single process-wide limiter (no per-key/per-user).

const MAX_CONCURRENT = 10;
const MAX_PER_MINUTE = 60;

describe("LocalRateLimiter — concurrency cap", () => {
  test("allows up to MAX_CONCURRENT simultaneous acquires", () => {
    const l = new LocalRateLimiter();
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      expect(() => l.acquire()).not.toThrow();
    }
  });

  test("the (MAX_CONCURRENT+1)th unreleased acquire throws ZintusRateLimitError", () => {
    const l = new LocalRateLimiter();
    for (let i = 0; i < MAX_CONCURRENT; i++) l.acquire();
    expect(() => l.acquire()).toThrow(ZintusRateLimitError);
  });

  test("release() frees a concurrency slot", () => {
    const l = new LocalRateLimiter();
    for (let i = 0; i < MAX_CONCURRENT; i++) l.acquire();
    expect(() => l.acquire()).toThrow(); // at the cap
    l.release();
    expect(() => l.acquire()).not.toThrow(); // slot freed
  });
});

describe("LocalRateLimiter — per-minute cap", () => {
  test("the 61st request within the window throws (even with releases)", () => {
    const realNow = Date.now;
    try {
      let t = 1_000_000;
      Date.now = () => t;
      const l = new LocalRateLimiter();
      // acquire+release 60x: releases keep concurrency at 0, but 60 timestamps
      // accumulate inside the window.
      for (let i = 0; i < MAX_PER_MINUTE; i++) {
        l.acquire();
        l.release();
      }
      expect(() => l.acquire()).toThrow(ZintusRateLimitError);
    } finally {
      Date.now = realNow;
    }
  });

  test("the window slides: capacity returns after WINDOW_MS", () => {
    const realNow = Date.now;
    try {
      let t = 1_000_000;
      Date.now = () => t;
      const l = new LocalRateLimiter();
      for (let i = 0; i < MAX_PER_MINUTE; i++) {
        l.acquire();
        l.release();
      }
      expect(() => l.acquire()).toThrow(); // window full
      t += 60_001; // advance past WINDOW_MS — old timestamps age out
      expect(() => l.acquire()).not.toThrow();
    } finally {
      Date.now = realNow;
    }
  });

  test("ZintusRateLimitError carries an actionable message", () => {
    const l = new LocalRateLimiter();
    for (let i = 0; i < MAX_CONCURRENT; i++) l.acquire();
    try {
      l.acquire();
      throw new Error("expected acquire to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZintusRateLimitError);
      expect((err as Error).message).toMatch(/limit/i);
    }
  });
});

describe("globalLimiter singleton", () => {
  // Keep the shared instance clean for any other consumers in this process.
  afterEach(() => {
    for (let i = 0; i < MAX_CONCURRENT; i++) globalLimiter.release();
  });

  test("is a usable LocalRateLimiter instance", () => {
    expect(globalLimiter).toBeInstanceOf(LocalRateLimiter);
    expect(typeof globalLimiter.acquire).toBe("function");
    expect(typeof globalLimiter.release).toBe("function");
  });

  test("acquire then release round-trips on the singleton", () => {
    expect(() => {
      globalLimiter.acquire();
      globalLimiter.release();
    }).not.toThrow();
  });
});
