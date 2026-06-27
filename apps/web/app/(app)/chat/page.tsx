"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { MessageBubble } from "@/app/_components/MessageBubble";
import { ProviderPicker } from "@/app/_components/ProviderPicker";
import { LocalKeyManager } from "@/app/_components/LocalKeyManager";
import { ConsentDialog } from "@/app/_components/ConsentDialog";
import { Icon } from "@/app/_components/Icons";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  createAssistantPlaceholder,
  createUserMessage,
  useAppStore,
} from "@/lib/app-store";
import { streamChat, type ChatMessage } from "@/lib/chat-client";
import { memorySystemMessage } from "@/lib/memory";
import { downloadFile } from "@/lib/download";
import {
  grantProviderSendConsent,
  hasProviderSendConsent,
} from "@/lib/consent";
import { getActiveProject, setActiveProjectId } from "@/lib/projects";
import { loadPresets, type Preset } from "@/lib/presets";
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
  const { settings, hydrate, update: updateSettings } = useSettingsStore();
  const { unlock } = useProviderStatusStore();
  // Atomic value selectors — re-render only when these specific fields change
  // (not on unrelated store writes like terminal-line spam or savings updates).
  const threadId = useAppStore((s) => s.threadId);
  const activeThreadId = useAppStore((s) => s.activeThreadId);
  const selectedProvider = useAppStore((s) => s.selectedProvider);
  const gatewayConnected = useAppStore((s) => s.gatewayConnected);
  // Actions have stable identity — useShallow over the bag never re-renders.
  const {
    appendMessage,
    updateMessage,
    patchMessage,
    setThreadId,
    setActiveProvider,
    pushTerminalLine,
    loadLastTrace,
    dropLastAssistant,
    newChat,
    setSelectedProvider,
  } = useAppStore(
    useShallow((s) => ({
      appendMessage: s.appendMessage,
      updateMessage: s.updateMessage,
      patchMessage: s.patchMessage,
      setThreadId: s.setThreadId,
      setActiveProvider: s.setActiveProvider,
      pushTerminalLine: s.pushTerminalLine,
      loadLastTrace: s.loadLastTrace,
      dropLastAssistant: s.dropLastAssistant,
      newChat: s.newChat,
      setSelectedProvider: s.setSelectedProvider,
    })),
  );
  const messages = useAppStore(
    (state) =>
      state.threads.find((t) => t.id === state.activeThreadId)?.messages ?? [],
  );
  const incognito = useAppStore(
    (state) =>
      state.threads.find((t) => t.id === state.activeThreadId)?.incognito ??
      false,
  );
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [keyManagerOpen, setKeyManagerOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [imageUnsupported, setImageUnsupported] = useState(false);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  // Local mode = no cloud session cookie. Set after mount to avoid an SSR/CSR
  // hydration mismatch (document.cookie is client-only).
  const [localMode, setLocalMode] = useState(false);
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
    setLocalMode(!document.cookie.includes("zintus_session="));
    setPresets(loadPresets());
    setActiveProjectName(getActiveProject()?.name ?? null);
  }, [hydrate, unlock]);

  const applyPreset = useCallback(
    (preset: Preset | null) => {
      setActivePreset(preset);
      if (!preset) return;
      if (preset.provider) setSelectedProvider(preset.provider);
      if (preset.strategy) updateSettings({ routingStrategy: preset.strategy });
    },
    [setSelectedProvider, updateSettings],
  );

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

  // Abort any in-flight stream when leaving the page (mirrors /compare, /research).
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    for (const file of fileArray) {
      const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");
      const isImage = file.type.startsWith("image/");
      const isText = TEXT_EXTENSIONS.has(ext);

      // Images are NOT wired end-to-end yet: the gateway has no multimodal path
      // (content is z.string()). Refuse them rather than silently drop the bytes
      // AND inject a fake "[Image: … see attached]" note the model never gets.
      // Text files DO work (extracted + sent inline). See docs/multimodal-image-plan.md.
      if (isImage) {
        setImageUnsupported(true);
        continue;
      }
      if (!isText) continue;

      const id = crypto.randomUUID();
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setAttachments((prev) => [
          ...prev,
          { id, name: file.name, type: "text", content, mimeType: file.type || "text/plain" },
        ]);
      };
      reader.readAsText(file);
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
          // Read fresh: the LocalKeyManager may have just populated the vault and
          // re-invoked send() before this component re-rendered with new keys.
          apiKeys: useProviderStatusStore.getState().keys,
          // Incognito prefers non-training providers regardless of the saved pref.
          settings: incognito
            ? { ...settings, blockTrainingProviders: true }
            : settings,
          webSearch: webSearchEnabled,
          temperature: activePreset?.temperature,
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
          meta: result.meta,
          compression: result.compression,
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
      incognito,
      activePreset,
    ],
  );

  const send = useCallback(async () => {
    if (!input.trim() || loading) {
      return;
    }
    // No usable keys anywhere (browser vault locked/empty AND gateway unconfigured)
    // → guide the user to add one, then retry. Input is preserved.
    const haveBrowserKeys =
      Object.keys(useProviderStatusStore.getState().keys).length > 0;
    const gatewayHasKeys = useAppStore
      .getState()
      .gatewayProviders.some((provider) => provider.hasKey);
    if (!haveBrowserKeys && !gatewayHasKeys) {
      setKeyManagerOpen(true);
      return;
    }
    // Consent before the first send to a third-party provider (parity w/ mobile+desktop).
    if (!hasProviderSendConsent()) {
      setConsentOpen(true);
      return;
    }
    const prompt = input.trim();

    // Build user content from text attachments only (images are unsupported
    // end-to-end — see handleFiles; no fake image notes are injected).
    let textPrefix = "";
    for (const att of attachments) {
      const ext = att.name.split(".").pop() ?? "txt";
      textPrefix += `[File: ${att.name}]\n\`\`\`${ext}\n${att.content}\n\`\`\`\n\n`;
    }

    const userContent = (textPrefix + prompt.trim()).trim();

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

    // Leading system messages, injected once at the start of a new conversation
    // (full history sent; server owns context afterwards). Incognito skips memory.
    const leading: ChatMessage[] = [];
    if (threadId == null) {
      if (!incognito) {
        const memoryMsg = memorySystemMessage();
        if (memoryMsg) leading.push(memoryMsg);
      }
      if (activePreset?.systemPrompt?.trim()) {
        leading.push({ role: "system", content: activePreset.systemPrompt.trim() });
      }
      const activeProject = getActiveProject();
      if (activeProject?.instructions) {
        leading.push({ role: "system", content: activeProject.instructions });
      }
    }
    const sendMessages: ChatMessage[] =
      threadId == null
        ? [...leading, ...history]
        : [{ role: "user", content: userContent }];
    await streamAssistant(assistant.id, sendMessages, prompt, []);
  }, [activePreset, appendMessage, attachments, incognito, input, loading, messages, streamAssistant, threadId]);

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

  const exportThread = useCallback(() => {
    if (messages.length === 0) return;
    const md = messages
      .map((m) => {
        const who = m.role === "user" ? "You" : (m.providerId ?? "Assistant");
        return `**${who}:**\n\n${m.content}`;
      })
      .join("\n\n---\n\n");
    downloadFile("zintus-chat.md", md, "text/markdown");
  }, [messages]);

  return (
    <div className="screen chat-screen">
      {incognito ? (
        <div className="chat-local-banner chat-incognito-banner">
          <span>🕶 Incognito — nothing is saved, and only non-training providers are used.</span>
        </div>
      ) : localMode ? (
        <div className="chat-local-banner">
          <span>Local mode — chats stay on this device.</span>
          <a href="/login">Sign in to sync across devices →</a>
        </div>
      ) : null}
      <LocalKeyManager
        open={keyManagerOpen}
        onClose={() => setKeyManagerOpen(false)}
        onReady={() => {
          setKeyManagerOpen(false);
          void send();
        }}
      />
      <ConsentDialog
        open={consentOpen}
        onCancel={() => setConsentOpen(false)}
        onGrant={() => {
          grantProviderSendConsent();
          setConsentOpen(false);
          void send();
        }}
      />
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
              <div className="chat-empty-offline" role="status">
                <p className="chat-empty-offline-title">
                  No gateway connected
                </p>
                <p>
                  Zintus is local-first and BYOK — you run the gateway on your
                  machine and your provider keys never leave your device. Start
                  it, then this chat connects automatically.
                </p>
                <pre className="chat-empty-offline-cmd">
                  <code>zintus serve</code>
                </pre>
                <p className="chat-empty-offline-links">
                  <a href="/docs#self-host">Self-host guide →</a>
                  <a href="/download">Download Zintus →</a>
                </p>
                <p className="chat-empty-offline-hint">
                  Already running it elsewhere? Point{" "}
                  <code>NEXT_PUBLIC_GATEWAY_URL</code> at that host.
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              isStreaming={loading && message.id === lastAssistantId}
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
            {presets.length > 0 ? (
              <select
                className="chat-preset-select"
                value={activePreset?.id ?? ""}
                onChange={(event) =>
                  applyPreset(
                    presets.find((p) => p.id === event.target.value) ?? null,
                  )
                }
                title="Apply a saved preset"
              >
                <option value="">No preset</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            ) : null}
            {settings.blockTrainingProviders ? (
              <span
                className="chat-privacy-chip"
                title="Privacy mode — only routing to providers that don't train on your data"
              >
                🛡 Privacy
              </span>
            ) : null}
            {activeProjectName ? (
              <span
                className="chat-privacy-chip"
                title="Active project — its instructions lead each new chat. Click × to leave."
              >
                📁 {activeProjectName}
                <button
                  type="button"
                  aria-label="Leave project"
                  onClick={() => {
                    setActiveProjectId(null);
                    setActiveProjectName(null);
                  }}
                  style={{ marginLeft: 6, background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0 }}
                >
                  ×
                </button>
              </span>
            ) : null}
            <button
              type="button"
              className={`chat-tool-toggle${incognito ? " active" : ""}`}
              onClick={() => newChat(!incognito)}
              title={
                incognito
                  ? "Leave incognito (start a normal chat)"
                  : "Start an incognito chat — nothing saved, non-training providers only"
              }
            >
              🕶 Incognito
            </button>
            {messages.length > 0 ? (
              <button
                type="button"
                className="chat-tool-toggle"
                onClick={exportThread}
                title="Export this chat as Markdown"
                style={{ marginLeft: "auto" }}
              >
                <Icon name="copy" size={13} />
                Export
              </button>
            ) : null}
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
          {imageUnsupported && (
            <div className="chat-attachments" style={{ alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "#f59e0b" }}>
                Images aren&apos;t supported yet — attach text files (txt, md, code,
                json…).
              </span>
              <button
                type="button"
                className="chat-attachment-remove"
                onClick={() => setImageUnsupported(false)}
                aria-label="Dismiss"
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          )}
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
                  <Tooltip content={`Remove ${att.name}`}>
                    <button
                      type="button"
                      className="chat-attachment-remove"
                      onClick={() =>
                        setAttachments((prev) => prev.filter((a) => a.id !== att.id))
                      }
                      aria-label={`Remove ${att.name}`}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
          )}
          <div className="chat-composer-row">
            <input
              type="file"
              ref={fileInputRef}
              accept=".txt,.md,.ts,.js,.tsx,.jsx,.py,.json,.sh,.yaml,.toml,.rs,.go,.css"
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
            <Tooltip content="Attach a text file (images not supported yet)">
              <button
                type="button"
                className="chat-attach"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach a text file"
              >
                <Icon name="paperclip" size={15} />
              </button>
            </Tooltip>
            {loading ? (
              <Tooltip content="Stop generating (Esc)">
                <button
                  type="button"
                  className="chat-send chat-stop"
                  onClick={stop}
                  aria-label="Stop generating"
                >
                  <Icon name="stop" size={14} />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content="Send message (Enter)">
                <button
                  type="button"
                  className="chat-send"
                  disabled={!input.trim()}
                  onClick={() => void send()}
                  aria-label="Send message"
                >
                  <Icon name="send" size={15} />
                </button>
              </Tooltip>
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
