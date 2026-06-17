import { create } from "zustand";
import type { ProviderId } from "@multipleai/types";
import type { GatewayProviderStatus, GatewaySavings } from "./gateway";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  providerId?: ProviderId;
  model?: string;
  compileTokens?: number;
  time: string;
}

export interface TerminalLine {
  text: string;
  tone: "default" | "accent" | "success" | "warning" | "muted" | "code";
}

interface AppState {
  messages: UiMessage[];
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
  newChat: () => void;
  dropLastAssistant: () => void;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export const useAppStore = create<AppState>((set) => ({
  messages: [],
  threadId: undefined,
  activeProvider: null,
  selectedProvider: null,
  gatewayConnected: false,
  gatewayHealthLoaded: false,
  gatewayProviders: [],
  gatewaySavings: undefined,
  terminalLines: [
    { text: "MultipleAI Terminal — type 'help' for commands", tone: "accent" },
    { text: "Runs against the gateway over HTTP (works on any OS).", tone: "muted" },
    { text: "", tone: "muted" },
  ],
  appendMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  updateMessage: (id, content) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, content } : message,
      ),
    })),
  setThreadId: (threadId) => set({ threadId }),
  setActiveProvider: (activeProvider) => set({ activeProvider }),
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
      terminalLines: [{ text: "MultipleAI Terminal — cleared", tone: "muted" }],
    }),
  newChat: () =>
    set({ messages: [], threadId: undefined, activeProvider: null }),
  dropLastAssistant: () =>
    set((state) => {
      const lastAssistant = [...state.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (!lastAssistant) {
        return {};
      }
      return {
        messages: state.messages.filter(
          (message) => message.id !== lastAssistant.id,
        ),
      };
    }),
}));

export function createUserMessage(content: string): UiMessage {
  return {
    id: `${Date.now()}-user`,
    role: "user",
    content,
    time: nowLabel(),
  };
}

export function createAssistantPlaceholder(): UiMessage {
  return {
    id: `${Date.now()}-assistant`,
    role: "assistant",
    content: "",
    time: nowLabel(),
  };
}
