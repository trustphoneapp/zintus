// MIT License — see LICENSE file
import { countTokensFast, estimateSavings } from "../tokenizer/count.js";
import { getDefaultCCRStore } from "../ccr/store.js";
import type { CompressContext, CompressResult } from "../pipeline/types.js";

function depth(val: unknown, d = 0): number {
  if (typeof val !== "object" || val === null) return d;
  const entries = Array.isArray(val) ? val : Object.values(val);
  if (entries.length === 0) return d;
  return Math.max(...(entries as unknown[]).map((v) => depth(v, d + 1)));
}

function topLevelKeys(obj: unknown): string[] {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return [];
  return Object.keys(obj);
}

function isUniformArray(arr: unknown[]): boolean {
  if (arr.length < 2) return false;
  const firstKeys = JSON.stringify(topLevelKeys(arr[0]).sort());
  const uniformCount = arr.filter(
    (item) => JSON.stringify(topLevelKeys(item).sort()) === firstKeys,
  ).length;
  return uniformCount / arr.length > 0.8;
}

/** TOON-style CSV encoding for uniform arrays (built-in, no external dep). */
function toonEncode(arr: Record<string, unknown>[]): string {
  if (arr.length === 0) return "[]";
  const keys = topLevelKeys(arr[0] ?? {});
  const header = keys.join(",");
  const rows = arr.map((item) =>
    keys
      .map((k) => {
        const v = (item as Record<string, unknown>)[k];
        const s = JSON.stringify(v) ?? "";
        return s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(","),
  );
  return `TOON:${header}\n${rows.join("\n")}`;
}

/** Statistical importance score for a JSON array item. */
function itemImportance(
  item: unknown,
  fieldStats: Map<string, { min: number; max: number; mean: number }>,
): number {
  const s = JSON.stringify(item).toLowerCase();
  if (s.includes('"error"') || s.includes('"exception"') || s.includes('"fail"')) {
    return Infinity;
  }
  let score = 0;
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      const stats = fieldStats.get(k);
      if (stats && typeof v === "number") {
        const range = stats.max - stats.min;
        if (range > 0) {
          const z = Math.abs((v - stats.mean) / (range / 2));
          score += z > 1.5 ? 2.0 : 0;
        }
      }
      // uniqueness: non-null, non-empty
      if (v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) {
        score += 0.1;
      }
    }
  }
  return score;
}

function buildFieldStats(
  arr: unknown[],
): Map<string, { min: number; max: number; mean: number }> {
  const stats = new Map<string, { min: number; max: number; sum: number; count: number }>();
  for (const item of arr) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (typeof v !== "number") continue;
      const existing = stats.get(k) ?? { min: v, max: v, sum: 0, count: 0 };
      existing.min = Math.min(existing.min, v);
      existing.max = Math.max(existing.max, v);
      existing.sum += v;
      existing.count += 1;
      stats.set(k, existing);
    }
  }
  const result = new Map<string, { min: number; max: number; mean: number }>();
  for (const [k, v] of stats) {
    result.set(k, { min: v.min, max: v.max, mean: v.sum / v.count });
  }
  return result;
}

function stripEmpty(val: unknown): unknown {
  if (val === null || val === "" ) return undefined;
  if (Array.isArray(val)) {
    const filtered = val.map(stripEmpty).filter((v) => v !== undefined);
    return filtered.length === 0 ? undefined : filtered;
  }
  if (typeof val === "object" && val !== null) {
    const obj = val as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const stripped = stripEmpty(v);
      if (stripped !== undefined) cleaned[k] = stripped;
    }
    return Object.keys(cleaned).length === 0 ? undefined : cleaned;
  }
  return val;
}

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function compressUUIDs(
  obj: unknown,
  map: Map<string, string>,
): unknown {
  if (typeof obj === "string") {
    return obj.replace(UUID_RE, (uuid) => {
      const lower = uuid.toLowerCase();
      if (!map.has(lower)) {
        map.set(lower, `u-${map.size + 1}`);
      }
      return map.get(lower)!;
    });
  }
  if (Array.isArray(obj)) return obj.map((v) => compressUUIDs(v, map));
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = compressUUIDs(v, map);
    }
    return result;
  }
  return obj;
}

function abbreviateKeys(
  obj: unknown,
  keyMap: Map<string, string>,
  counter: { n: number },
): unknown {
  if (Array.isArray(obj)) return obj.map((v) => abbreviateKeys(v, keyMap, counter));
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      let abbr = keyMap.get(k);
      if (!abbr && k.length > 8) {
        abbr = `k${++counter.n}`;
        keyMap.set(k, abbr);
      }
      result[abbr ?? k] = abbreviateKeys(v, keyMap, counter);
    }
    return result;
  }
  return obj;
}

