"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_IDS } from "@zintus/types";
import { streamChat, type ChatMessage } from "@/lib/chat-client";
import {
  createChatMessage,
  useChatStore,
  useProviderStatusStore,
  useSettingsStore,
} from "@/lib/store";
import {
  DATA_FLOW,
  grantProviderSendConsent,
  hasProviderSendConsent,
} from "@/lib/consent";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { MessageBubble } from "./MessageBubble";

export function ChatPanel() {
  const { settings, hydrate } = useSettingsStore();
  const {
    selectedProvider,
    activeProvider,
    setSelectedProvider,
    setActiveProvider,
    refresh,
  } = useProviderStatusStore();
  const {
    prompt,
    threads,
    activeThreadId,
    loading,
    setPrompt,
    appendMessage,
    updateMessage,
    setLoading,
  } = useChatStore();

  const messages = threads.find((t) => t.id === activeThreadId)?.messages ?? [];

  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
  }, [messages]);

  // Shared streaming path used by both send and regenerate.
  const runTurn = useCallback(
    async (history: ChatMessage[], assistantId: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setActiveProvider(null);
      try {
        const result = await streamChat({
          messages: history,
          settings,
          providerId: selectedProvider ?? undefined,
          mode: settings.contextMode,
          signal: controller.signal,
          onChunk: (text) => {
            if (!controller.signal.aborted) {
              updateMessage(assistantId, { content: text });
            }
          },
        });
        updateMessage(assistantId, {
          providerId: result.providerId,
          model: result.model,
          compression: result.compression,
        });
        setActiveProvider(result.providerId);
        void refresh();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        updateMessage(assistantId, {
          content: error instanceof Error ? error.message : "Request failed",
        });
      } finally {
        setLoading(false);
      }
    },
    [settings, selectedProvider, setActiveProvider, setLoading, updateMessage, refresh],
  );

  const doSend = useCallback(
    async (trimmed: string) => {
      const history: ChatMessage[] = [
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: trimmed },
      ];
      appendMessage(createChatMessage("user", trimmed));
      const assistant = createChatMessage("assistant", "");
      appendMessage(assistant);
      setPrompt("");
      await runTurn(history, assistant.id);
    },
    [messages, appendMessage, setPrompt, runTurn],
  );

  const send = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed || loading) {
      return;
    }
    // Consent before the first send to a third-party provider (parity w/ mobile).
    if (!hasProviderSendConsent()) {
      setPendingPrompt(trimmed);
      setConsentOpen(true);
      return;
    }
    void doSend(trimmed);
  }, [prompt, loading, doSend]);

  function grantAndSend() {
    grantProviderSendConsent();
    setConsentOpen(false);
    const p = pendingPrompt;
    setPendingPrompt(null);
    if (p) void doSend(p);
  }

  const regenerate = useCallback(async () => {
    if (loading) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;
    const idx = messages.findIndex((m) => m.id === lastAssistant.id);
    const history = messages
      .slice(0, idx)
      .map((m) => ({ role: m.role, content: m.content }));
    if (history.length === 0) return;
    updateMessage(lastAssistant.id, { content: "" });
    await runTurn(history, lastAssistant.id);
  }, [loading, messages, runTurn, updateMessage]);

  const stop = () => {
    abortRef.current?.abort();
    setLoading(false);
  };

  const exportThread = useCallback(() => {
    if (messages.length === 0) return;
    const md = messages
      .map(
        (m) =>
          `**${m.role === "user" ? "You" : (m.providerId ?? "Assistant")}:**\n\n${m.content}`,
      )
      .join("\n\n---\n\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "zintus-chat.md";
    a.click();
    URL.revokeObjectURL(url);
  }, [messages]);

  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <Card className="flex min-h-0 flex-1 flex-col border-[var(--color-border)] bg-[var(--color-surface)]">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Chat</CardTitle>
          <div className="flex items-center gap-2">
            {activeProvider && (
              <Badge style={{ color: "var(--color-purple-bright)" }}>
                routed → {activeProvider}
              </Badge>
            )}
            {messages.length > 0 && (
              <Button type="button" variant="secondary" onClick={exportThread}>
                Export
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-[var(--color-text-muted)]" htmlFor="provider-select">
              Override
            </label>
            <select
              id="provider-select"
              value={selectedProvider ?? "auto"}
              onChange={(e) => {
                const value = e.target.value;
                setSelectedProvider(value === "auto" ? null : (value as ProviderId));
              }}
              className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 text-sm"
            >
              <option value="auto">Auto ({settings.routingStrategy})</option>
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>

          <div
            ref={outputRef}
            className="min-h-0 flex-1 overflow-auto"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            {messages.length === 0 ? (
              <div
                style={{
                  margin: "auto",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  textAlign: "center",
                  padding: "40px 16px",
                  color: "var(--color-text-muted)",
                }}
              >
                <div
                  aria-hidden
                  style={{
                    display: "grid",
                    placeItems: "center",
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: "var(--color-elevated)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <MessageSquarePlus size={20} />
                </div>
                <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--color-text)" }}>
                  Ask anything
                </span>
                <span style={{ fontSize: 13, lineHeight: 1.5, maxWidth: 300 }}>
                  Responses stream in here. Press ⌘↵ to send — auto-routes via the{" "}
                  {settings.routingStrategy} strategy.
                </span>
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onRegenerate={
                    message.id === lastAssistantId && !loading ? regenerate : undefined
                  }
                />
              ))
            )}
          </div>

          <Textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask anything..."
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />

          <div className="flex gap-2">
            <Button type="button" onClick={() => void send()} disabled={loading || !prompt.trim()}>
              {loading ? "Streaming..." : "Send"}
            </Button>
            {loading && (
              <Button type="button" variant="secondary" onClick={stop}>
                Stop
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {consentOpen && (
        <div className="consent-backdrop" role="dialog" aria-modal="true">
          <div className="consent-card">
            <h2 className="consent-title">Before your first send</h2>
            <p className="consent-body">
              Your message goes to the AI provider you choose, routed through your
              own gateway. Here&apos;s exactly where data travels:
            </p>
            <div className="consent-flow">
              {DATA_FLOW.map((item) => (
                <div key={item.data} className="consent-flow-item">
                  <span className="consent-flow-dest">{item.dest}</span>
                  <span className="consent-flow-data">{item.data}</span>
                  <span className="consent-flow-detail">{item.detail}</span>
                </div>
              ))}
            </div>
            <div className="consent-actions">
              <Button type="button" variant="secondary" onClick={() => setConsentOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={grantAndSend}>
                Got it — send
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
