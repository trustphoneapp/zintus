"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageBubble } from "@/app/_components/MessageBubble";
import { ProviderPicker } from "@/app/_components/ProviderPicker";
import { Icon } from "@/app/_components/Icons";
import {
  createAssistantPlaceholder,
  createUserMessage,
  useAppStore,
} from "@/lib/app-store";
import { streamChat, type ChatMessage } from "@/lib/chat-client";
import { useProviderStatusStore, useSettingsStore } from "@/lib/store";

const PROMPT_CARDS = [
  { title: "Explain this code", body: "Walk through a snippet step by step" },
  { title: "Write unit tests", body: "Generate tests for a function" },
  { title: "Debug an error", body: "Find the cause of a stack trace" },
  { title: "Summarize a doc", body: "Condense long text into key points" },
];

export default function ChatPage() {
  const { settings, hydrate } = useSettingsStore();
  const { keys, unlock } = useProviderStatusStore();
  const {
    messages,
    threadId,
    selectedProvider,
    gatewayConnected,
    appendMessage,
    updateMessage,
    setThreadId,
    setActiveProvider,
    pushTerminalLine,
    loadLastTrace,
    dropLastAssistant,
  } = useAppStore();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    hydrate();
    void unlock();
  }, [hydrate, unlock]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const streamAssistant = useCallback(
    async (
      assistantId: string,
      sendMessages: ChatMessage[],
      promptForLog: string,
    ) => {
      setLoading(true);
      setActiveProvider(null);
      pushTerminalLine({
        text: `$ multipleai '${promptForLog.slice(0, 64)}${promptForLog.length > 64 ? "…" : ""}'`,
        tone: "default",
      });

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await streamChat({
          messages: sendMessages,
          providerId: selectedProvider ?? undefined,
          mode: settings.contextMode,
          threadId,
          apiKeys: keys,
          settings,
          signal: controller.signal,
          onChunk: (text) => updateMessage(assistantId, text),
        });

        setActiveProvider(result.providerId);
        setThreadId(result.threadId);
        useAppStore.setState((state) => ({
          messages: state.messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  providerId: result.providerId,
                  model: result.model,
                  compileTokens: result.compileTokens,
                }
              : message,
          ),
        }));

        pushTerminalLine({
          text: `→ routed to ${result.providerId} (${result.model}) via ${result.source}`,
          tone: "success",
        });
        if (result.source === "gateway") {
          await loadLastTrace();
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Request failed";
        updateMessage(assistantId, `Error: ${message}`);
        pushTerminalLine({ text: `✗ ${message}`, tone: "warning" });
      } finally {
        setLoading(false);
      }
    },
    [
      keys,
      loadLastTrace,
      pushTerminalLine,
      selectedProvider,
      setActiveProvider,
      setThreadId,
      settings,
      threadId,
      updateMessage,
    ],
  );

  const send = useCallback(async () => {
    if (!input.trim() || loading) {
      return;
    }
    const prompt = input.trim();
    const history: ChatMessage[] = [
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: "user", content: prompt },
    ];

    appendMessage(createUserMessage(prompt));
    const assistant = createAssistantPlaceholder();
    appendMessage(assistant);
    setInput("");

    const sendMessages: ChatMessage[] =
      threadId == null ? history : [{ role: "user", content: prompt }];
    await streamAssistant(assistant.id, sendMessages, prompt);
  }, [appendMessage, input, loading, messages, streamAssistant, threadId]);

  const regenerate = useCallback(async () => {
    if (loading) {
      return;
    }
    const lastUser = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    if (!lastUser) {
      return;
    }

    dropLastAssistant();
    const assistant = createAssistantPlaceholder();
    appendMessage(assistant);

    const priorMessages = useAppStore
      .getState()
      .messages.filter(
        (message) => message.id !== assistant.id && message.content,
      )
      .map((message) => ({ role: message.role, content: message.content }));

    const sendMessages: ChatMessage[] =
      threadId == null
        ? priorMessages
        : [{ role: "user", content: lastUser.content }];
    await streamAssistant(assistant.id, sendMessages, lastUser.content);
  }, [appendMessage, dropLastAssistant, loading, messages, streamAssistant, threadId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
  }, []);

  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;

  return (
    <div className="screen chat-screen">
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-mark">
              <Icon name="zap" size={22} />
            </div>
            <h2>Ask anything</h2>
            <p>Routed automatically across your free providers.</p>
            <div className="chat-empty-cards">
              {PROMPT_CARDS.map((card) => (
                <button
                  key={card.title}
                  type="button"
                  className="chat-empty-card"
                  onClick={() => {
                    setInput(card.title);
                    inputRef.current?.focus();
                  }}
                >
                  <span className="chat-empty-card-title">{card.title}</span>
                  <span className="chat-empty-card-body">{card.body}</span>
                </button>
              ))}
            </div>
            {!gatewayConnected ? (
              <p className="chat-empty-offline">
                ⚠ Gateway offline — start it with{" "}
                <code>bun run dev:gateway</code>.
              </p>
            ) : null}
          </div>
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onRegenerate={
                message.id === lastAssistantId && !loading
                  ? regenerate
                  : undefined
              }
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-composer-wrap">
        <div className={`chat-composer${input ? " focused" : ""}`}>
          <div className="chat-composer-top">
            <ProviderPicker />
          </div>
          <div className="chat-composer-row">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                } else if (event.key === "Escape" && loading) {
                  stop();
                }
              }}
              placeholder="Ask anything — routed automatically across your free providers"
            />
            {loading ? (
              <button
                type="button"
                className="chat-send chat-stop"
                onClick={stop}
                aria-label="Stop generating"
                title="Stop (Esc)"
              >
                <Icon name="stop" size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="chat-send"
                disabled={!input.trim()}
                onClick={() => void send()}
                aria-label="Send"
                title="Send (Enter)"
              >
                <Icon name="send" size={15} />
              </button>
            )}
          </div>
        </div>
        <div className="chat-composer-hint">
          <kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> newline
          {loading ? (
            <>
              {" "}
              · <kbd>Esc</kbd> stop
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
