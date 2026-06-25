/**
 * Unit tests for Google ID-token claim validation (bug B5).
 * Imports the REAL validateGoogleClaims so this can't drift from the
 * production verifyGoogleJWT path. Runs with `bun test` — no Worker runtime.
 */
import { describe, it, expect } from "bun:test";
import {
  validateGoogleClaims,
  GOOGLE_ISSUERS,
  type GoogleClaims,
} from "../src/google-auth.js";

const AUD = "1234.apps.googleusercontent.com";
const NOW = 1_700_000_000; // fixed reference time (seconds)

function claims(overrides: Partial<GoogleClaims> = {}): GoogleClaims {
  return {
    email: "user@example.com",
    email_verified: true,
    iss: "https://accounts.google.com",
    aud: AUD,
    exp: NOW + 3600,
    sub: "10769150350006150715113082367",
    ...overrides,
  };
}

describe("validateGoogleClaims — email_verified (B5)", () => {
  it("accepts a fully valid token with email_verified === true", () => {
    const r = validateGoogleClaims(claims(), AUD, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email).toBe("user@example.com");
  });

  it("REJECTS when email_verified === false (account-takeover guard)", () => {
    const r = validateGoogleClaims(claims({ email_verified: false }), AUD, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("email_unverified");
  });

  it("REJECTS when email_verified is absent", () => {
    const r = validateGoogleClaims(claims({ email_verified: undefined }), AUD, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("email_unverified");
  });

  it("does NOT coerce a truthy non-boolean email_verified", () => {
    // A token with email_verified: "true" (string) must not be trusted.
    const r = validateGoogleClaims(
      claims({ email_verified: "true" as unknown as boolean }),
      AUD,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("email_unverified");
  });
});

describe("validateGoogleClaims — iss / aud / exp (RFC 8725)", () => {
  it("rejects an expired token", () => {
    const r = validateGoogleClaims(claims({ exp: NOW - 1 }), AUD, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejects a token minted for a different audience", () => {
    const r = validateGoogleClaims(claims({ aud: "other-client" }), AUD, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("aud_mismatch");
  });

  it("rejects a non-Google issuer", () => {
    const r = validateGoogleClaims(claims({ iss: "https://evil.example.com" }), AUD, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("iss_mismatch");
  });

  it("accepts both Google issuer spellings", () => {
    for (const iss of GOOGLE_ISSUERS) {
      const r = validateGoogleClaims(claims({ iss }), AUD, NOW);
      expect(r.ok).toBe(true);
    }
  });

  it("rejects a token with a missing email", () => {
    const r = validateGoogleClaims(claims({ email: "" }), AUD, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_email");
  });

  it("rejects a non-numeric exp", () => {
    const r = validateGoogleClaims(
      claims({ exp: "soon" as unknown as number }),
      AUD,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });
});
