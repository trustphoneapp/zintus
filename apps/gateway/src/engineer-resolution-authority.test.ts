import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEngineerResolutionSigningAuthority } from "./engineer-resolution-authority.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function root(tag: string) { const value = mkdtempSync(join(tmpdir(), `zintus-resolution-authority-${tag}-`)); roots.push(value); return value; }

describe("engineer resolution signing authority", () => {
  test("first run creates an owner-only 256-bit secret and a stable keyId", () => {
    const secretPath = join(root("create"), "signing.secret");
    const first = loadEngineerResolutionSigningAuthority({ secretPath });
    expect(first.status).toBe("READY");
    if (first.status !== "READY") throw new Error("unreachable");
    expect(first.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(first.keyId).toMatch(/^sha256:[a-f0-9]{64}$/);
    // File is chmod 600 (owner-only).
    expect(statSync(secretPath).mode & 0o077).toBe(0);
    // Reload is deterministic: same secret, same keyId.
    const second = loadEngineerResolutionSigningAuthority({ secretPath });
    if (second.status !== "READY") throw new Error("unreachable");
    expect(second.secret).toBe(first.secret);
    expect(second.keyId).toBe(first.keyId);
  });

  test("a malformed secret is UNAVAILABLE (never a wrong signing key)", () => {
    const secretPath = join(root("bad"), "signing.secret");
    writeFileSync(secretPath, "not-a-valid-secret\n", { mode: 0o600 });
    chmodSync(secretPath, 0o600);
    const result = loadEngineerResolutionSigningAuthority({ secretPath });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.secret).toBeUndefined();
  });

  test("a group/world-readable secret is refused", () => {
    const secretPath = join(root("perm"), "signing.secret");
    writeFileSync(secretPath, `${"a".repeat(64)}\n`, { mode: 0o644 });
    chmodSync(secretPath, 0o644);
    const result = loadEngineerResolutionSigningAuthority({ secretPath });
    expect(result.status).toBe("UNAVAILABLE");
    // The valid material is not surfaced from an unsafe-permission file.
    expect(readFileSync(secretPath, "utf8").trim()).toBe("a".repeat(64));
  });
});
