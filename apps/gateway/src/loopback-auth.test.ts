import { describe, expect, test } from "bun:test";
import { LoopbackAuthority, bearerCredential } from "./loopback-auth.js";

const ORIGIN = "https://www.zintus.ai";
const OTHER = "http://localhost:3000";

/** Drive a full happy-path handshake and return the minted session token. */
function handshake(
  authority: LoopbackAuthority,
  origin: string,
  now = 1_000,
): string {
  const { challenge } = authority.issueChallenge(now);
  const proof = authority.proofFor(challenge);
  const minted = authority.redeem({ challenge, proof, origin }, now);
  if (!minted) throw new Error("expected a minted session token");
  return minted.token;
}

describe("LoopbackAuthority — enterprise loopback handshake", () => {
  test("hasBootstrapSecret reflects a non-empty secret", () => {
    expect(
      new LoopbackAuthority({ bootstrapSecret: "" }).hasBootstrapSecret(),
    ).toBe(false);
    expect(
      new LoopbackAuthority({ bootstrapSecret: "s3cr3t" }).hasBootstrapSecret(),
    ).toBe(true);
  });

  // Test 1 — origin alone (no session token) is NOT trusted. This is the whole
  // point: before the fix an allowlisted Origin was accepted with no credential.
  test("origin-only (no session token) is rejected", () => {
    const authority = new LoopbackAuthority({ bootstrapSecret: "secret" });
    expect(authority.verify(null, ORIGIN)).toBe(false);
    expect(authority.verify("", ORIGIN)).toBe(false);
    expect(authority.verify("not-a-real-token", ORIGIN)).toBe(false);
  });

  // Test 5 (happy path) — a valid handshake mints a token that IS accepted.
  test("a valid challenge+proof mints an origin-bound token that verifies", () => {
    const authority = new LoopbackAuthority({ bootstrapSecret: "secret" });
    const token = handshake(authority, ORIGIN, 1_000);
    expect(authority.verify(token, ORIGIN, 2_000)).toBe(true);
  });

  // Replay of the handshake itself (same challenge) is rejected: the nonce is
  // single-use, burned on first redeem attempt.
  test("replaying a challenge (single-use nonce) is rejected", () => {
    const authority = new LoopbackAuthority({ bootstrapSecret: "secret" });
    const { challenge } = authority.issueChallenge(1_000);
    const proof = authority.proofFor(challenge);
    const first = authority.redeem({ challenge, proof, origin: ORIGIN }, 1_000);
    expect(first).not.toBeNull();
    // Same challenge + valid proof again → nonce already consumed → null.
    const replay = authority.redeem({ challenge, proof, origin: ORIGIN }, 1_000);
    expect(replay).toBeNull();
  });

  // Test 2 (forged proof) — a wrong proof burns the nonce (no brute force) and
  // mints nothing.
  test("a wrong proof is rejected and burns the challenge", () => {
    const authority = new LoopbackAuthority({ bootstrapSecret: "secret" });
    const { challenge } = authority.issueChallenge(1_000);
    const bad = authority.redeem(
      { challenge, proof: "deadbeef", origin: ORIGIN },
      1_000,
    );
    expect(bad).toBeNull();
    // Even the correct proof now fails — the nonce was consumed by the attempt.
    const proof = authority.proofFor(challenge);
    const retry = authority.redeem({ challenge, proof, origin: ORIGIN }, 1_000);
    expect(retry).toBeNull();
  });

  // A compromised remote origin without the secret cannot compute a valid proof.
  test("a proof from the wrong bootstrap secret is rejected", () => {
    const authority = new LoopbackAuthority({ bootstrapSecret: "real-secret" });
    const attacker = new LoopbackAuthority({
      bootstrapSecret: "guessed-secret",
    });
    const { challenge } = authority.issueChallenge(1_000);
    const forgedProof = attacker.proofFor(challenge);
    const minted = authority.redeem(
      { challenge, proof: forgedProof, origin: ORIGIN },
      1_000,
    );
    expect(minted).toBeNull();
  });

  // Test 3 (expired) — an expired session token is rejected.
  test("an expired session token is rejected", () => {
    const authority = new LoopbackAuthority({
      bootstrapSecret: "secret",
      sessionTtlMs: 1_000,
    });
    const token = handshake(authority, ORIGIN, 1_000);
    expect(authority.verify(token, ORIGIN, 1_500)).toBe(true);
    expect(authority.verify(token, ORIGIN, 2_001)).toBe(false);
  });

  // Test 4 (origin-binding) — a token minted for one origin is rejected from
  // another.
  test("a token replayed from a different origin is rejected", () => {
    const authority = new LoopbackAuthority({ bootstrapSecret: "secret" });
    const token = handshake(authority, ORIGIN, 1_000);
    expect(authority.verify(token, OTHER, 2_000)).toBe(false);
    expect(authority.verify(token, ORIGIN, 2_000)).toBe(true);
  });

  test("an expired challenge cannot be redeemed", () => {
    const authority = new LoopbackAuthority({
      bootstrapSecret: "secret",
      challengeTtlMs: 1_000,
    });
    const { challenge } = authority.issueChallenge(1_000);
    const proof = authority.proofFor(challenge);
    const minted = authority.redeem({ challenge, proof, origin: ORIGIN }, 2_500);
    expect(minted).toBeNull();
  });

  test("redeem requires an origin binding", () => {
    const authority = new LoopbackAuthority({ bootstrapSecret: "secret" });
    const { challenge } = authority.issueChallenge(1_000);
    const proof = authority.proofFor(challenge);
    expect(
      authority.redeem({ challenge, proof, origin: null }, 1_000),
    ).toBeNull();
  });

  test("an unknown / empty challenge is rejected", () => {
    const authority = new LoopbackAuthority({ bootstrapSecret: "secret" });
    expect(
      authority.redeem({ challenge: "", proof: "x", origin: ORIGIN }, 1_000),
    ).toBeNull();
    expect(
      authority.redeem(
        { challenge: "never-issued", proof: "x", origin: ORIGIN },
        1_000,
      ),
    ).toBeNull();
  });

  test("an authority with no bootstrap secret never mints", () => {
    const authority = new LoopbackAuthority({ bootstrapSecret: "" });
    const { challenge } = authority.issueChallenge(1_000);
    // proofFor with an empty key still produces a string, but redeem short-circuits.
    const proof = authority.proofFor(challenge);
    expect(
      authority.redeem({ challenge, proof, origin: ORIGIN }, 1_000),
    ).toBeNull();
  });
});

describe("bearerCredential", () => {
  test("extracts a bearer value or null", () => {
    expect(bearerCredential("Bearer abc123")).toBe("abc123");
    expect(bearerCredential("Bearer ")).toBeNull();
    expect(bearerCredential("abc123")).toBeNull();
    expect(bearerCredential(null)).toBeNull();
  });
});
