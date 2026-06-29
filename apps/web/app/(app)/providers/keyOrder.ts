/**
 * Pure ordering logic for an ORDERED BYOK key list (primary first, then
 * fallbacks). These helpers mirror the OS-keychain `getKeys`/`setKeys` contract
 * (`packages/keychain/src/storage.ts`) so the web cockpit's local-first vault and
 * the gateway's keychain share identical semantics:
 *   - keys are trimmed, blanks dropped, duplicates removed (order-preserving);
 *   - the FIRST element is the primary (stored in the single-key vault, so the
 *     existing gateway BYOK key-push keeps working byte-for-byte);
 *   - the rest is the fallback tail the router walks on a 401/403 failure.
 * A lone primary round-trips as a 1-element list (single-key back-compat).
 *
 * Everything here is pure (no React, no storage) so it is fully unit-testable.
 */

/**
 * Normalize an ordered key list: trim each key, drop blanks, dedupe
 * order-preserving. Mirrors the keychain `setKeys` cleaning + `getKeys` dedupe —
 * a stray duplicate must never cause a redundant retry of the same credential.
 */
export function normalizeKeyList(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keys) {
    const key = raw.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Build an ordered list from a stored primary key + fallback tail (primary
 * first). Mirrors keychain `getKeys`: a provider that only ever had a single key
 * reads back as a 1-element list (back-compat).
 */
export function combineKeyList(
  primary: string | null | undefined,
  fallbacks: readonly string[] = [],
): string[] {
  const head = primary && primary.trim().length > 0 ? [primary] : [];
  return normalizeKeyList([...head, ...fallbacks]);
}

/**
 * Split an ordered list into `{ primary, fallbacks }` for storage. Mirrors
 * keychain `setKeys`: the first (normalized) element is the primary, the rest is
 * the sidecar tail. An empty/blank list yields `{ primary: null, fallbacks: [] }`.
 */
export function splitKeyList(keys: readonly string[]): {
  primary: string | null;
  fallbacks: string[];
} {
  const [primary = null, ...fallbacks] = normalizeKeyList(keys);
  return { primary, fallbacks };
}

/** Remove the key at `index`. Out-of-range indices are a no-op (returns a copy). */
export function removeKeyAt(keys: readonly string[], index: number): string[] {
  if (index < 0 || index >= keys.length) return keys.slice();
  const out = keys.slice();
  out.splice(index, 1);
  return out;
}

/**
 * Move the key at `index` one slot toward the primary (`"up"`) or away from it
 * (`"down"`). Out-of-range / boundary moves return an equivalent copy unchanged.
 */
export function moveKey(
  keys: readonly string[],
  index: number,
  dir: "up" | "down",
): string[] {
  const target = dir === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= keys.length || target < 0 || target >= keys.length) {
    return keys.slice();
  }
  const out = keys.slice();
  const moved = out[index] as string;
  out[index] = out[target] as string;
  out[target] = moved;
  return out;
}
