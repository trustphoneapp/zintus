/**
 * Unit tests for relay auth helpers.
 * Runs with `bun test` — no Worker runtime required.
 */
import { describe, it, expect } from "bun:test";
// Import the REAL sha256Hex so this test can't silently drift from production.
import { sha256Hex } from "../src/auth.js";

// ── Pure helpers we can test without the KV/D1 runtime ────────────────────

/** Timing-safe comparison (copy of production fix). */
async function timingSafeEq(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i]! ^ bb[i]!;
  }
  return diff === 0;
}

/** Cookie builder (inline for isolation). */
function buildSessionCookie(token: string, cookieDomain: string): string {
  return [
    `zintus_session=${token}`,
    `Max-Age=${60 * 60 * 24 * 30}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    ...(cookieDomain ? [`Domain=${cookieDomain}`] : []),
  ].join("; ");
}

function clearSessionCookie(cookieDomain: string): string {
  return [
    "zintus_session=",
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    ...(cookieDomain ? [`Domain=${cookieDomain}`] : []),
  ].join("; ");
}

function parseSessionCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name?.trim() === "zintus_session") {
      return rest.join("=").trim() || null;
    }
  }
  return null;
}

// ── sha256Hex ─────────────────────────────────────────────────────────────

describe("sha256Hex", () => {
  it("produces a 64-char lowercase hex string", async () => {
    const h = await sha256Hex("hello");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", async () => {
    const a = await sha256Hex("test-value");
    const b = await sha256Hex("test-value");
    expect(a).toBe(b);
  });

  it("differs for different inputs", async () => {
    const a = await sha256Hex("foo");
    const b = await sha256Hex("bar");
    expect(a).not.toBe(b);
  });

  it("matches known SHA-256 vector", async () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const h = await sha256Hex("");
    expect(h).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

// ── timingSafeEq ──────────────────────────────────────────────────────────

describe("timingSafeEq", () => {
  it("returns true for equal strings", async () => {
    expect(await timingSafeEq("abc", "abc")).toBe(true);
  });

  it("returns false for different strings of same length", async () => {
    expect(await timingSafeEq("abc", "abd")).toBe(false);
  });

  it("returns false for different-length strings", async () => {
    expect(await timingSafeEq("abc", "abcd")).toBe(false);
  });

  it("returns true for empty strings", async () => {
    expect(await timingSafeEq("", "")).toBe(true);
  });

  it("works with hex hashes", async () => {
    const h = await sha256Hex("secret-key");
    expect(await timingSafeEq(h, h)).toBe(true);
    const h2 = await sha256Hex("different-key");
    expect(await timingSafeEq(h, h2)).toBe(false);
  });
});

// ── Cookie helpers ────────────────────────────────────────────────────────

describe("buildSessionCookie", () => {
  it("sets SameSite=Lax (not None)", () => {
    const c = buildSessionCookie("tok", ".zintus.ai");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("SameSite=None");
  });

  it("includes the token value", () => {
    const c = buildSessionCookie("my-token", ".zintus.ai");
    expect(c).toContain("zintus_session=my-token");
  });

  it("includes domain when provided", () => {
    const c = buildSessionCookie("tok", ".zintus.ai");
    expect(c).toContain("Domain=.zintus.ai");
  });

  it("omits domain when empty string", () => {
    const c = buildSessionCookie("tok", "");
    expect(c).not.toContain("Domain=");
  });

  it("sets HttpOnly", () => {
    const c = buildSessionCookie("tok", "");
    expect(c).toContain("HttpOnly");
  });

  it("sets Secure", () => {
    const c = buildSessionCookie("tok", "");
    expect(c).toContain("Secure");
  });
});

describe("clearSessionCookie", () => {
  it("sets Max-Age=0", () => {
    const c = clearSessionCookie(".zintus.ai");
    expect(c).toContain("Max-Age=0");
  });

  it("sets SameSite=Lax (not None)", () => {
    const c = clearSessionCookie(".zintus.ai");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("SameSite=None");
  });

  it("clears the token value", () => {
    const c = clearSessionCookie(".zintus.ai");
    expect(c).toContain("zintus_session=;");
  });
});

describe("parseSessionCookie", () => {
  it("extracts the session token", () => {
    const result = parseSessionCookie("zintus_session=abc123; Path=/");
    expect(result).toBe("abc123");
  });

  it("returns null for missing cookie", () => {
    expect(parseSessionCookie(null)).toBeNull();
  });

  it("returns null when zintus_session not in header", () => {
    expect(parseSessionCookie("other_cookie=foo")).toBeNull();
  });

  it("handles multiple cookies", () => {
    const result = parseSessionCookie("foo=bar; zintus_session=my-tok; baz=qux");
    expect(result).toBe("my-tok");
  });

  it("returns null for empty token value", () => {
    // Max-Age=0 cookie has empty value
    const result = parseSessionCookie("zintus_session=; Max-Age=0");
    expect(result).toBeNull();
  });

  it("handles token values containing = (base64)", () => {
    const result = parseSessionCookie("zintus_session=abc=def==");
    expect(result).toBe("abc=def==");
  });
});
