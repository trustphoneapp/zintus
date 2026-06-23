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

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".ts", ".js", ".tsx", ".jsx", ".py",
  ".json", ".sh", ".yaml", ".toml", ".rs", ".go", ".css",
]);

interface Attachment {
  id: string;
  name: string;
  type: "image" | "text";
  content: string;
  mimeType: string;
}

/**
 * Which web-search strategy the gateway will use for the selected provider —
 * surfaced as the toggle's tooltip so the cost/path is clear before sending.
 * Mirrors getSearchStrategy() in @zintus/search.
 */
function searchTooltip(provider: string | null): string {
  switch (provider) {
    case "groq":
      return "Using Groq Compound (free)";
    case "gemini":
      return "Using Google Search grounding (free)";
    case "openrouter":
      return "Using OpenRouter web search (free)";
    case null:
      return "Web search on — provider (and strategy) chosen at routing time";
    default:
      return "Requires TAVILY_API_KEY on the gateway, or Tavily/Serper fallback";
  }
}

export default function ChatPage() {
  const { settings, hydrate } = useSettingsStore();
  const { keys, unlock } = useProviderStatusStore();
  const {
    threadId,
    activeThreadId,
    selectedProvider,
    gatewayConnected,
    appendMessage,
    updateMessage,
    patchMessage,
    setThreadId,
    setActiveProvider,
    pushTerminalLine,
    loadLastTrace,
    dropLastAssistant,
  } = useAppStore();
  const messages = useAppStore(
    (state) =>
      state.threads.find((t) => t.id === state.activeThreadId)?.messages ?? [],
  );
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // File attachments
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Web search toggle (persisted to localStorage)
  const [webSearchEnabled, setWebSearchEnabled] = useState(() => {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("zintus:web-search") === "true";
    }
    return false;
  });

  useEffect(() => {
    hydrate();
    void unlock();
  }, [hydrate, unlock]);

  // Switching to a different thread (via the sidebar) should drop any
  // in-flight stream from the previous thread and reset composer state —
  // otherwise a still-streaming response could land on the wrong thread.
  useEffect(() => {
    abortRef.current?.abort();
    setLoading(false);
    setInput("");
  }, [activeThreadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    for (const file of fileArray) {
      const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");
      const isImage = file.type.startsWith("image/");
      const isText = TEXT_EXTENSIONS.has(ext);

      if (!isImage && !isText) continue;

      const id = crypto.randomUUID();
      const reader = new FileReader();

      if (isImage) {
        reader.onload = (e) => {
          const content = e.target?.result as string;
          setAttachments((prev) => [
            ...prev,
            { id, name: file.name, type: "image", content, mimeType: file.type },
          ]);
        };
        reader.readAsDataURL(file);
      } else {
        reader.onload = (e) => {
          const content = e.target?.result as string;
          setAttachments((prev) => [
            ...prev,
            { id, name: file.name, type: "text", content, mimeType: file.type || "text/plain" },
          ]);
        };
        reader.readAsText(file);
      }
    }
  }, []);

  const streamAssistant = useCallback(
    async (
      assistantId: string,
      sendMessages: ChatMessage[],
      promptForLog: string,
      sendImages: Array<{ data: string; mimeType: string; name: string }>,
    ) => {
      setLoading(true);
      setActiveProvider(null);
      pushTerminalLine({
        text: `$ zintus '${promptForLog.slice(0, 64)}${promptForLog.length > 64 ? "…" : ""}'`,
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
          webSearch: webSearchEnabled,
          images: sendImages,
          signal: controller.signal,
          onChunk: (text) => updateMessage(assistantId, text),
        });

        setActiveProvider(result.providerId);
        setThreadId(result.threadId);
        patchMessage(assistantId, {
          providerId: result.providerId,
          model: result.model,
          compileTokens: result.compileTokens,
        });

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
      patchMessage,
      pushTerminalLine,
      selectedProvider,
      setActiveProvider,
      setThreadId,
      settings,
      threadId,
      updateMessage,
      webSearchEnabled,
    ],
  );

  const send = useCallback(async () => {
    if (!input.trim() || loading) {
      return;
    }
    const prompt = input.trim();

    // Build user content with attachments
    let textPrefix = "";
    const imageNotes: string[] = [];
    const sendImages: Array<{ data: string; mimeType: string; name: string }> = [];

    for (const att of attachments) {
      if (att.type === "text") {
        const ext = att.name.split(".").pop() ?? "txt";
        textPrefix += `[File: ${att.name}]\n\`\`\`${ext}\n${att.content}\n\`\`\`\n\n`;
      } else {
        imageNotes.push(`[Image: ${att.name} — see attached]`);
        const base64 = att.content.includes(",") ? (att.content.split(",")[1] ?? att.content) : att.content;
        sendImages.push({ data: base64, mimeType: att.mimeType, name: att.name });
      }
    }

    const userContent = (
      textPrefix + prompt.trim() + (imageNotes.length ? "\n\n" + imageNotes.join("\n") : "")
    ).trim();

    const history: ChatMessage[] = [
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: "user", content: userContent },
    ];

    appendMessage(createUserMessage(userContent));
    const assistant = createAssistantPlaceholder();
    appendMessage(assistant);
    setInput("");
    setAttachments([]);

    const sendMessages: ChatMessage[] =
      threadId == null ? history : [{ role: "user", content: userContent }];
    await streamAssistant(assistant.id, sendMessages, prompt, sendImages);
  }, [appendMessage, attachments, input, loading, messages, streamAssistant, threadId]);

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

    const s = useAppStore.getState();
    const priorMessages = (
      s.threads.find((t) => t.id === s.activeThreadId)?.messages ?? []
    )
      .filter((message) => message.id !== assistant.id && message.content)
      .map((message) => ({ role: message.role, content: message.content }));

    const sendMessages: ChatMessage[] =
      threadId == null
        ? priorMessages
        : [{ role: "user", content: lastUser.content }];
    await streamAssistant(assistant.id, sendMessages, lastUser.content, []);
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
        <div
          className={`chat-composer${input ? " focused" : ""}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFiles(e.dataTransfer.files);
          }}
        >
          <div className="chat-composer-top">
            <ProviderPicker />
            <button
              type="button"
              className={`chat-tool-toggle${webSearchEnabled ? " active" : ""}`}
              onClick={() => {
                setWebSearchEnabled((v) => {
                  const next = !v;
                  if (typeof localStorage !== "undefined") {
                    localStorage.setItem("zintus:web-search", String(next));
                  }
                  return next;
                });
              }}
              title={searchTooltip(selectedProvider)}
            >
              <Icon name="globe" size={13} />
              Search
            </button>
          </div>
          {attachments.length > 0 && (
            <div className="chat-attachments">
              {attachments.map((att) => (
                <div key={att.id} className="chat-attachment-chip">
                  {att.type === "image" ? (
                    <img src={att.content} alt={att.name} className="chat-attachment-thumb" />
                  ) : (
                    <Icon name="paperclip" size={12} />
                  )}
                  <span className="chat-attachment-name">{att.name}</span>
                  <button
                    type="button"
                    className="chat-attachment-remove"
                    onClick={() =>
                      setAttachments((prev) => prev.filter((a) => a.id !== att.id))
                    }
                    aria-label="Remove"
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-composer-row">
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*,.txt,.md,.ts,.js,.tsx,.jsx,.py,.json,.sh,.yaml,.toml,.rs,.go,.css"
              multiple
              style={{ display: "none" }}
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />
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
              onPaste={(e) => {
                if (e.clipboardData.files.length > 0) {
                  handleFiles(e.clipboardData.files);
                }
              }}
              placeholder="Ask anything — routed automatically across your free providers"
            />
            <button
              type="button"
              className="chat-attach"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach file"
              title="Attach file"
            >
              <Icon name="paperclip" size={15} />
            </button>
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
