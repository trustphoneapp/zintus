import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { establishLoopbackAuthority } from "./index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("loopback handshake session authority", () => {
  test("atomically replaces a stale session file even when the bootstrap secret is injected", () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-handshake-session-"));
    roots.push(root);
    const secretFile = join(root, "gateway-session.json");
    writeFileSync(secretFile, JSON.stringify({ handshakeSecret: "old".repeat(22), pid: 1 }), { mode: 0o600 });
    const injectedSecret = "a".repeat(64);
    const authority = establishLoopbackAuthority(() => undefined, { injectedSecret, secretFile });

    const stored = JSON.parse(readFileSync(secretFile, "utf8")) as { handshakeSecret: string; pid: number };
    expect(stored.pid).toBe(process.pid);
    expect(stored.handshakeSecret).toHaveLength(64);
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);

    const { challenge } = authority.issueChallenge(1_000);
    const proofFromStoredAuthority = createHmac("sha256", stored.handshakeSecret).update(challenge).digest("hex");
    expect(authority.redeem({ challenge, proof: proofFromStoredAuthority, origin: "http://localhost:3000" }, 1_000)).not.toBeNull();
  });
});
