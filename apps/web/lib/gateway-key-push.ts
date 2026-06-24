/**
 * BYOK E2E key-push (web side).
 *
 * Flow (Mode B — never plaintext through the relay):
 *   1. Resolve a gateway session id (online one, else first available).
 *   2. Read that session's status → gatewayPublicKey (raw 32B x25519 pub, base64).
 *   3. Encrypt the API key to that pubkey with @zintus/crypto-e2e (the SAME
 *      encrypt impl gateway + mobile use — wire format can never drift).
 *   4. POST control { action: "set_key", value: { provider, encryptedKey } } via
 *      the relay; the relay forwards opaque ciphertext and only the gateway can
 *      decrypt it.
 *   5. Persist the key locally in the existing encrypted browser vault
 *      (apps/web/lib/crypto.ts) so the dashboard can show "key set".
 *
 * The plaintext key is ONLY ever used for (3) the encrypted push and (5) the
 * passphrase-encrypted local vault. It is never sent to Zintus in the clear.
 */

import { encryptForGateway } from "@zintus/crypto-e2e";
import type { ProviderId } from "@zintus/types";
import {
  listSessions,
  getSessionStatus,
  sendControl,
  type GatewaySession,
} from "./cloud";
import {
  encryptKeys,
  decryptKeys,
  loadEncryptedKeys,
  saveEncryptedKeys,
} from "./crypto";

export interface GatewayStatus {
  ok?: boolean;
  online?: boolean;
  gatewayPublicKey?: string;
  localRuntimes?: LocalRuntimes;
  [key: string]: unknown;
}

export interface LocalRuntime {
  detected: boolean;
  models?: string[];
}

export interface LocalRuntimes {
  ollama?: LocalRuntime;
  lmstudio?: LocalRuntime;
}

export interface KeyPushResult {
  ok: boolean;
  error?: string;
}

/**
 * Pick the session to push to: prefer the online one, otherwise the first
 * available. `preferredId` (e.g. a user-selected session) wins if present.
 */
function resolveSession(
  sessions: GatewaySession[],
  preferredId?: string,
): GatewaySession | null {
  if (preferredId) {
    const match = sessions.find((s) => s.id === preferredId);
    if (match) return match;
  }
  return sessions.find((s) => s.online) ?? sessions[0] ?? null;
}

/** Resolve a session id + its live status (with gatewayPublicKey). */
async function resolveSessionStatus(
  preferredId?: string,
): Promise<
  | { ok: true; sessionId: string; status: GatewayStatus }
  | { ok: false; error: string }
> {
  const sessions = await listSessions();
  const session = resolveSession(sessions, preferredId);
  if (!session) {
    return {
      ok: false,
      error:
        "No gateway connected. Add a gateway from the Dashboard, then run `zintus serve --cloud` on your home machine.",
    };
  }

  const status = (await getSessionStatus(session.id)) as GatewayStatus | null;
  if (!status) {
    return {
      ok: false,
      error:
        "Gateway is offline. Run `zintus serve --cloud` on your home machine, then try again.",
    };
  }

  return { ok: true, sessionId: session.id, status };
}

// ── Local vault helpers ─────────────────────────────────────────────────────

/**
 * Merge a single provider key into the encrypted local vault. If `apiKey` is
 * null the provider entry is removed. Returns the updated keys map.
 *
 * If a vault already exists it MUST be decryptable with `passphrase` (the user's
 * existing vault passphrase); a wrong passphrase throws.
 */
async function mergeIntoVault(
  provider: string,
  apiKey: string | null,
  passphrase: string,
): Promise<void> {
  const existing = loadEncryptedKeys();
  let keys: Record<string, string> = {};
  if (existing) {
    keys = await decryptKeys(existing, passphrase);
  }

  if (apiKey === null) {
    delete keys[provider];
  } else {
    keys[provider] = apiKey;
  }

  const encrypted = await encryptKeys(keys, passphrase);
  saveEncryptedKeys(encrypted);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Encrypt `apiKey` to the gateway and push it via the relay, then persist it in
 * the local encrypted vault. `passphrase` unlocks/creates the local vault.
 */
export async function pushKeyToGateway(
  provider: ProviderId,
  apiKey: string,
  passphrase: string,
  preferredSessionId?: string,
): Promise<KeyPushResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return { ok: false, error: "API key is empty." };
  }

  const resolved = await resolveSessionStatus(preferredSessionId);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const pubKey = resolved.status.gatewayPublicKey;
  if (!pubKey) {
    return {
      ok: false,
      error:
        "This gateway doesn't support encrypted key push yet. Update Zintus on your home machine (`zintus serve --cloud`) and try again.",
    };
  }

  let encryptedKey: string;
  try {
    encryptedKey = encryptForGateway(trimmed, pubKey);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to encrypt the key: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const sent = await sendControl(resolved.sessionId, "set_key", {
    provider,
    encryptedKey,
  });
  if (!sent) {
    return { ok: false, error: "The relay rejected the key. Please try again." };
  }

  // Persist locally only after the push succeeds.
  try {
    await mergeIntoVault(provider, trimmed, passphrase);
  } catch {
    return {
      ok: false,
      error:
        "Key pushed to your gateway, but couldn't be saved to your local vault (wrong passphrase?).",
    };
  }

  return { ok: true };
}

/**
 * Remove `provider`'s key from the gateway via the relay, and drop it from the
 * local encrypted vault.
 */
export async function removeKeyFromGateway(
  provider: ProviderId,
  passphrase: string,
  preferredSessionId?: string,
): Promise<KeyPushResult> {
  const resolved = await resolveSessionStatus(preferredSessionId);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const sent = await sendControl(resolved.sessionId, "remove_key", { provider });
  if (!sent) {
    return { ok: false, error: "The relay rejected the request. Please try again." };
  }

  try {
    await mergeIntoVault(provider, null, passphrase);
  } catch {
    // Removal from the gateway succeeded; local vault stays as-is.
    return {
      ok: false,
      error:
        "Key removed from your gateway, but couldn't update your local vault (wrong passphrase?).",
    };
  }

  return { ok: true };
}

/**
 * Read the current gateway status (gatewayPublicKey + localRuntimes) for the
 * resolved session, or null if no gateway / offline.
 */
export async function fetchGatewayStatus(
  preferredSessionId?: string,
): Promise<{ sessionId: string; status: GatewayStatus } | null> {
  const resolved = await resolveSessionStatus(preferredSessionId);
  if (!resolved.ok) return null;
  return { sessionId: resolved.sessionId, status: resolved.status };
}

/**
 * Load the set of provider ids that currently have a key in the local vault.
 * Requires the vault passphrase. Returns an empty set if no vault exists.
 */
export async function loadLocalKeyProviders(
  passphrase: string,
): Promise<Set<string>> {
  const existing = loadEncryptedKeys();
  if (!existing) return new Set();
  const keys = await decryptKeys(existing, passphrase);
  return new Set(Object.keys(keys));
}
