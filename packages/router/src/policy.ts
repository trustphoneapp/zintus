import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PolicyConfig, ProviderId } from "@multipleai/types";

/**
 * Declarative routing policy loader (Phase 1.4).
 *
 * Routing rules that used to be compile-time constants now live in a single
 * JSON file so operators can retune provider order, weights, model groups, and
 * quota limits without editing code. Resolution order:
 *   1. explicit path argument
 *   2. $MULTIPLEAI_POLICY env var
 *   3. ~/.multipleai/policy.json
 *   4. <repo-root>/policy.json (cwd)
 * When no file exists we return an empty policy and callers fall back to their
 * hardcoded defaults — the file is purely an override layer.
 */

const HOME_POLICY = join(homedir(), ".multipleai", "policy.json");
const CWD_POLICY = join(process.cwd(), "policy.json");

export function resolvePolicyPath(explicit?: string): string | null {
  if (explicit) {
    return explicit;
  }
  const fromEnv = process.env.MULTIPLEAI_POLICY;
  if (fromEnv) {
    return fromEnv;
  }
  if (existsSync(HOME_POLICY)) {
    return HOME_POLICY;
  }
  if (existsSync(CWD_POLICY)) {
    return CWD_POLICY;
  }
  return null;
}

const VALID_FALLBACK = new Set(["next_provider", "fail"]);

/** Parse + shallow-validate a policy object, dropping unknown/garbage fields. */
export function normalizePolicy(raw: unknown): PolicyConfig {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const policy: PolicyConfig = {};

  if (Array.isArray(obj.providerPriority)) {
    policy.providerPriority = obj.providerPriority.filter(
      (id): id is ProviderId => typeof id === "string",
    ) as ProviderId[];
  }
  if (obj.providerWeights && typeof obj.providerWeights === "object") {
    policy.providerWeights = obj.providerWeights as PolicyConfig["providerWeights"];
  }
  if (obj.modelGroups && typeof obj.modelGroups === "object") {
    const groups: Record<string, ProviderId[]> = {};
    for (const [model, list] of Object.entries(obj.modelGroups)) {
      if (Array.isArray(list)) {
        groups[model] = list.filter(
          (id): id is ProviderId => typeof id === "string",
        ) as ProviderId[];
      }
    }
    policy.modelGroups = groups;
  }
  if (obj.fallbacks && typeof obj.fallbacks === "object") {
    const fb = obj.fallbacks as Record<string, unknown>;
    policy.fallbacks = {};
    if (typeof fb.on_429 === "string" && VALID_FALLBACK.has(fb.on_429)) {
      policy.fallbacks.on_429 = fb.on_429 as "next_provider" | "fail";
    }
    if (typeof fb.on_5xx === "string" && VALID_FALLBACK.has(fb.on_5xx)) {
      policy.fallbacks.on_5xx = fb.on_5xx as "next_provider" | "fail";
    }
  }
  if (obj.limits && typeof obj.limits === "object") {
    policy.limits = obj.limits as PolicyConfig["limits"];
  }
  return policy;
}

/** Load and parse policy from disk. Returns {} when the file is missing or invalid. */
export function loadPolicy(explicitPath?: string): PolicyConfig {
  const path = resolvePolicyPath(explicitPath);
  if (!path || !existsSync(path)) {
    return {};
  }
  try {
    return normalizePolicy(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // A malformed file must never crash routing — fall back to code defaults.
    return {};
  }
}

/**
 * Watch the resolved policy file and invoke `onChange` with the freshly parsed
 * policy whenever it changes (hot-reload). Returns a disposer. No-op (returns a
 * noop disposer) when no policy file exists.
 */
export function watchPolicy(
  onChange: (policy: PolicyConfig) => void,
  explicitPath?: string,
): () => void {
  const path = resolvePolicyPath(explicitPath);
  if (!path) {
    return () => {};
  }
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    watcher = watch(path, () => {
      // Debounce: editors often emit multiple events per save.
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        onChange(loadPolicy(path));
      }, 100);
      timer.unref?.();
    });
  } catch {
    return () => {};
  }
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    watcher?.close();
  };
}
