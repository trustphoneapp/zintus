/**
 * E2E BYOK key push (mobile side).
 *
 * The phone encrypts the API key to the gateway's PUBLIC key using
 * `@zintus/crypto-e2e`. The relay only ever forwards opaque ciphertext; only the
 * gateway (holding the private key, which never leaves the machine) can decrypt.
 *
 * Wire (see BYOK contract):
 *   - control "set_key"    value = { provider, encryptedKey: base64(JSON{v,epk,iv,ct}) }
 *   - control "remove_key" value = { provider }
 *
 * The key is ALSO mirrored into local secure storage via lib/keys.ts (the existing
 * "zintus:key:" scheme) so the phone's own UI / local routing stays consistent.
 */

import { encryptForGateway } from "@zintus/crypto-e2e";
import type { ProviderId } from "@zintus/types";
import { fetchCloudSessions, fetchSessionStatus } from "@/lib/cloud";
import { deleteApiKey, setApiKey } from "@/lib/keys";

export interface KeyPushResult {
  success: boolean;
  error?: string;
}

const NOT_CONNECTED = "Not connected to Zintus Cloud";
const NO_GATEWAY_PUBKEY =
  "Gateway doesn't support secure key push — update it: zintus serve --cloud";

/**
 * Resolve the session id to push to: prefer an online session, otherwise fall
 * back to the most recently seen session. Returns null when no session exists
 * (i.e. the phone is not connected to a gateway via Zintus Cloud).
 */
export async function resolveSessionId(): Promise<string | null> {
  const sessions = await fetchCloudSessions();
  if (sessions.length === 0) return null;

  const online = sessions.find((s) => s.online === 1);
  if (online) return online.id;

  // No online session — pick the most recently seen as a best effort.
  const mostRecent = [...sessions].sort(
    (a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0),
  )[0];
  return mostRecent?.id ?? null;
}

/**
 * Encrypt `apiKey` to the resolved gateway and push it via the relay control
 * channel, then mirror it into local secure storage. Never sends the plaintext
 * key over the relay.
 */
export async function pushKeyToGateway(
  provider: ProviderId,
  apiKey: string,
): Promise<KeyPushResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return { success: false, error: "API key is empty" };
  }

  const sessionId = await resolveSessionId();
  if (!sessionId) {
    return { success: false, error: NOT_CONNECTED };
  }

  const status = await fetchSessionStatus(sessionId);
  const gatewayPublicKey = status?.gatewayPublicKey;
  if (!gatewayPublicKey) {
    return { success: false, error: NO_GATEWAY_PUBKEY };
  }

  let encryptedKey: string;
  try {
    encryptedKey = encryptForGateway(trimmed, gatewayPublicKey);
  } catch {
    return { success: false, error: "Failed to encrypt key for the gateway" };
  }

  const { sendCloudControl } = await import("@/lib/cloud");
  const ok = await sendCloudControl(sessionId, "set_key", {
    provider,
    encryptedKey,
  });
  if (!ok) {
    return { success: false, error: "Gateway rejected the key push" };
  }

  // Mirror locally only after a successful push.
  await setApiKey(provider, trimmed);
  return { success: true };
}

/**
 * Remove a key from the gateway (best effort over the relay) and delete the
 * local copy.
 */
export async function removeKeyFromGateway(
  provider: ProviderId,
): Promise<KeyPushResult> {
  const sessionId = await resolveSessionId();

  if (sessionId) {
    const { sendCloudControl } = await import("@/lib/cloud");
    await sendCloudControl(sessionId, "remove_key", { provider });
  }

  await deleteApiKey(provider);
  return { success: true };
}
