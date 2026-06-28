import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProviderId } from "@zintus/types";
import type {
  ChatMeta,
  CompressionStats,
  GatewayProviderStatus,
  GatewaySavings,
  McpToolEvent,
} from "./gateway";

/** Image-attachment metadata shown on a sent user bubble. Metadata ONLY — the
 *  base64 image bytes are never persisted in chat history. */
export interface UiImageMeta {
  name: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  exifStripped: boolean;
  /** In-memory object URL of the original file, for a bubble thumbnail. NEVER
   *  base64 and not meaningfully persisted — a `blob:` URL is dead after reload,
   *  so the bubble falls back to the metadata chip. */
  previewUrl?: string;
}

/** A single tool/function call surfaced on an assistant turn (rendered as a card). */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw args — a JSON string or an already-parsed object. */
  arguments?: unknown;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  providerId?: ProviderId;
  model?: string;
  compileTokens?: number;
  /** Per-response transparency metadata (tokens, latency, savings). */
  meta?: ChatMeta;
  /** Compression savings for this response (present only on a real hit). */
  compression?: CompressionStats;
  /** Image attachments sent with THIS user turn — metadata only, never base64. */
  images?: UiImageMeta[];
  /** Tool calls the assistant made on this turn (rendered as call cards). */
  toolCalls?: ToolCall[];
  /** Server-side MCP tool-loop activity for this turn (call/result lines). */
  mcpToolEvents?: McpToolEvent[];
  time: string;
}

export interface TerminalLine {
  text: string;
  tone: "default" | "accent" | "success" | "warning" | "muted" | "code";
}

export interface Thread {
  id: string;
  title: string;
  messages: UiMessage[];
  activeProvider: ProviderId | null;
  /** Gateway-assigned thread id used for server-side context continuity. */
  gatewayThreadId?: string;
  /** Incognito threads are never persisted to disk (see persist partialize). */
  incognito?: boolean;
  createdAt: number;
  updatedAt: number;
}

