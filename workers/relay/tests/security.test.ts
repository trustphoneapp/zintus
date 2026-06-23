/**
 * Unit tests for relay security helpers.
 * Runs with `bun test` — no Worker runtime required.
 */
import { describe, it, expect } from "bun:test";

// ── validateRedirectTo (copy of production impl) ──────────────────────────

const ALLOWED_REDIRECT_ORIGINS = [
  "https://www.zintus.ai",
  "https://zintus.ai",
  "http://localhost:3000",
  "http://localhost:3001",
];

function validateRedirectTo(url: string | null | undefined): string {
  const DEFAULT = "https://www.zintus.ai/dashboard";
  if (!url) return DEFAULT;
  try {
    const parsed = new URL(url);
    return ALLOWED_REDIRECT_ORIGINS.some(
      (a) => parsed.origin === new URL(a).origin,
    )
      ? url
      : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

// ── CORS origin check (copy of production logic) ───────────────────────────

const ALLOWED_ORIGINS = [
  "https://www.zintus.ai",
  "https://zintus.ai",
  "https://relay.zintus.ai",
  "https://zintus-relay.yashwanth-surabhi.workers.dev",
  "http://localhost:3000",
  "http://localhost:3001",
];

function corsOrigin(origin: string | null): string {
  return origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]!;
}

// ── decodeBase64url (copy of production impl) ─────────────────────────────

function decodeBase64url(str: string): string {
  return atob(
    str
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(str.length / 4) * 4, "="),
  );
}

// ── validateRedirectTo tests ──────────────────────────────────────────────

describe("validateRedirectTo", () => {
  it("allows paths on www.zintus.ai", () => {
    expect(validateRedirectTo("https://www.zintus.ai/dashboard")).toBe(
      "https://www.zintus.ai/dashboard",
    );
  });

  it("allows root zintus.ai", () => {
    expect(validateRedirectTo("https://zintus.ai/pricing")).toBe(
      "https://zintus.ai/pricing",
    );
  });

  it("allows localhost:3000", () => {
    expect(validateRedirectTo("http://localhost:3000/dashboard")).toBe(
      "http://localhost:3000/dashboard",
    );
  });

  it("allows localhost:3001", () => {
    expect(validateRedirectTo("http://localhost:3001/callback")).toBe(
      "http://localhost:3001/callback",
    );
  });

  it("blocks arbitrary external URLs", () => {
    expect(validateRedirectTo("https://evil.example.com/steal")).toBe(
      "https://www.zintus.ai/dashboard",
    );
  });

  it("blocks javascript: URLs", () => {
    expect(validateRedirectTo("javascript:alert(1)")).toBe(
      "https://www.zintus.ai/dashboard",
    );
  });

  it("blocks null", () => {
    expect(validateRedirectTo(null)).toBe("https://www.zintus.ai/dashboard");
  });

  it("blocks undefined", () => {
    expect(validateRedirectTo(undefined)).toBe(
      "https://www.zintus.ai/dashboard",
    );
  });

  it("blocks empty string", () => {
    expect(validateRedirectTo("")).toBe("https://www.zintus.ai/dashboard");
  });

  it("blocks malformed URLs", () => {
    expect(validateRedirectTo("not a url")).toBe(
      "https://www.zintus.ai/dashboard",
    );
  });

  it("blocks open redirects that look like allowed origins", () => {
    // e.g. http://zintus.ai.evil.com — different origin
    expect(validateRedirectTo("https://zintus.ai.evil.com/phish")).toBe(
      "https://www.zintus.ai/dashboard",
    );
  });

  it("blocks port-shifted localhost", () => {
    expect(validateRedirectTo("http://localhost:9999/exploit")).toBe(
      "https://www.zintus.ai/dashboard",
    );
  });
});

// ── CORS origin allowlist tests ───────────────────────────────────────────

describe("corsOrigin", () => {
  it("echoes allowed origins back", () => {
    for (const origin of ALLOWED_ORIGINS) {
      expect(corsOrigin(origin)).toBe(origin);
    }
  });

  it("falls back to first allowed origin for unknown origins", () => {
    expect(corsOrigin("https://evil.com")).toBe(ALLOWED_ORIGINS[0]);
  });

  it("falls back for null origin (no-CORS request)", () => {
    expect(corsOrigin(null)).toBe(ALLOWED_ORIGINS[0]);
  });

  it("does not allow subdomain attacks", () => {
    expect(corsOrigin("https://relay.zintus.ai.evil.com")).toBe(
      ALLOWED_ORIGINS[0],
    );
  });

  it("is case-sensitive (no folding)", () => {
    // Origin headers are case-sensitive
    expect(corsOrigin("https://WWW.ZINTUS.AI")).toBe(ALLOWED_ORIGINS[0]);
  });
});

// ── decodeBase64url tests ─────────────────────────────────────────────────

describe("decodeBase64url", () => {
  it("decodes standard base64url without padding", () => {
    // "hello" in base64url = "aGVsbG8"
    expect(decodeBase64url("aGVsbG8")).toBe("hello");
  });

  it("handles + and / substitutions correctly", () => {
    // base64url uses - and _ instead of + and /
    const encoded = btoa("foo>bar").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const decoded = decodeBase64url(encoded);
    expect(decoded).toBe("foo>bar");
  });

  it("handles strings requiring 1 padding char", () => {
    // length % 4 == 3 → need 1 =
    const str = "ab";  // btoa("ab") = "YWI=" (length 4), base64url = "YWI" (length 3)
    const urlEncoded = btoa(str).replace(/=/g, "");
    expect(decodeBase64url(urlEncoded)).toBe(str);
  });

  it("handles strings requiring 2 padding chars", () => {
    // length % 4 == 2 → need 2 ==
    const str = "a";   // btoa("a") = "YQ==" (length 4), base64url = "YQ" (length 2)
    const urlEncoded = btoa(str).replace(/=/g, "");
    expect(decodeBase64url(urlEncoded)).toBe(str);
  });

  it("does not throw on non-padded JWT segment lengths", () => {
    // Simulate a real JWT claim segment (variable length, no padding)
    const payload = JSON.stringify({ sub: "1234567890", iat: 1516239022 });
    const encoded = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const decoded = decodeBase64url(encoded);
    expect(JSON.parse(decoded)).toEqual({ sub: "1234567890", iat: 1516239022 });
  });
});
