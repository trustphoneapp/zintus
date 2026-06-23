import { encryptKey, decryptKey } from './crypto.js';
import type { Env } from './types.js';

// KV key: managed_key:{userId}:{provider}
export async function setManagedKey(userId: string, provider: string, apiKey: string, env: Env): Promise<void> {
  const encrypted = await encryptKey(apiKey, env.KEY_ENCRYPTION_SECRET);
  await env.KV.put(`managed_key:${userId}:${provider}`, encrypted, { expirationTtl: 60 * 60 * 24 * 400 });
}

export async function getManagedKey(userId: string, provider: string, env: Env): Promise<string | null> {
  const encrypted = await env.KV.get(`managed_key:${userId}:${provider}`);
  if (!encrypted) return null;
  return decryptKey(encrypted, env.KEY_ENCRYPTION_SECRET);
}

/** Returns Zintus's own master key for a provider (Pro tier users). */
export function getZintusKey(provider: string, env: Env): string | null {
  const map: Partial<Record<string, string>> = {
    cerebras:   env.ZINTUS_CEREBRAS_KEY,
    groq:       env.ZINTUS_GROQ_KEY,
    gemini:     env.ZINTUS_GEMINI_KEY,
    deepseek:   env.ZINTUS_DEEPSEEK_KEY,
    openrouter: env.ZINTUS_OPENROUTER_KEY,
    cohere:     env.ZINTUS_COHERE_KEY,
    mistral:    env.ZINTUS_MISTRAL_KEY,
  };
  return map[provider] ?? null;
}
