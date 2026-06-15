"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ProviderId } from "@multipleai/types";
import { PROVIDER_IDS } from "@multipleai/types";
import { streamChat } from "@/lib/router";
import {
  useChatStore,
  useProviderStatusStore,
  useSettingsStore,
} from "@/lib/store";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

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
    output,
    loading,
    routedModel,
    setPrompt,
    setOutput,
    setLoading,
    setRoutedModel,
    resetOutput,
  } = useChatStore();

  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
  }, [output]);

  const send = useCallback(async () => {
    if (!prompt.trim() || loading) {
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    resetOutput();
    setActiveProvider(null);

    try {
      const result = await streamChat(
        [{ role: "user", content: prompt.trim() }],
        settings,
        {
          provider: selectedProvider ?? undefined,
          signal: controller.signal,
        },
      );

      setActiveProvider(result.providerId);
      setRoutedModel(result.model);
      let text = "";

      for await (const chunk of result.stream) {
        if (controller.signal.aborted) {
          break;
        }
        text += chunk;
        setOutput(text);
      }

      void refresh();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      setOutput(error instanceof Error ? error.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, [
    loading,
    prompt,
    refresh,
    resetOutput,
    selectedProvider,
    setActiveProvider,
    setLoading,
    setOutput,
    setRoutedModel,
    settings,
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
              {routedModel ? ` · ${routedModel}` : ""}
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

          <Textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask anything..."
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                void send();
              }
            }}
          />

          <div className="flex gap-2">
            <Button type="button" onClick={() => void send()} disabled={loading || !prompt}>
              {loading ? "Streaming..." : "Send"}
            </Button>
            {loading && (
              <Button type="button" variant="secondary" onClick={stop}>
                Stop
              </Button>
            )}
          </div>

          <div
            ref={outputRef}
            className="output min-h-0 flex-1 overflow-auto whitespace-pre-wrap"
          >
            {output || (
              <span style={{ color: "var(--color-text-muted)" }}>
                Streamed responses appear here. Cmd+Enter to send. Auto-routes via{" "}
                {settings.routingStrategy} strategy.
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
