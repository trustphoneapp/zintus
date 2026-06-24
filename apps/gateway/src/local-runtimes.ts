/**
 * Local LLM runtime detection — Ollama (11434) and LM Studio (1234).
 *
 * Pinged from the gateway machine and merged into the status payload so clients
 * can show an "On your system" section. Results are cached for 30s; a detection
 * is NEVER reported from stale (>30s) data.
 */

const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";
const LMSTUDIO_MODELS_URL = "http://localhost:1234/v1/models";
const PROBE_TIMEOUT_MS = 1_000;
const CACHE_TTL_MS = 30_000;

export interface RuntimeStatus {
  detected: boolean;
  models?: string[];
}

export interface LocalRuntimes {
  ollama: RuntimeStatus;
  lmstudio: RuntimeStatus;
}

let cache: { at: number; value: LocalRuntimes } | null = null;

async function probeOllama(): Promise<RuntimeStatus> {
  try {
    const res = await fetch(OLLAMA_TAGS_URL, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { detected: false };
    }
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = Array.isArray(body.models)
      ? body.models
          .map((m) => m?.name)
          .filter((n): n is string => typeof n === "string")
      : [];
    return { detected: true, models };
  } catch {
    return { detected: false };
  }
}

async function probeLmStudio(): Promise<RuntimeStatus> {
  try {
    const res = await fetch(LMSTUDIO_MODELS_URL, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { detected: false };
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = Array.isArray(body.data)
      ? body.data
          .map((m) => m?.id)
          .filter((n): n is string => typeof n === "string")
      : [];
    return { detected: true, models };
  } catch {
    return { detected: false };
  }
}

/**
 * Detect local Ollama / LM Studio runtimes. Cached for 30s. Both probes run
 * concurrently and failures degrade gracefully to `{ detected: false }`.
 */
export async function detectLocalRuntimes(): Promise<LocalRuntimes> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const [ollamaResult, lmstudioResult] = await Promise.allSettled([
    probeOllama(),
    probeLmStudio(),
  ]);

  const value: LocalRuntimes = {
    ollama:
      ollamaResult.status === "fulfilled"
        ? ollamaResult.value
        : { detected: false },
    lmstudio:
      lmstudioResult.status === "fulfilled"
        ? lmstudioResult.value
        : { detected: false },
  };

  cache = { at: now, value };
  return value;
}
