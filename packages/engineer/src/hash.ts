import { createHash } from "node:crypto";

type JsonPrimitive = string | number | boolean | null;
type CanonicalJson = JsonPrimitive | CanonicalJson[] | { [key: string]: CanonicalJson };

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
