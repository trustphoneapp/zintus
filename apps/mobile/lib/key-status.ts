/**
 * Local key-presence map. Reports, per provider, whether a key is currently
 * stored in expo-secure-store (the "zintus:key:" scheme). Local runtimes
 * (ollama/lmstudio) take no key, so they always report `true`.
 *
 * There is intentionally NO `anthropic` entry — Zintus ships no Anthropic provider.
 */

import { listProviders } from "@zintus/providers";
import type { ProviderId } from "@zintus/types";
import { hasApiKey } from "@/lib/keys";

export async function getLocalKeyStatus(): Promise<Record<ProviderId, boolean>> {
  const providers = listProviders();
  const entries = await Promise.all(
    providers.map(async (provider): Promise<[ProviderId, boolean]> => {
      // Local runtimes need no key.
      if (provider.id === "ollama" || provider.id === "lmstudio") {
        return [provider.id, true];
      }
      return [provider.id, await hasApiKey(provider.id)];
    }),
  );
  return Object.fromEntries(entries) as Record<ProviderId, boolean>;
}
