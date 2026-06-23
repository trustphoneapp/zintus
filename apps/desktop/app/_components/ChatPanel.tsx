"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_IDS } from "@zintus/types";
import { streamChat, type ChatMessage } from "@/lib/chat-client";
import {
  createChatMessage,
  useChatStore,
  useProviderStatusStore,
  useSettingsStore,
} from "@/lib/store";
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

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
  }, [messages]);

  const send = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || loading) {
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Send the full conversation so multi-turn context is preserved.
    const history: ChatMessage[] = [
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: "user" as const, content: trimmed },
    ];

    const userMessage = createChatMessage("user", trimmed);
    const assistant = createChatMessage("assistant", "");
    appendMessage(userMessage);
    appendMessage(assistant);
    setPrompt("");
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
            updateMessage(assistant.id, { content: text });
          }
        },
      });

      updateMessage(assistant.id, {
        providerId: result.providerId,
        model: result.model,
      });
      setActiveProvider(result.providerId);

      void refresh();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      updateMessage(assistant.id, {
        content: error instanceof Error ? error.message : "Request failed",
      });
    } finally {
      setLoading(false);
    }
  }, [
    appendMessage,
    loading,
    messages,
    prompt,
    refresh,
    selectedProvider,
    setActiveProvider,
    setLoading,
    setPrompt,
    settings,
    updateMessage,
  ]);

  const stop = () => {
    abortRef.current?.abort();
    setLoading(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <Card className="flex min-h-0 flex-1 flex-col border-[var(--color-border)] bg-[var(--color-surface)]">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Chat</CardTitle>
          {activeProvider && (
            <Badge style={{ color: "var(--color-purple-bright)" }}>
              routed → {activeProvider}
            </Badge>
          )}
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
                setSelectedProvider(
                  value === "auto" ? null : (value as ProviderId),
                );
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
              <span className="text-sm" style={{ color: "var(--color-text-muted)" }}>
                Streamed responses appear here. Cmd+Enter to send. Auto-routes via{" "}
                {settings.routingStrategy} strategy.
              </span>
            ) : (
              messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
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
    </div>
  );
}
