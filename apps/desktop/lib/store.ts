import { create } from "zustand";
import { DEFAULT_CONFIG, type AppConfig, type ProviderId } from "@multipleai/types";
import { loadConfig, saveConfig } from "./config";
import { fetchProviderInfos, type DesktopProviderInfo } from "./providers";

interface SettingsState {
  settings: AppConfig;
  hydrated: boolean;
  hydrate: () => void;
  update: (partial: Partial<AppConfig>) => void;
}

interface ProviderStatusState {
  providers: DesktopProviderInfo[];
  loading: boolean;
  statusMessage: string;
  selectedProvider: ProviderId | null;
  activeProvider: ProviderId | null;
  refresh: () => Promise<void>;
  setStatusMessage: (message: string) => void;
  setSelectedProvider: (id: ProviderId | null) => void;
  setActiveProvider: (id: ProviderId | null) => void;
}

interface ChatState {
  prompt: string;
  output: string;
  loading: boolean;
  routedModel: string | null;
  setPrompt: (prompt: string) => void;
  setOutput: (output: string) => void;
  setLoading: (loading: boolean) => void;
  setRoutedModel: (model: string | null) => void;
  resetOutput: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_CONFIG,
  hydrated: false,
  hydrate: () => {
    set({ settings: loadConfig(), hydrated: true });
  },
  update: (partial) => {
    const next = saveConfig(partial);
    set({ settings: next });
  },
}));

export const useProviderStatusStore = create<ProviderStatusState>((set) => ({
  providers: [],
  loading: false,
  statusMessage: "",
  selectedProvider: null,
  activeProvider: null,
  refresh: async () => {
    set({ loading: true });
    try {
      const providers = await fetchProviderInfos();
      set({ providers, loading: false });
    } catch {
      set({ loading: false });
    }
  },
  setStatusMessage: (statusMessage) => set({ statusMessage }),
  setSelectedProvider: (selectedProvider) => set({ selectedProvider }),
  setActiveProvider: (activeProvider) => set({ activeProvider }),
}));

export const useChatStore = create<ChatState>((set) => ({
  prompt: "",
  output: "",
  loading: false,
  routedModel: null,
  setPrompt: (prompt) => set({ prompt }),
  setOutput: (output) => set({ output }),
  setLoading: (loading) => set({ loading }),
  setRoutedModel: (routedModel) => set({ routedModel }),
  resetOutput: () => set({ output: "", routedModel: null }),
}));
