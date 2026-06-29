import type { ProviderId } from "@zintus/types";
import { decryptKeys, encryptKeys } from "@/lib/crypto";

/**
 * Encrypted SIDECAR vault for BYOK FALLBACK keys (the tail after the primary).
 *
 * The primary key per provider stays in the existing single-key vault
 * (`zintus.web.keys`, managed by `useProviderStatusStore`) so the gateway BYOK
 * key-push keeps reading it byte-for-byte. The ordered FALLBACK tail lives here
 * in a separate localStorage entry, encrypted with the SAME passphrase /
 * AES-256-GCM (Web Crypto) as the primary vault. This mirrors the OS keychain's
 * `${providerId}::fallbacks` sidecar design exactly — keys never leave the
 * device (local-first, no custody).
 */
const FALLBACK_STORAGE_KEY = "zintus.web.key-fallbacks";

export type FallbackMap = Partial<Record<ProviderId, string[]>>;

/** Raw encrypted blob, or null when nothing has been stored / no `window`. */
function loadEncryptedFallbacks(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(FALLBACK_STORAGE_KEY);
}

/**
 * Decrypt the per-provider fallback tails. Returns `{}` when locked (no
 * passphrase), empty, or on any decrypt failure — fallbacks are an enhancement,
 * never load-bearing, so a bad passphrase must not throw into the UI.
 */
export async function loadFallbacks(passphrase: string): Promise<FallbackMap> {
  const encrypted = loadEncryptedFallbacks();
  if (!encrypted || !passphrase) return {};
  try {
    const record = await decryptKeys(encrypted, passphrase);
    const out: FallbackMap = {};
    for (const [id, value] of Object.entries(record)) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) {
          const keys = parsed.filter((v): v is string => typeof v === "string");
          if (keys.length > 0) out[id as ProviderId] = keys;
        }
      } catch {
        // skip an unparseable entry — the primary key still works
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Persist the per-provider fallback tails. Each provider's tail is JSON-encoded
 * into the `Record<string, string>` shape `encryptKeys` expects. Providers with
 * an empty tail are dropped; an entirely empty map removes the sidecar so a
 * single-key setup leaves no trace (back-compat). A no-op without a passphrase.
 */
export async function saveFallbacks(
  map: FallbackMap,
  passphrase: string,
): Promise<void> {
  if (typeof window === "undefined" || !passphrase) return;
  const record: Record<string, string> = {};
  for (const [id, list] of Object.entries(map)) {
    const tail = (list ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
    if (tail.length > 0) record[id] = JSON.stringify(tail);
  }
  if (Object.keys(record).length === 0) {
    window.localStorage.removeItem(FALLBACK_STORAGE_KEY);
    return;
  }
  const encrypted = await encryptKeys(record, passphrase);
  window.localStorage.setItem(FALLBACK_STORAGE_KEY, encrypted);
}
