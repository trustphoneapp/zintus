"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { MessageBubble } from "@/app/_components/MessageBubble";
import { ProviderPicker } from "@/app/_components/ProviderPicker";
import { LocalKeyManager } from "@/app/_components/LocalKeyManager";
import { Icon } from "@/app/_components/Icons";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  createAssistantPlaceholder,
  createUserMessage,
  useAppStore,
  type UiImageMeta,
} from "@/lib/app-store";
import {
  streamChat,
  UnsupportedCapabilityError,
  type ChatMessage,
} from "@/lib/chat-client";
import { processImage, MediaError } from "@zintus/media";
import type { ContentBlock, ImageContentBlock } from "@zintus/types";
import {
  acceptImageFile,
  buildImageMessageContent,
  formatImageBytes,
  imageSlotsRemaining,
  isImageMime,
  providerCanSeeImages,
} from "@/lib/image-attachments";
import { memorySystemMessage } from "@/lib/memory";
import { downloadFile } from "@/lib/download";
import {
  DATA_FLOW,
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

/** A text file is extracted to a string and folded into the prompt. */
interface TextAttachment {
  id: string;
  kind: "text";
  name: string;
  content: string;
  mimeType: string;
}

/** An image is processed by @zintus/media into an `ImageContentBlock` that we
 *  SEND; `previewUrl` is a local object URL of the ORIGINAL file, for the
 *  thumbnail only (never sent). */
interface ImageAttachment {
  id: string;
  kind: "image";
  name: string;
  previewUrl: string;
  block: ImageContentBlock;
}

type Attachment = TextAttachment | ImageAttachment;

/** Inline composer notice (rejections, vision warnings, success). */
interface ComposerNotice {
  tone: "error" | "warn" | "ok";
  text: string;
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
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
  const [notice, setNotice] = useState<ComposerNotice | null>(null);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  // Local mode = no cloud session cookie. Set after mount to avoid an SSR/CSR
  // hydration mismatch (document.cookie is client-only).
  const [localMode, setLocalMode] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Image blocks of the most recent user turn — kept in memory (NOT persisted to
  // thread history, where only text + metadata live) so Regenerate can re-send
  // the same image instead of silently dropping it.
  const lastSentImagesRef = useRef<ImageContentBlock[]>([]);

  // File attachments
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Mirror of `attachments` for synchronous reads (the async file handler needs
  // the live image count; closing over state would be stale) and unmount cleanup.
  const attachmentsRef = useRef<Attachment[]>([]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

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

  // Revoke any outstanding image preview object URLs when the page unmounts.
  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) {
        if (a.kind === "image") URL.revokeObjectURL(a.previewUrl);
      }
    },
    [],
  );

  // A fresh/empty thread has no image context — drop any lingering composer
  // notice (e.g. the "Image analyzed by …" confirmation carried over from a
  // previous conversation after "New chat").
  useEffect(() => {
    if (messages.length === 0) setNotice(null);
  }, [messages.length]);

  /** Remove one attachment, revoking its preview URL when it's an image. */
  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.kind === "image") URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  /** Drop all attachments, revoking every image preview URL. */
  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      for (const a of prev) {
        if (a.kind === "image") URL.revokeObjectURL(a.previewUrl);
      }
      return [];
    });
  }, []);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    // Live image count from the ref so multi-file drops respect the max-4 cap.
    let imageCount = attachmentsRef.current.filter(
      (a) => a.kind === "image",
    ).length;

    for (const file of fileArray) {
      // ── Image branch — process HONESTLY via @zintus/media ──────────────────
      if (isImageMime(file.type)) {
        if (!acceptImageFile(file.type)) {
          setNotice({
            tone: "error",
            text: `${file.type || "That image type"} isn't supported — use PNG, JPEG, or WebP.`,
          });
          continue;
        }
        if (imageSlotsRemaining(imageCount) === 0) {
          setNotice({
            tone: "warn",
            text: "You can attach up to 4 images per message.",
          });
          continue;
        }
        try {
          // Real processing: canvas decode/resize/re-encode + EXIF strip in the
          // browser. The returned block is what we SEND; the preview uses the
          // original file. Image bytes are NEVER logged.
          const block = await processImage(file, { name: file.name });
          const id = crypto.randomUUID();
          const previewUrl = URL.createObjectURL(file);
          imageCount += 1;
          setAttachments((prev) => [
            ...prev,
            { id, kind: "image", name: file.name, previewUrl, block },
          ]);
          setNotice(null);
        } catch (error) {
          // MediaError messages are safe (sizes/dimensions/mime only — no bytes).
          const reason =
            error instanceof MediaError
              ? error.message
              : "couldn't be processed";
          setNotice({
            tone: "error",
            text: `Couldn't attach ${file.name}: ${reason}`,
          });
        }
        continue;
      }

      // ── Text branch — extracted + sent inline (unchanged) ──────────────────
      const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");
      if (!TEXT_EXTENSIONS.has(ext)) {
        setNotice({
          tone: "error",
          text: `${file.name} isn't a supported file — attach an image (PNG/JPEG/WebP) or a text file.`,
        });
        continue;
      }

      const id = crypto.randomUUID();
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setAttachments((prev) => [
          ...prev,
          {
            id,
            kind: "text",
            name: file.name,
            content,
            mimeType: file.type || "text/plain",
          },
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
      hadImages: boolean,
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
        // Multimodal: confirm which provider actually read the image(s).
        if (hadImages) {
          setNotice({
            tone: "ok",
            text: `Image analyzed by ${result.meta?.provider ?? result.providerId}`,
          });
        }
        if (result.source === "gateway") {
          await loadLastTrace();
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        // The gateway refused the image route (no vision-capable provider on
        // auto): render its honest message + suggestions instead of crashing.
        if (error instanceof UnsupportedCapabilityError) {
          const lines = [
            error.message,
            "",
            "Try a vision-capable provider:",
            ...error.suggestions.map((s) => `- **${s.provider}** — ${s.reason}`),
          ];
          updateMessage(assistantId, lines.join("\n"));
          pushTerminalLine({ text: `✗ ${error.message}`, tone: "warning" });
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
    // Allow a send when there's text OR at least one attachment (an image with
    // an empty prompt is valid — the image is the request).
    if ((!input.trim() && attachments.length === 0) || loading) {
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

    // Text-file attachments fold into the prompt (extracted text). Images do NOT
    // — they ride as real content blocks below; no fake "[Image: …]" note.
    let textPrefix = "";
    for (const att of attachments) {
      if (att.kind !== "text") continue;
      const ext = att.name.split(".").pop() ?? "txt";
      textPrefix += `[File: ${att.name}]\n\`\`\`${ext}\n${att.content}\n\`\`\`\n\n`;
    }
    const userText = (textPrefix + prompt).trim();

    const imageBlocks = attachments
      .filter((a): a is ImageAttachment => a.kind === "image")
      .map((a) => a.block);
    // Remember this turn's images so Regenerate can re-send them (see regenerate()).
    lastSentImagesRef.current = imageBlocks;

    // Vision guard: a concrete non-vision provider can't read images — warn and
    // hold the message (don't waste a request, don't drop the image). Auto
    // routing (no explicit provider) is allowed; the router/gateway decides.
    const effectiveProvider =
      selectedProvider ?? settings.defaultProvider ?? null;
    if (
      imageBlocks.length > 0 &&
      effectiveProvider &&
      !providerCanSeeImages(effectiveProvider)
    ) {
      setNotice({
        tone: "warn",
        text: `${capitalize(effectiveProvider)} can't read images — switch to a vision provider (e.g. Gemini) or remove the image.`,
      });
      return;
    }
    setNotice(null);

    // The SENT user content: a block array (text first, then images) when images
    // are attached, else plain text. The gateway reads images from these blocks.
    const userMessageContent: string | ContentBlock[] =
      imageBlocks.length > 0
        ? buildImageMessageContent(userText, imageBlocks)
        : userText;

    const history: ChatMessage[] = [
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: "user", content: userMessageContent },
    ];

    // The stored user bubble carries image METADATA (never base64) so it honestly
    // shows which image(s) this turn included (the composer thumbnails clear on
    // send). See UiMessage.images.
    const sentImageMeta: UiImageMeta[] = attachments
      .filter((a): a is ImageAttachment => a.kind === "image")
      .map((a) => ({
        name: a.block.name ?? a.name,
        mimeType: a.block.mimeType,
        bytes: a.block.bytes,
        width: a.block.width,
        height: a.block.height,
        exifStripped: a.block.exifStripped,
      }));
    appendMessage(createUserMessage(userText, sentImageMeta));
    const assistant = createAssistantPlaceholder();
    appendMessage(assistant);
    setInput("");
    clearAttachments();

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
        : [{ role: "user", content: userMessageContent }];
    await streamAssistant(
      assistant.id,
      sendMessages,
      prompt || "image attached",
      imageBlocks.length > 0,
    );
  }, [
    activePreset,
    appendMessage,
    attachments,
    clearAttachments,
    incognito,
    input,
    loading,
    messages,
    selectedProvider,
    settings,
    streamAssistant,
    threadId,
  ]);

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

    // Regenerate must re-send the same image. The bytes aren't in history; they
    // live in lastSentImagesRef. If they're gone (e.g. after a reload), say so
    // rather than silently regenerating text-only.
    const reuseImages =
      lastUser.images && lastUser.images.length > 0
        ? lastSentImagesRef.current
        : [];
    if (
      lastUser.images &&
      lastUser.images.length > 0 &&
      reuseImages.length === 0
    ) {
      setNotice({
        tone: "warn",
        text: "Re-attach the image to regenerate this turn — images aren't kept after a reload.",
      });
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

    const lastUserContent: string | ContentBlock[] =
      reuseImages.length > 0
        ? buildImageMessageContent(lastUser.content, reuseImages)
        : lastUser.content;
    const sendMessages: ChatMessage[] =
      threadId == null
        ? priorMessages.map((m, i) =>
            i === priorMessages.length - 1 && m.role === "user"
              ? { ...m, content: lastUserContent }
              : m,
          )
        : [{ role: "user", content: lastUserContent }];
    await streamAssistant(
      assistant.id,
      sendMessages,
      lastUser.content,
      reuseImages.length > 0,
    );
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
      {consentOpen ? (
        <div
          className="consent-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setConsentOpen(false)}
        >
          <div className="consent-card" onClick={(e) => e.stopPropagation()}>
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
              <button
                type="button"
                className="chat-tool-toggle"
                onClick={() => setConsentOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="chat-tool-toggle"
                onClick={() => {
                  grantProviderSendConsent();
                  setConsentOpen(false);
                  void send();
                }}
              >
                Got it — send
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
            void handleFiles(e.dataTransfer.files);
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
          {notice && (
            <div className={`chat-composer-notice is-${notice.tone}`} role="status">
              <span>{notice.text}</span>
              <button
                type="button"
                className="chat-attachment-remove"
                onClick={() => setNotice(null)}
                aria-label="Dismiss"
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="chat-attachments">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className={`chat-attachment-chip${att.kind === "image" ? " is-image" : ""}`}
                >
                  {att.kind === "image" ? (
                    <>
                      {/* Preview = original file (object URL). We SEND att.block. */}
                      <img
                        src={att.previewUrl}
                        alt={att.name}
                        className="chat-attachment-thumb"
                      />
                      <span className="chat-attachment-name">{att.name}</span>
                      <span className="chat-attachment-meta">
                        {formatImageBytes(att.block.bytes)}
                      </span>
                      <span
                        className="chat-attachment-badge"
                        title="EXIF/GPS metadata was removed before this image is sent"
                      >
                        <Icon name="check" size={10} /> EXIF stripped
                      </span>
                    </>
                  ) : (
                    <>
                      <Icon name="paperclip" size={12} />
                      <span className="chat-attachment-name">{att.name}</span>
                    </>
                  )}
                  <Tooltip content={`Remove ${att.name}`}>
                    <button
                      type="button"
                      className="chat-attachment-remove"
                      onClick={() => removeAttachment(att.id)}
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
              accept="image/jpeg,image/png,image/webp,.txt,.md,.ts,.js,.tsx,.jsx,.py,.json,.sh,.yaml,.toml,.rs,.go,.css"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) void handleFiles(e.target.files);
                // Reset so picking the same file again re-triggers onChange.
                e.target.value = "";
              }}
            />
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                // Drop the lingering post-send "Image analyzed by …" confirmation
                // once the user starts a new message, so it never implies an image
                // is still attached (it isn't — images clear on send; re-attach for
                // a new one).
                setNotice((n) => (n?.tone === "ok" ? null : n));
              }}
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
                  void handleFiles(e.clipboardData.files);
                }
              }}
              placeholder="Ask anything — routed automatically across your free providers"
            />
            <Tooltip content="Attach an image (PNG/JPEG/WebP) or a text file">
              <button
                type="button"
                className="chat-attach"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach an image or text file"
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
                  disabled={!input.trim() && attachments.length === 0}
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
