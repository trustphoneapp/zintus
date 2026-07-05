import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_CONFIG, type AppConfig, type ProviderId } from "@zintus/types";
import { loadConfig, saveConfig } from "./config";
import { fetchProviderSnapshot, type DesktopProviderInfo } from "./providers";
import type {
  CompressionStats,
  GatewaySavings,
  McpToolEvent,
  ResponseMeta,
} from "./gateway";

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
  /** Zintus MANAGED model id (e.g. "zintus/llama-3.3-70b") the chat should use.
   *  Mutually exclusive with selectedProvider: setting one clears the other —
   *  managed turns are served by the relay with plan tokens, BYOK turns by the
   *  local gateway. Null = normal gateway routing. */
  managedModel: string | null;
  refresh: () => Promise<void>;
  setStatusMessage: (message: string) => void;
  setSelectedProvider: (id: ProviderId | null) => void;
  setActiveProvider: (id: ProviderId | null) => void;
  setManagedModel: (model: string | null) => void;
}

/** A tool the model asked to call this turn, stamped on the assistant bubble so the
 *  UI can show what ran. Mirrors the web app's rendered tool calls. `arguments` is
 *  optional here (display-only); the execution path always carries a parsed object. */
export interface ToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/** Image METADATA shown on a sent user bubble. The FULL bytes ride only in the
 *  gateway request `content`, never in thread history. The `previewUrl` is a
 *  local object URL of the original picked file — session-scoped, dead after a
 *  relaunch. `thumb` is the one deliberate exception to "no base64 in history":
 *  a ≤96px JPEG data URI (a few KB, see lib/thumb.ts) so restored threads keep
 *  a real preview instead of a broken image. Mirrors web's UiImageMeta. */
export interface UiImageMeta {
  name: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  exifStripped: boolean;
  previewUrl?: string;
  thumb?: string;
}

export interface ChatMessageUi {
  id: string;
  role: "user" | "assistant";
  content: string;
  providerId?: ProviderId;
  model?: string;
  /** Tokzen compression proof for this response (null/undefined = no badge). */
  compression?: CompressionStats;
  /** Per-response transparency signals (latency, saved-vs-baseline, strategy). */
  meta?: ResponseMeta;
  /** Tool calls the model made on this assistant turn (when Tools is enabled). */
  toolCalls?: ToolCall[];
  /** Server-side MCP tool-loop activity for this assistant turn (display only —
   *  the gateway ran the tools). Calm violet activity; never the raw args/output. */
  mcpToolEvents?: McpToolEvent[];
  /** Image metadata for a sent user turn (thumbnails + size only; never base64). */
  images?: UiImageMeta[];
}

export interface Thread {
  id: string;
  title: string;
  messages: ChatMessageUi[];
  updatedAt: number;
  /** Pinned chats sort above the rest in Recents. */
  pinned?: boolean;
}

