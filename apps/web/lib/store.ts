import { create } from "zustand";
import { DEFAULT_CONFIG, type AppConfig, type ProviderId } from "@multipleai/types";
import { loadSettings, saveSettings } from "./settings";
import { PROVIDERS } from "./providers";
import {
  decryptKeys,
  encryptKeys,
  loadEncryptedKeys,
  saveEncryptedKeys,
} from "./crypto";

export interface WebProviderStatus {
  id: ProviderId;
  name: string;
  color: string;
  priority: number;
  hasKey: boolean;
  enabled: boolean;
  quotaUsed?: number;
  quotaLimit?: number;
}

interface SettingsState {
  settings: AppConfig;
  hydrated: boolean;
  saved: boolean;
  hydrate: () => void;
  update: (partial: Partial<AppConfig>) => void;
  clearSaved: () => void;
}

interface ProviderStatusState {
  providers: WebProviderStatus[];
  keys: Partial<Record<ProviderId, string>>;
  passphrase: string;
  selected: ProviderId;
  statusMessage: string | null;
  validating: boolean;
  setPassphrase: (passphrase: string) => void;
  setSelected: (id: ProviderId) => void;
  setStatusMessage: (message: string | null) => void;
  unlock: () => Promise<void>;
  saveKey: (providerId: ProviderId, key: string) => Promise<void>;
  removeKey: (providerId: ProviderId) => Promise<void>;
  validateKey: (providerId: ProviderId, key: string) => Promise<void>;
}

function buildProviderStatus(
  keys: Partial<Record<ProviderId, string>>,
): WebProviderStatus[] {
  return PROVIDERS.map((provider) => {
    const hasKey = Boolean(keys[provider.id]);
    return {
      id: provider.id,
      name: provider.name,
      color: provider.color,
      priority: provider.priority,
      hasKey,
      enabled: hasKey || provider.id === "ollama",
    };
  });
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_CONFIG,
  hydrated: false,
  saved: false,
  hydrate: () => {
    set({ settings: loadSettings(), hydrated: true });
  },
  update: (partial) => {
    saveSettings(partial);
    set((state) => ({
      settings: { ...state.settings, ...partial },
      saved: true,
    }));
  },
  clearSaved: () => set({ saved: false }),
}));

export const useProviderStatusStore = create<ProviderStatusState>((set, get) => ({
  providers: buildProviderStatus({}),
  keys: {},
  passphrase: "",
  selected: "groq",
  statusMessage: null,
  validating: false,
  setPassphrase: (passphrase) => set({ passphrase }),
  setSelected: (selected) => set({ selected }),
  setStatusMessage: (statusMessage) => set({ statusMessage }),
  unlock: async () => {
    const { passphrase } = get();
    const encrypted = loadEncryptedKeys();
    if (!encrypted || !passphrase) {
      set({ keys: {}, providers: buildProviderStatus({}) });
      return;
    }
    try {
      const keys = await decryptKeys(encrypted, passphrase);
      set({ keys, providers: buildProviderStatus(keys), statusMessage: null });
    } catch {
      set({
        keys: {},
        providers: buildProviderStatus({}),
        statusMessage: "Could not unlock vault. Check your passphrase.",
      });
    }
  },
  saveKey: async (providerId, key) => {
    const { passphrase, keys } = get();
    if (!passphrase) {
      set({ statusMessage: "Enter a vault passphrase first." });
      return;
    }
    const next = { ...keys, [providerId]: key };
    const encrypted = await encryptKeys(next as Record<string, string>, passphrase);
    saveEncryptedKeys(encrypted);
    set({
      keys: next,
      providers: buildProviderStatus(next),
      statusMessage: `Saved ${providerId} key locally (AES-256-GCM).`,
    });
  },
  removeKey: async (providerId) => {
    const { passphrase, keys } = get();
    if (!passphrase) {
      return;
    }
    const next = { ...keys };
    delete next[providerId];
    const encrypted = await encryptKeys(next as Record<string, string>, passphrase);
    saveEncryptedKeys(encrypted);
    set({
      keys: next,
      providers: buildProviderStatus(next),
      statusMessage: `Removed ${providerId} key.`,
    });
  },
  validateKey: async (providerId, key) => {
    set({ validating: true, statusMessage: null });
    try {
      const response = await fetch("/api/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, key }),
      });
      const result = (await response.json()) as { valid: boolean; error?: string };
      set({
        statusMessage: result.valid
          ? `${providerId} key is valid.`
          : (result.error ?? "Key validation failed."),
      });
    } catch (error) {
      set({
        statusMessage:
          error instanceof Error ? error.message : "Validation request failed.",
      });
    } finally {
      set({ validating: false });
    }
  },
}));
