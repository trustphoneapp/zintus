import { createHash } from "node:crypto";

type JsonPrimitive = string | number | boolean | null;
type CanonicalJson = JsonPrimitive | CanonicalJson[] | { [key: string]: CanonicalJson };

/** Locale-independent ordering for every hash-bound array or durable byte sequence. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown, path: string): CanonicalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) throw new TypeError(`${path}.${key} is undefined`);
      result[key] = canonicalize(item, `${path}.${key}`);
    }
    return result;
  }
  throw new TypeError(`${path} contains a non-JSON value`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$"));
}

export function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Conventional SHA-256 over the exact byte sequence, for content-addressed files. */
export function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Read compatibility for artifacts written before exact-byte hashing was
 * introduced. New records always use sha256Bytes; the canonical Buffer form is
 * accepted only so existing durable runs remain readable during migration.
 */
export function matchesSha256Bytes(value: Uint8Array, expected: string): boolean {
  return sha256Bytes(value) === expected || sha256(value) === expected;
}

/** OpenAI prompt cache keys are limited to 64 characters; retain the canonical hash internally. */
export function providerPromptCacheKey(hash: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(hash);
  if (!match) throw new TypeError("provider prompt cache key requires a canonical SHA-256 hash");
  return match[1]!;
}
