import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueLocalGatewayHandshakeProof } from "./broker.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function request(challenge = "a".repeat(64), origin = "http://localhost:3000", host?: string): Request {
  return new Request("http://localhost:3000/api/local-gateway/handshake-proof", {
    method: "POST",
    headers: { Origin: origin, ...(host ? { Host: host } : {}), "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ challenge }),
  });
}

describe("local gateway handshake proof broker", () => {
  test("returns only a challenge-bound proof for an owner-controlled live authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-proof-")); roots.push(root);
    const path = join(root, "gateway-session.json");
    const secret = "s".repeat(64);
    writeFileSync(path, JSON.stringify({ handshakeSecret: secret, pid: 123 }), { mode: 0o600 });
    const response = await issueLocalGatewayHandshakeProof(request(), {
      secretFile: path, currentUid: process.getuid?.(), processAlive: (pid) => pid === 123,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      proof: createHmac("sha256", secret).update("a".repeat(64)).digest("hex"),
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("rejects cross-origin, non-loopback, malformed, permissive, and stale requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "zintus-proof-")); roots.push(root);
    const path = join(root, "gateway-session.json");
    writeFileSync(path, JSON.stringify({ handshakeSecret: "s".repeat(64), pid: 123 }), { mode: 0o600 });
    const options = { secretFile: path, currentUid: process.getuid?.(), processAlive: () => true };
    expect((await issueLocalGatewayHandshakeProof(request("a".repeat(64), "https://evil.example"), options)).status).toBe(403);
    expect((await issueLocalGatewayHandshakeProof(request("a".repeat(64), "http://127.0.0.1:3000", "localhost:3000"), options)).status).toBe(403);
    expect((await issueLocalGatewayHandshakeProof(request("not-a-challenge"), options)).status).toBe(400);
    chmodSync(path, 0o644);
    expect((await issueLocalGatewayHandshakeProof(request(), options)).status).toBe(503);
    chmodSync(path, 0o600);
    expect((await issueLocalGatewayHandshakeProof(request(), { ...options, processAlive: () => false })).status).toBe(503);
  });
});
