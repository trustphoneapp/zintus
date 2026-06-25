// Google ID-token claim validation, extracted from index.ts so the relay's
// auth tests exercise the REAL implementation (no hand-copied drift). The
// signature/JWKS verification stays in index.ts (it does network I/O); this
// module is the pure, side-effect-free claim check that runs AFTER the
// signature is proven valid.
//
// Checks follow Google's "verify the ID token on your server" guidance and
// RFC 8725 (JWT BCP): pin issuer, audience, expiry, and require a verified
// email before trusting it as an account identity.
//   https://developers.google.com/identity/gsi/web/guides/verify-google-id-token

export interface GoogleClaims {
  email: string;
  email_verified?: boolean;
  iss: string;
  aud: string;
  exp: number;
  sub: string;
}

/** Accepted `iss` values for Google-issued ID tokens. */
export const GOOGLE_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
] as const;

export type GoogleClaimResult =
  | { ok: true; email: string }
  | { ok: false; reason: string };

/**
 * Validate the claims of an already signature-verified Google ID token.
 *
 *  - `exp`  must be a number and not in the past (replay/expiry guard)
 *  - `aud`  must equal our OAuth client id (token not minted for another app)
 *  - `iss`  must be a Google issuer
 *  - `email` must be present AND `email_verified === true`
 *
 * The `email_verified` check is the account-takeover guard: Google will mint a
 * valid, correctly-signed ID token for an account whose email it has NOT
 * verified (e.g. a freshly-created account using someone else's address). Since
 * the relay keys user identity on `email`, accepting an unverified email lets an
 * attacker sign in as the legitimate owner of that address. Reject it.
 */
export function validateGoogleClaims(
  claims: GoogleClaims,
  expectedAud: string,
  nowSecs: number,
): GoogleClaimResult {
  if (typeof claims.exp !== "number" || claims.exp < nowSecs) {
    return { ok: false, reason: "expired" };
  }
  if (claims.aud !== expectedAud) {
    return { ok: false, reason: "aud_mismatch" };
  }
  if (!(GOOGLE_ISSUERS as readonly string[]).includes(claims.iss)) {
    return { ok: false, reason: "iss_mismatch" };
  }
  if (!claims.email) {
    return { ok: false, reason: "missing_email" };
  }
  // Strict boolean true — never coerce a string "true" or a truthy value.
  if (claims.email_verified !== true) {
    return { ok: false, reason: "email_unverified" };
  }
  return { ok: true, email: claims.email };
}
