import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// P7 Resolution Desk directive-signing authority (owner-only local secret).
//
// The desk signs directives with a gateway-held HMAC key. Like the hardening
// prompt-cache secret, this material is confined to the gateway process and is
// loaded from an owner-only (chmod 600) file — NEVER passed into a model or
// sandbox context. There is no durable descriptor to re-validate (the secret is
// used only at sign time; a rotated secret simply invalidates in-flight, short
// TTL directives), so this loader is a focused owner-only read-or-create.
// ---------------------------------------------------------------------------

const KEY_IDENTITY_NAMESPACE = "engineer-resolution-directive-signing-key-identity-v1\0" as const;

export type EngineerResolutionSigningAuthority =
  | { status: "READY"; secret: string; keyId: string; secretPath: string }
  | { status: "UNAVAILABLE"; secret: undefined; keyId: undefined; secretPath: string; detail: string };

function keyIdFor(secret: string): string {
  return `sha256:${createHash("sha256").update(KEY_IDENTITY_NAMESPACE).update(secret).digest("hex")}`;
}

function readOwnerOnly(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* invalid authority remains unavailable */ }
  }
}

function readSecret(path: string): string | null {
  const bytes = readOwnerOnly(path);
  if (bytes === null) return null;
  const value = bytes.trim();
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function directoryOwnerOnly(path: string): boolean {
  const directory = dirname(path);
  if (!existsSync(directory)) return true;
  let fd: number | null = null;
  try {
    fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    return stat.isDirectory() && (process.getuid === undefined || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* fail closed */ }
  }
}

function writeOwnerOnly(path: string, value: string): boolean {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let fd: number | null = null, linked = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, value, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try { linkSync(temporary, path); linked = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (linked) {
      let dirFd: number | null = null;
      try { dirFd = openSync(directory, constants.O_RDONLY); fsyncSync(dirFd); } finally { if (dirFd !== null) closeSync(dirFd); }
    }
    return linked;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* cleanup below */ }
    try { unlinkSync(temporary); } catch { /* already absent */ }
  }
}

function loadUnsafe(secretPath: string): EngineerResolutionSigningAuthority {
  if (!directoryOwnerOnly(secretPath)) {
    return { status: "UNAVAILABLE", secret: undefined, keyId: undefined, secretPath, detail: "Resolution signing authority directory must be owner-only (chmod 700)" };
  }
  let secret = existsSync(secretPath) ? readSecret(secretPath) : null;
  if (existsSync(secretPath) && !secret) {
    return { status: "UNAVAILABLE", secret: undefined, keyId: undefined, secretPath, detail: "Resolution signing secret is not a valid owner-only 256-bit secret" };
  }
  if (!secret) {
    const generated = randomBytes(32).toString("hex");
    secret = writeOwnerOnly(secretPath, `${generated}\n`) ? generated : readSecret(secretPath);
    if (!secret) {
      return { status: "UNAVAILABLE", secret: undefined, keyId: undefined, secretPath, detail: "Resolution signing secret creation raced with invalid local authority" };
    }
  }
  return { status: "READY", secret, keyId: keyIdFor(secret), secretPath };
}

/** Load (or first-run create) the owner-only resolution directive-signing secret. */
export function loadEngineerResolutionSigningAuthority(input: { secretPath: string }): EngineerResolutionSigningAuthority {
  try {
    return loadUnsafe(input.secretPath);
  } catch {
    return { status: "UNAVAILABLE", secret: undefined, keyId: undefined, secretPath: input.secretPath, detail: "Resolution signing authority could not be initialized safely; verify owner-only permissions and restart the gateway" };
  }
}