/**
 * Compresses JSON content using statistical sampling, key abbreviation,
 * UUID aliasing, TOON encoding, and empty-value stripping.
 */
export function compressJSON(
  content: string,
  ctx?: Partial<CompressContext>,
): CompressResult {
  const originalTokens = countTokensFast(content);
  const noop = (): CompressResult => ({
    content,
    originalTokens,
    compressedTokens: originalTokens,
    ratio: 1,
    transforms: [],
    ccrHashes: [],
    cacheHit: false,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return noop();
  }

  const store = getDefaultCCRStore();
  const appliedTransforms: string[] = [];
  const ccrHashes: string[] = [];
  const uuidMap = new Map<string, string>();
  const keyMap = new Map<string, string>();
  const keyCounter = { n: 0 };

  let current: unknown = parsed;

  // UUID compression
  current = compressUUIDs(current, uuidMap);
  if (uuidMap.size > 0) appliedTransforms.push("uuid-alias");

  // Strip empty values
  current = stripEmpty(current) ?? parsed;
  appliedTransforms.push("strip-empty");

  // TOON encoding for uniform arrays
  if (
    Array.isArray(current) &&
    isUniformArray(current) &&
    depth(current) <= 3
  ) {
    const arr = current as Record<string, unknown>[];
    let sampled = arr;
    let droppedCount = 0;

    // Statistical sampling for large arrays
    if (arr.length > 20) {
      const fieldStats = buildFieldStats(arr);
      const headCount = Math.ceil(arr.length * 0.3);
      const tailCount = Math.ceil(arr.length * 0.15);
      const middleItems = arr.slice(headCount, arr.length - tailCount);
      const scored = middleItems.map((item, i) => ({
        item,
        score: itemImportance(item, fieldStats),
        origIndex: headCount + i,
      }));
      const middleTarget = Math.ceil(arr.length * 0.55);
      const mustKeep = scored.filter((s) => s.score === Infinity);
      const rest = scored.filter((s) => s.score !== Infinity);
      rest.sort((a, b) => b.score - a.score);
      const selected = [...mustKeep, ...rest.slice(0, middleTarget - mustKeep.length)];
      const dropped = rest.slice(middleTarget - mustKeep.length);

      if (dropped.length > 0) {
        const droppedContent = JSON.stringify(dropped.map((d) => d.item));
        const hash = store.store(droppedContent, "json", {
          sessionId: ctx?.sessionId,
        });
        ccrHashes.push(hash);
        droppedCount = dropped.length;
      }

      sampled = [
        ...arr.slice(0, headCount),
        ...selected.map((s) => s.item),
        ...arr.slice(arr.length - tailCount),
      ] as Record<string, unknown>[];
      appliedTransforms.push("statistical-sampling");
    }

    const encoded = toonEncode(sampled);
    const uuidHeader =
      uuidMap.size > 0
        ? `// uuids: ${JSON.stringify(Object.fromEntries(uuidMap))}\n`
        : "";
    const ccrNote =
      droppedCount > 0
        ? `\n// [${droppedCount} items compressed. retrieve(${ccrHashes[ccrHashes.length - 1]}) for full data]`
        : "";
    const result = `${uuidHeader}${encoded}${ccrNote}`;
    const { compressedTokens } = estimateSavings(content, result);
    return {
      content: result,
      originalTokens,
      compressedTokens,
      ratio: compressedTokens / originalTokens,
      transforms: [...appliedTransforms, "toon-encode"],
      ccrHashes,
      cacheHit: false,
    };
  }

  // Key abbreviation for non-TOON path
  current = abbreviateKeys(current, keyMap, keyCounter);
  if (keyMap.size > 0) {
    appliedTransforms.push("key-abbreviation");
  }

  const keyComment =
    keyMap.size > 0
      ? `// keys: ${JSON.stringify(Object.fromEntries(keyMap))}\n`
      : "";
  const uuidComment =
    uuidMap.size > 0
      ? `// uuids: ${JSON.stringify(Object.fromEntries(uuidMap))}\n`
      : "";
  const minified = JSON.stringify(current);
  const result = `${keyComment}${uuidComment}${minified}`;
  const { compressedTokens } = estimateSavings(content, result);

  return {
    content: result,
    originalTokens,
    compressedTokens,
    ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens,
    transforms: appliedTransforms,
    ccrHashes,
    cacheHit: false,
  };
}
