import { create } from "zustand";
import { DEFAULT_CONFIG, type AppConfig, type ProviderId } from "@zintus/types";
import { loadConfig, saveConfig } from "./config";
import { fetchProviderSnapshot, type DesktopProviderInfo } from "./providers";
import type { GatewaySavings } from "./gateway";

interface SettingsState {
  settings: AppConfig;
  hydrated: boolean;
  hydrate: () => void;
  update: (partial: Partial<AppConfig>) => void;
}

interface ProviderStatusState {
  providers: DesktopProviderInfo[];
  savings: GatewaySavings | null;
  loading: boolean;
  loaded: boolean;
  statusMessage: string;
  selectedProvider: ProviderId | null;
  activeProvider: ProviderId | null;
  refresh: () => Promise<void>;
  setStatusMessage: (message: string) => void;
  setSelectedProvider: (id: ProviderId | null) => void;
  setActiveProvider: (id: ProviderId | null) => void;
}

export interface ChatMessageUi {
  id: string;
  role: "user" | "assistant";
  content: string;
  providerId?: ProviderId;
  model?: string;
}

interface ChatState {
  prompt: string;
  messages: ChatMessageUi[];
  loading: boolean;
  setPrompt: (prompt: string) => void;
  appendMessage: (message: ChatMessageUi) => void;
  updateMessage: (id: string, partial: Partial<ChatMessageUi>) => void;
  setLoading: (loading: boolean) => void;
  resetMessages: () => void;
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  savings: null,
  loading: false,
  loaded: false,
  statusMessage: "",
  selectedProvider: null,
  activeProvider: null,
  refresh: async () => {
    set({ loading: true });
    try {
      const { providers, savings } = await fetchProviderSnapshot();
      set({ providers, savings, loading: false, loaded: true });
    } catch {
      set({ loading: false, loaded: true });
    }
  },
  setStatusMessage: (statusMessage) => set({ statusMessage }),
  setSelectedProvider: (selectedProvider) => set({ selectedProvider }),
  setActiveProvider: (activeProvider) => set({ activeProvider }),
}));

export const useChatStore = create<ChatState>((set) => ({
  prompt: "",
  messages: [],
  loading: false,
  setPrompt: (prompt) => set({ prompt }),
  appendMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  updateMessage: (id, partial) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, ...partial } : message,
      ),
    })),
  setLoading: (loading) => set({ loading }),
  resetMessages: () => set({ messages: [] }),
}));

export function createChatMessage(
  role: ChatMessageUi["role"],
  content: string,
): ChatMessageUi {
  return { id: createMessageId(), role, content };
}