interface AppState {
  threads: Thread[];
  activeThreadId: string;
  /** @deprecated mirrors the active thread's gatewayThreadId; kept for chat-client compat */
  threadId?: string;
  activeProvider: ProviderId | null;
  selectedProvider: ProviderId | null;
  gatewayConnected: boolean;
  gatewayHealthLoaded: boolean;
  gatewayProviders: GatewayProviderStatus[];
  gatewaySavings?: GatewaySavings;
  terminalLines: TerminalLine[];
  appendMessage: (message: UiMessage) => void;
  updateMessage: (id: string, content: string) => void;
  patchMessage: (id: string, patch: Partial<Pick<UiMessage, "providerId" | "model" | "compileTokens" | "meta" | "compression" | "toolCalls" | "mcpToolEvents">>) => void;
  setThreadId: (threadId?: string) => void;
  setActiveProvider: (providerId: ProviderId | null) => void;
  setSelectedProvider: (providerId: ProviderId | null) => void;
  setGatewayStatus: (
    connected: boolean,
    providers: GatewayProviderStatus[],
    savings?: GatewaySavings,
  ) => void;
  pushTerminalLine: (line: TerminalLine) => void;
  loadLastTrace: () => Promise<void>;
  clearTerminal: () => void;
  newChat: (incognito?: boolean) => void;
  dropLastAssistant: () => void;
  switchThread: (id: string) => void;
  renameThread: (id: string, title: string) => void;
  deleteThread: (id: string) => void;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function makeThreadId(): string {
  return `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createThread(incognito = false): Thread {
  const now = Date.now();
  return {
    id: makeThreadId(),
    title: incognito ? "Incognito chat" : "New chat",
    messages: [],
    activeProvider: null,
    gatewayThreadId: undefined,
    incognito,
    createdAt: now,
    updatedAt: now,
  };
}

/** Derive a short thread title from the first user message. */
function deriveTitle(messages: UiMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser || !firstUser.content.trim()) {
    return "New chat";
  }
  const text = firstUser.content.trim().replace(/\s+/g, " ");
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

function updateThread(
  threads: Thread[],
  id: string,
  updater: (thread: Thread) => Thread,
): Thread[] {
  return threads.map((thread) => (thread.id === id ? updater(thread) : thread));
}

const initialThread = createThread();

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      threads: [initialThread],
      activeThreadId: initialThread.id,
      threadId: undefined,
      activeProvider: null,
      selectedProvider: null,
      gatewayConnected: false,
      gatewayHealthLoaded: false,
      gatewayProviders: [],
      gatewaySavings: undefined,
      terminalLines: [
        { text: "Zintus Terminal — type 'help' for commands", tone: "accent" },
        { text: "Runs against the gateway over HTTP (works on any OS).", tone: "muted" },
        { text: "", tone: "muted" },
      ],
      appendMessage: (message) =>
        set((state) => ({
          threads: updateThread(state.threads, state.activeThreadId, (thread) => {
            const messages = [...thread.messages, message];
            return {
              ...thread,
              messages,
              title:
                thread.title === "New chat" ? deriveTitle(messages) : thread.title,
              updatedAt: Date.now(),
            };
          }),
        })),
      updateMessage: (id, content) =>
        set((state) => ({
          threads: updateThread(state.threads, state.activeThreadId, (thread) => ({
            ...thread,
            messages: thread.messages.map((message) =>
              message.id === id ? { ...message, content } : message,
            ),
            updatedAt: Date.now(),
          })),
        })),
      patchMessage: (id, patch) =>
        set((state) => ({
          threads: updateThread(state.threads, state.activeThreadId, (thread) => ({
            ...thread,
            messages: thread.messages.map((message) =>
              message.id === id ? { ...message, ...patch } : message,
            ),
          })),
        })),
      setThreadId: (threadId) =>
        set((state) => ({
          threadId,
          threads: updateThread(state.threads, state.activeThreadId, (thread) => ({
            ...thread,
            gatewayThreadId: threadId,
          })),
        })),
      setActiveProvider: (activeProvider) =>
        set((state) => ({
          activeProvider,
          threads: updateThread(state.threads, state.activeThreadId, (thread) => ({
            ...thread,
            activeProvider,
          })),
        })),
      setSelectedProvider: (selectedProvider) => set({ selectedProvider }),
      setGatewayStatus: (gatewayConnected, gatewayProviders, gatewaySavings) =>
        set({
          gatewayConnected,
          gatewayProviders,
          gatewaySavings,
          gatewayHealthLoaded: true,
        }),
      pushTerminalLine: (line) =>
        set((state) => ({ terminalLines: [...state.terminalLines, line] })),
      loadLastTrace: async () => {
        const { fetchLastTrace } = await import("./gateway");
        const trace = await fetchLastTrace();

        if (!trace?.trace) {
          set((state) => ({
            terminalLines: [
              ...state.terminalLines,
              { text: "→ no gateway trace available", tone: "muted" },
            ],
          }));
          return;
        }

        const lines: TerminalLine[] = [];
        for (const attempt of trace.trace.attempts) {
          lines.push({
            text:
              attempt.status === "fail"
                ? `  ✗ ${attempt.providerId}/${attempt.model} — ${attempt.errorMessage ?? "failed"}`
                : `  ✓ ${attempt.providerId}/${attempt.model} — ${attempt.latencyMs}ms`,
            tone: attempt.status === "fail" ? "warning" : "muted",
          });
        }

        if (trace.trace.winner) {
          lines.push({
            text: `→ winner ${trace.trace.winner.providerId}/${trace.trace.winner.model}`,
            tone: "success",
          });
        }

        if (trace.trace.totalLatencyMs != null) {
          lines.push({
            text: `⟨ trace ${trace.trace.traceId} · ${trace.trace.totalLatencyMs}ms ⟩`,
            tone: "code",
          });
        }

        set((state) => ({
          terminalLines: [...state.terminalLines, ...lines],
        }));
      },
      clearTerminal: () =>
        set({
          terminalLines: [{ text: "Zintus Terminal — cleared", tone: "muted" }],
        }),
      newChat: (incognito = false) => {
        const thread = createThread(incognito);
        set((state) => ({
          threads: [thread, ...state.threads],
          activeThreadId: thread.id,
          threadId: undefined,
          activeProvider: null,
        }));
      },
      dropLastAssistant: () =>
        set((state) => {
          const active = state.threads.find(
            (thread) => thread.id === state.activeThreadId,
          );
          if (!active) {
            return {};
          }
          const lastAssistant = [...active.messages]
            .reverse()
            .find((message) => message.role === "assistant");
          if (!lastAssistant) {
            return {};
          }
          return {
            threads: updateThread(state.threads, state.activeThreadId, (thread) => ({
              ...thread,
              messages: thread.messages.filter(
                (message) => message.id !== lastAssistant.id,
              ),
            })),
          };
        }),
      switchThread: (id) =>
        set((state) => {
          const thread = state.threads.find((item) => item.id === id);
          if (!thread) {
            return {};
          }
          return {
            activeThreadId: id,
            threadId: thread.gatewayThreadId,
            activeProvider: thread.activeProvider,
          };
        }),
      renameThread: (id, title) =>
        set((state) => ({
          threads: updateThread(state.threads, id, (thread) => ({
            ...thread,
            title: title.trim() || "New chat",
            updatedAt: Date.now(),
          })),
        })),
      deleteThread: (id) =>
        set((state) => {
          const remaining = state.threads.filter((thread) => thread.id !== id);
          if (state.activeThreadId !== id) {
            return { threads: remaining };
          }
          // Deleted the active thread — fall back to the most recently
          // updated remaining thread, or create a fresh one if none are left.
          const next = [...remaining].sort((a, b) => b.updatedAt - a.updatedAt)[0];
          if (next) {
            return {
              threads: remaining,
              activeThreadId: next.id,
              threadId: next.gatewayThreadId,
              activeProvider: next.activeProvider,
            };
          }
          const thread = createThread();
          return {
            threads: [thread],
            activeThreadId: thread.id,
            threadId: undefined,
            activeProvider: null,
          };
        }),
    }),
    {
      name: "zintus-chat-threads",
      // Incognito threads never touch disk. If the active thread is incognito,
      // fall back to the newest persisted thread so reload lands somewhere valid.
      partialize: (state) => {
        const threads = state.threads.filter((t) => !t.incognito);
        const activeThreadId = threads.some((t) => t.id === state.activeThreadId)
          ? state.activeThreadId
          : (threads[0]?.id ?? state.activeThreadId);
        return { threads, activeThreadId };
      },
    },
  ),
);

export function createUserMessage(
  content: string,
  images?: UiImageMeta[],
): UiMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content,
    ...(images && images.length > 0 ? { images } : {}),
    time: nowLabel(),
  };
}

export function createAssistantPlaceholder(): UiMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    time: nowLabel(),
  };
}
