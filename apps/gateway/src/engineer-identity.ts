import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface EngineerPrincipal {
  ownerId: string;
  reviewerId: string;
  /**
   * The independent two-person APPROVER identity for the P8 publication-authority
   * lane. Derived ONLY from a SEPARATELY provisioned approver credential — never
   * from the requester's own `gatewayIdentitySecret`. `null` when no second party is
   * provisioned (a single install), in which case the P8 approve path fails closed:
   * a single install cannot self-approve. Distinct from `reviewerId` (the legacy
   * publication lane's reviewer actor, which remains derived from the install secret).
   */
  approverId?: string | null;
  sessionId: string;
  /** Stable, pseudonymous identifier suitable for OpenAI safety_identifier. */
  safetyIdentifier: string;
}

/** Publication needs both repository credentials and an authenticated gateway. */
export function canEnableEngineerPublication(input: {
  publicationSecret?: string;
  githubToken?: string;
  githubCredentialProvider?: boolean;
  gatewayToken?: string;
}): boolean {
  return Boolean(input.publicationSecret?.trim() && (input.githubToken?.trim() || input.githubCredentialProvider) && input.gatewayToken?.trim());
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
  /**
   * A SEPARATELY provisioned second-party credential from which the P8 approver
   * identity is derived. It MUST be independent of `gatewayIdentitySecret`; passing
   * the requester's own secret here is rejected (that would recreate the
   * single-install self-approval this control exists to prevent). Omit it on a single
   * install: `approverId` is then `null` and the P8 approve path fails closed.
   */
  approverIdentitySecret?: string;
}): EngineerPrincipal {
  if (!input.gatewayIdentitySecret) throw new Error("Engineer identity secret is required");
  const subject = input.authenticatedSubject?.trim() || "local-gateway-owner";
  const root = digest(input.gatewayIdentitySecret, `subject:${subject}`);
  const ownerId = `engineer-user-${digest(root, "owner").slice(0, 32)}`;

  // The two-person APPROVER identity is derived ONLY from an independent approver
  // credential — never from the requester's own secret via a label. Without one, a
  // single install yields NO usable approver (approverId=null), so it structurally
  // cannot self-approve.
  let approverId: string | null = null;
  if (input.approverIdentitySecret !== undefined) {
    const approverSecret = input.approverIdentitySecret;
    if (!approverSecret.trim()) {
      throw new Error("Engineer approver identity secret must be non-empty when configured");
    }
    if (approverSecret === input.gatewayIdentitySecret) {
      throw new Error("Engineer approver identity secret must be independent of the requester's identity secret");
    }
    const approverRoot = digest(approverSecret, `approver-subject:${subject}`);
    approverId = `engineer-approver-${digest(approverRoot, "approver").slice(0, 32)}`;
    if (approverId === ownerId) {
      throw new Error("Engineer approver identity collides with the requester identity");
    }
  }

  return {
    ownerId,
    reviewerId: `engineer-user-${digest(root, "reviewer").slice(0, 32)}`,
    approverId,
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

/** Loads or atomically creates a single stored install identity file. */
function loadOrCreateStoredIdentity(path: string): StoredIdentity {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) return readStoredIdentity(path);
  let stored: StoredIdentity = { version: 1, installId: randomUUID(), rootSecret: randomBytes(32).toString("hex") };
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
  return stored;
}

/**
 * Loads or atomically creates the install identity; gateway bearer rotation is
 * unrelated. `approverPath`, when provided, loads/creates a SEPARATE install identity
 * whose independent secret backs the P8 two-person `approverId`. Its secret must be
 * distinct from the requester's (a shared file is rejected by `deriveEngineerPrincipal`),
 * so a single install (no approver path) yields `approverId=null` and cannot self-approve.
 */
export function loadOrCreateEngineerPrincipal(path: string, approverPath?: string): EngineerPrincipal {
  const stored = loadOrCreateStoredIdentity(path);
  let approverIdentitySecret: string | undefined;
  if (approverPath !== undefined && approverPath !== path) {
    approverIdentitySecret = loadOrCreateStoredIdentity(approverPath).rootSecret;
  }
  return deriveEngineerPrincipal({
    gatewayIdentitySecret: stored.rootSecret,
    authenticatedSubject: `install:${stored.installId}`,
    ...(approverIdentitySecret !== undefined ? { approverIdentitySecret } : {}),
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
