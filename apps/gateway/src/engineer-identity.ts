import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface EngineerPrincipal {
  ownerId: string;
  reviewerId: string;
  sessionId: string;
  /** Stable, pseudonymous identifier suitable for OpenAI safety_identifier. */
  safetyIdentifier: string;
}

function digest(secret: string, purpose: string): string {
  return createHmac("sha256", secret).update(`zintus-engineer:${purpose}`).digest("hex");
}

/**
 * Derives Engineer authority only from server-owned gateway configuration.
 * Request bodies and headers never select an owner, reviewer, or session.
 */
export function deriveEngineerPrincipal(input: {
  gatewayIdentitySecret: string;
  authenticatedSubject?: string;
}): EngineerPrincipal {
  if (!input.gatewayIdentitySecret) throw new Error("Engineer identity secret is required");
  const subject = input.authenticatedSubject?.trim() || "local-gateway-owner";
  const root = digest(input.gatewayIdentitySecret, `subject:${subject}`);
  return {
    ownerId: `engineer-user-${digest(root, "owner").slice(0, 32)}`,
    reviewerId: `engineer-user-${digest(root, "reviewer").slice(0, 32)}`,
    sessionId: `engineer-session-${digest(root, "session").slice(0, 32)}`,
    safetyIdentifier: digest(root, "openai-safety-identifier"),
  };
}

interface StoredIdentity { version: 1; installId: string; rootSecret: string }

function parseStoredIdentity(value: unknown): StoredIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Engineer identity record");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "installId,rootSecret,version" || record.version !== 1 ||
      typeof record.installId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.installId) ||
      typeof record.rootSecret !== "string" || !/^[a-f0-9]{64}$/.test(record.rootSecret)) {
    throw new Error("invalid Engineer identity record");
  }
  return { version: 1, installId: record.installId, rootSecret: record.rootSecret };
}

function readStoredIdentity(path: string): StoredIdentity {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("Engineer identity file must be an owner-only regular file");
  }
  return parseStoredIdentity(JSON.parse(readFileSync(path, "utf8")));
}

/** Loads or atomically creates the install identity; gateway bearer rotation is unrelated. */
export function loadOrCreateEngineerPrincipal(path: string): EngineerPrincipal {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let stored: StoredIdentity;
  if (existsSync(path)) {
    stored = readStoredIdentity(path);
  } else {
    stored = { version: 1, installId: randomUUID(), rootSecret: randomBytes(32).toString("hex") };
    let fd: number | null = null;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(stored)}\n`, { encoding: "utf8" });
      fsyncSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      stored = readStoredIdentity(path);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return deriveEngineerPrincipal({
    gatewayIdentitySecret: stored.rootSecret,
    authenticatedSubject: `install:${stored.installId}`,
  });
}

/** Separate install secret for local worker-lease capabilities; never sent to a model or client. */
export function loadOrCreateEngineerWorkerLeaseSecret(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error("Engineer worker lease secret must be an owner-only regular file");
    }
    const value = readFileSync(path, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid Engineer worker lease secret");
    return value;
  }
  const value = randomBytes(32).toString("hex");
  let fd: number | null = null;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, `${value}\n`, { encoding: "utf8" });
    fsyncSync(fd);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return loadOrCreateEngineerWorkerLeaseSecret(path);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