interface ChatState {
  prompt: string;
  threads: Thread[];
  activeThreadId: string;
  loading: boolean;
  setPrompt: (prompt: string) => void;
  appendMessage: (message: ChatMessageUi) => void;
  updateMessage: (id: string, partial: Partial<ChatMessageUi>) => void;
  setLoading: (loading: boolean) => void;
  resetMessages: () => void;
  newChat: () => void;
  switchThread: (id: string) => void;
  deleteThread: (id: string) => void;
  renameThread: (id: string, title: string) => void;
  togglePinThread: (id: string) => void;
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createThreadId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_THREAD: Thread = {
  id: "default",
  title: "New chat",
  messages: [],
  updatedAt: Date.now(),
};

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
  managedModel: null,
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
  setSelectedProvider: (selectedProvider) =>
    set(selectedProvider ? { selectedProvider, managedModel: null } : { selectedProvider }),
  setActiveProvider: (activeProvider) => set({ activeProvider }),
  setManagedModel: (managedModel) =>
    set(managedModel ? { managedModel, selectedProvider: null } : { managedModel }),
}));

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      prompt: "",
      threads: [{ ...DEFAULT_THREAD, updatedAt: Date.now() }],
      activeThreadId: "default",
      loading: false,
      setPrompt: (prompt) => set({ prompt }),
      appendMessage: (message) =>
        set((state) => {
          const activeId = state.activeThreadId;
          return {
            threads: state.threads.map((thread) => {
              if (thread.id !== activeId) return thread;
              // Auto-derive title from first user message
              const isFirst = thread.messages.length === 0 && message.role === "user";
              const title = isFirst
                ? message.content.slice(0, 48) || thread.title
                : thread.title;
              return {
                ...thread,
                title,
                messages: [...thread.messages, message],
                updatedAt: Date.now(),
              };
            }),
          };
        }),
      updateMessage: (id, partial) =>
        set((state) => {
          const activeId = state.activeThreadId;
          return {
            threads: state.threads.map((thread) => {
              if (thread.id !== activeId) return thread;
              return {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.id === id ? { ...message, ...partial } : message,
                ),
                updatedAt: Date.now(),
              };
            }),
          };
        }),
      setLoading: (loading) => set({ loading }),
      resetMessages: () =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === state.activeThreadId
              ? { ...thread, messages: [], updatedAt: Date.now() }
              : thread,
          ),
        })),
      newChat: () => {
        const id = createThreadId();
        set((state) => ({
          threads: [
            { id, title: "New chat", messages: [], updatedAt: Date.now() },
            ...state.threads,
          ],
          activeThreadId: id,
        }));
      },
      switchThread: (id) => set({ activeThreadId: id }),
      togglePinThread: (id) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === id ? { ...thread, pinned: !thread.pinned } : thread,
          ),
        })),
      renameThread: (id, title) =>
        set((state) => {
          const clean = title.trim().slice(0, 80);
          if (!clean) return state;
          return {
            threads: state.threads.map((thread) =>
              thread.id === id ? { ...thread, title: clean } : thread,
            ),
          };
        }),
      deleteThread: (id) => {
        const state = get();
        const remaining = state.threads.filter((t) => t.id !== id);
        const nextActive =
          state.activeThreadId === id
            ? (remaining[0]?.id ?? createThreadId())
            : state.activeThreadId;
        // If no threads remain, create a fresh one
        if (remaining.length === 0) {
          const newId = createThreadId();
          set({
            threads: [{ id: newId, title: "New chat", messages: [], updatedAt: Date.now() }],
            activeThreadId: newId,
          });
        } else {
          set({ threads: remaining, activeThreadId: nextActive });
        }
      },
    }),
    {
      name: "zintus:desktop-threads",
      partialize: (state) => ({
        threads: state.threads,
        activeThreadId: state.activeThreadId,
      }),
    },
  ),
);

export function createChatMessage(
  role: ChatMessageUi["role"],
  content: string,
  images?: UiImageMeta[],
): ChatMessageUi {
  return {
    id: createMessageId(),
    role,
    content,
    ...(images && images.length > 0 ? { images } : {}),
  };
}

// ── Zintus Cloud (membership) store ─────────────────────────────────────────

import { getCloudEmail, getMe } from "./cloud";
import {
  fetchBillingStatus,
  fetchManagedModels,
  type BillingStatus,
  type ManagedModelInfo,
} from "./billing";

interface CloudState {
  /** null = not signed in (or not yet checked). */
  email: string | null;
  authenticated: boolean;
  /** Relay billing status; null when signed out or unreachable. */
  billing: BillingStatus | null;
  /** Managed models the relay can serve RIGHT NOW (honest list). */
  managedModels: ManagedModelInfo[];
  checked: boolean;
  refreshing: boolean;
  /** Re-pull auth + billing + managed catalog from the relay. */
  refreshCloud: () => Promise<void>;
  /** Clear local state after sign-out (lib/cloud.signOut already ran). */
  resetCloud: () => void;
}

export const useCloudStore = create<CloudState>((set, get) => ({
  email: null,
  authenticated: false,
  billing: null,
  managedModels: [],
  checked: false,
  refreshing: false,
  refreshCloud: async () => {
    if (get().refreshing) return;
    set({ refreshing: true });
    try {
      // Managed catalog is public — always fetch so plans render pre-sign-in.
      const [me, managedModels] = await Promise.all([getMe(), fetchManagedModels()]);
      if (!me.authenticated) {
        set({
          authenticated: false,
          email: null,
          billing: null,
          managedModels,
          checked: true,
          refreshing: false,
        });
        return;
      }
      const billing = await fetchBillingStatus();
      set({
        authenticated: true,
        email: me.email ?? getCloudEmail(),
        billing,
        managedModels,
        checked: true,
        refreshing: false,
      });
    } catch {
      set({ checked: true, refreshing: false });
    }
  },
  resetCloud: () =>
    set({ authenticated: false, email: null, billing: null, checked: true }),
}));

/** True when the signed-in user is on an active managed (paid) tier. */
export function isActiveMember(billing: BillingStatus | null): boolean {
  return Boolean(billing && billing.tier !== "free" && billing.status === "active");
}
