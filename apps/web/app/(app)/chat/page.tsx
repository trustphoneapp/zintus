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
  type UiImageMeta,
} from "@/lib/app-store";
import {
  streamChat,
  sanitizeSendHistory,
  UnsupportedCapabilityError,
  type ChatMessage,
} from "@/lib/chat-client";
import { processImage, MediaError } from "@zintus/media";
import type { ContentBlock, ImageContentBlock } from "@zintus/types";
import {
  BUILTIN_TOOL_DEFINITIONS,
  BUILTIN_WEB_TOOLS,
  executeWebToolCall,
} from "@/lib/web-tools";
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
  // Collapsed secondary-controls popover ("⚙ More") and the New-chat affordance
  // menu (which owns the incognito option). Both close on outside click.
  const [moreOpen, setMoreOpen] = useState(false);
  const [newChatMenuOpen, setNewChatMenuOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const newChatRef = useRef<HTMLDivElement>(null);
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

  // Tools toggle (persisted): when on, the built-in browser-safe tools
  // (calculator, current_datetime, random_number) are offered to the model and
  // executed locally in a bounded loop. Requires a tool-capable provider.
  const [toolsEnabled, setToolsEnabled] = useState(() => {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("zintus:tools") === "true";
    }
    return false;
  });

  // Structured-output (JSON) toggle (persisted): when on, the turn requests
  // response_format json_object. The gateway resolves the best level the chosen
  // provider can serve, or returns an honest 422 when it can't. Parity w/ desktop.
  const [jsonEnabled, setJsonEnabled] = useState(() => {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("zintus:json") === "true";
    }
    return false;
  });
  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("zintus:json", String(jsonEnabled));
    }
  }, [jsonEnabled]);

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

  // Dismiss the More / New-chat popovers on an outside click (mirrors ProviderPicker).
  useEffect(() => {
    if (!moreOpen && !newChatMenuOpen) return;
    function onClick(event: MouseEvent) {
      const target = event.target as Node;
      if (moreRef.current && !moreRef.current.contains(target)) {
        setMoreOpen(false);
      }
      if (newChatRef.current && !newChatRef.current.contains(target)) {
        setNewChatMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [moreOpen, newChatMenuOpen]);

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

      // The tools turn runs STATELESS (no threadId) so the bounded execution loop
      // is deterministic: `send` passes the full conversation as `sendMessages`
      // when tools are on. A normal turn keeps the threadId-compiled context.
      const useThread = !toolsEnabled;
      const convo: ChatMessage[] = [...sendMessages];
      let currentAssistantId = assistantId;
      const MAX_TOOL_ROUNDS = 5;

      // Catalog "Use this model": route to the exact chosen model, but ONLY when it
      // belongs to the currently-selected provider (avoid a stale model after the
      // user switches providers in the composer).
      let catalogModel: string | undefined;
      try {
        const raw =
          typeof localStorage !== "undefined"
            ? localStorage.getItem("zintus:selected-model")
            : null;
        if (raw) {
          const sel = JSON.parse(raw) as { id?: string; provider?: string };
          if (sel.id && sel.provider && sel.provider === selectedProvider) {
            catalogModel = sel.id;
          }
        }
      } catch {
        // ignore malformed storage
      }

      try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
          let streamedText = "";
          const result = await streamChat({
            messages: convo,
            providerId: selectedProvider ?? undefined,
            model: catalogModel,
            mode: settings.contextMode,
            threadId: useThread ? threadId : undefined,
            // Read fresh: the LocalKeyManager may have just populated the vault and
            // re-invoked send() before this component re-rendered with new keys.
            apiKeys: useProviderStatusStore.getState().keys,
            // Incognito prefers non-training providers regardless of the saved pref.
            settings: incognito
              ? { ...settings, blockTrainingProviders: true }
              : settings,
            webSearch: webSearchEnabled,
            temperature: activePreset?.temperature,
            tools: toolsEnabled ? BUILTIN_TOOL_DEFINITIONS : undefined,
            responseFormat: jsonEnabled ? { type: "json_object" } : undefined,
            signal: controller.signal,
            onChunk: (text) => {
              streamedText = text;
              updateMessage(currentAssistantId, text);
            },
          });

          setActiveProvider(result.providerId);
          if (useThread) setThreadId(result.threadId);
          patchMessage(currentAssistantId, {
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
          if (hadImages && round === 0) {
            setNotice({
              tone: "ok",
              text: `Image analyzed by ${result.meta?.provider ?? result.providerId}`,
            });
          }
          if (result.source === "gateway") {
            await loadLastTrace();
          }

          const calls = result.toolCalls ?? [];
          if (calls.length === 0) break;

          // Render the tool calls on the current assistant bubble.
          patchMessage(currentAssistantId, {
            toolCalls: calls.map((c) => ({
              id: c.id,
              name: c.name,
              arguments: c.arguments,
            })),
          });

          if (round === MAX_TOOL_ROUNDS) {
            pushTerminalLine({
              text: `⚠ tool loop stopped after ${MAX_TOOL_ROUNDS} rounds`,
              tone: "warning",
            });
            if (!streamedText.trim()) {
              updateMessage(
                currentAssistantId,
                `_Stopped after ${MAX_TOOL_ROUNDS} tool rounds._`,
              );
            }
            break;
          }

          // Execute each call locally (built-in, browser-safe tools) and feed the
          // results back on the next request as tool_result blocks.
          const results = calls.map((c) =>
            executeWebToolCall({ id: c.id, name: c.name, arguments: c.arguments }),
          );
          for (const c of calls) {
            const r = results.find((x) => x.toolCallId === c.id);
            pushTerminalLine({
              text: `🔧 ${c.name}(${JSON.stringify(c.arguments)}) → ${r?.isError ? "error" : (r?.content ?? "")}`,
              tone: r?.isError ? "warning" : "muted",
            });
          }

          convo.push({
            role: "assistant",
            content: [
              ...(streamedText.trim()
                ? [{ type: "text" as const, text: streamedText }]
                : []),
              ...calls,
            ],
          });
          convo.push({
            role: "user",
            content: results.map((r) => ({
              type: "tool_result" as const,
              toolCallId: r.toolCallId,
              content: r.content,
              isError: r.isError,
            })),
          });

          // A fresh assistant bubble for the next round's answer.
          const next = createAssistantPlaceholder();
          appendMessage(next);
          currentAssistantId = next.id;
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
            "Try a different provider:",
            ...error.suggestions.map((s) => `- **${s.provider}** — ${s.reason}`),
          ];
          updateMessage(currentAssistantId, lines.join("\n"));
          pushTerminalLine({ text: `✗ ${error.message}`, tone: "warning" });
          return;
        }
        const message =
          error instanceof Error ? error.message : "Request failed";
        updateMessage(currentAssistantId, `Error: ${message}`);
        pushTerminalLine({ text: `✗ ${message}`, tone: "warning" });
      } finally {
        setLoading(false);
      }
    },
    [
      appendMessage,
      loadLastTrace,
      patchMessage,
      pushTerminalLine,
      selectedProvider,
      setActiveProvider,
      setThreadId,
      settings,
      threadId,
      toolsEnabled,
      jsonEnabled,
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

    // Sanitize the store-derived history before sending: the tools loop can
    // leave empty-content assistant bubbles and adjacent same-role turns that a
    // strict role-alternation provider (Gemini) would reject. Subsumes the old
    // `&& content` intent. The trailing user turn is preserved.
    const history: ChatMessage[] = sanitizeSendHistory([
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: "user", content: userMessageContent },
    ]);

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
        previewUrl: a.previewUrl,
      }));
    appendMessage(createUserMessage(userText, sentImageMeta));
    const assistant = createAssistantPlaceholder();
    appendMessage(assistant);
    setInput("");
    // Transfer the attachments' preview object URLs to the sent bubbles (don't
    // revoke them) so the thumbnails render; they're freed on page unload.
    // Explicit removal (removeAttachment) still revokes.
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
      // A tools turn runs stateless, so it needs the FULL conversation here (the
      // loop in streamAssistant drops threadId). A normal continued turn sends
      // just the new user message and relies on threadId-compiled context.
      threadId == null || toolsEnabled
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
    incognito,
    input,
    loading,
    messages,
    selectedProvider,
    settings,
    streamAssistant,
    threadId,
    toolsEnabled,
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
    // Sanitize the rebuilt history: drop the empty placeholder + any dangling
    // empty tool-round assistant bubbles, and merge adjacent same-role turns so
    // Regenerate never replays a malformed conversation.
    const priorMessages = sanitizeSendHistory(
      (s.threads.find((t) => t.id === s.activeThreadId)?.messages ?? [])
        .filter((message) => message.id !== assistant.id && message.content)
        .map((message) => ({ role: message.role, content: message.content })),
    );

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

  // The provider the next send will (likely) hit — used to surface an honest,
  // non-interactive "Vision" capability chip next to the attach control so it's
  // clear up front whether the selected route can actually read an image.
  const effectiveComposerProvider =
    selectedProvider ?? settings.defaultProvider ?? null;
  const visionReady = effectiveComposerProvider
    ? providerCanSeeImages(effectiveComposerProvider)
    : false;

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
      {/* Thread header: title + context chips on the left; New-chat affordance
          (owns incognito) and Export pinned right. Export moved OUT of the
          composer per the chat-hierarchy cleanup. */}
      <div
        className="chat-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "10px 28px",
          borderBottom: "0.5px solid var(--c-border)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            fontSize: 13,
            fontWeight: 600,
            color: "var(--color-text)",
          }}
        >
          <span>{incognito ? "Incognito chat" : "Chat"}</span>
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
                style={{
                  marginLeft: 6,
                  background: "none",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                ×
              </button>
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* New-chat affordance with an incognito option in its menu. */}
          <div className="composer-picker" ref={newChatRef}>
            <button
              type="button"
              className="chat-tool-toggle"
              aria-haspopup="menu"
              aria-expanded={newChatMenuOpen}
              onClick={() => setNewChatMenuOpen((v) => !v)}
              title="Start a new chat"
            >
              <Icon name="plus" size={13} />
              New chat
              <Icon name="chevron-down" size={11} />
            </button>
            {newChatMenuOpen ? (
              <div
                className="composer-picker-menu"
                role="menu"
                style={{ bottom: "auto", top: "calc(100% + 6px)", left: "auto", right: 0 }}
              >
                <button
                  type="button"
                  className="composer-picker-option"
                  onClick={() => {
                    newChat(false);
                    setNewChatMenuOpen(false);
                  }}
                >
                  <Icon name="plus" size={13} />
                  <span>New chat</span>
                </button>
                <button
                  type="button"
                  className={`composer-picker-option${incognito ? " active" : ""}`}
                  onClick={() => {
                    newChat(true);
                    setNewChatMenuOpen(false);
                  }}
                  title="Nothing saved, non-training providers only"
                >
                  <span aria-hidden>🕶</span>
                  <span>New incognito chat</span>
                </button>
              </div>
            ) : null}
          </div>
          {messages.length > 0 ? (
            <button
              type="button"
              className="chat-tool-toggle"
              onClick={exportThread}
              aria-label="Export this chat as Markdown"
              title="Export this chat as Markdown"
            >
              <Icon name="copy" size={13} />
              Export
            </button>
          ) : null}
        </div>
      </div>

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
              toolCalls={message.toolCalls}
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
          {/* Composer toolbar (calm): the model/route picker stays accessible;
              every other secondary control collapses into a single "⚙ More"
              popover. Incognito moved to the header New-chat menu; Export to the
              header. */}
          <div
            className="chat-composer-top"
            style={{ gap: 8 }}
          >
            <ProviderPicker />

            <div className="composer-picker" ref={moreRef}>
              <button
                type="button"
                className={`chat-tool-toggle${
                  webSearchEnabled ||
                  toolsEnabled ||
                  activePreset ||
                  activeProjectName ||
                  settings.blockTrainingProviders
                    ? " active"
                    : ""
                }`}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                aria-label="More chat options"
                onClick={() => setMoreOpen((v) => !v)}
                title="Search, tools, presets, project"
              >
                <Icon name="settings" size={13} />
                More
              </button>

              {moreOpen ? (
                <div
                  className="composer-picker-menu"
                  role="menu"
                  style={{ minWidth: 252, padding: 8 }}
                >
                  <div className="composer-picker-section">Tools</div>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      padding: "0 4px 6px",
                    }}
                  >
                    <button
                      type="button"
                      className={`chat-tool-toggle${webSearchEnabled ? " active" : ""}`}
                      aria-pressed={webSearchEnabled}
                      aria-label="Toggle web search"
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
                    <button
                      type="button"
                      className={`chat-tool-toggle${toolsEnabled ? " active" : ""}`}
                      aria-pressed={toolsEnabled}
                      aria-label="Toggle tools"
                      onClick={() => {
                        setToolsEnabled((v) => {
                          const next = !v;
                          if (typeof localStorage !== "undefined") {
                            localStorage.setItem("zintus:tools", String(next));
                          }
                          return next;
                        });
                      }}
                      title={`Let the model call built-in tools (${BUILTIN_WEB_TOOLS.map((t) => t.definition.name).join(", ")}). Runs locally in your browser; needs a tool-capable provider.`}
                    >
                      🔧 Tools
                    </button>
                    <button
                      type="button"
                      className={`chat-tool-toggle${jsonEnabled ? " active" : ""}`}
                      aria-pressed={jsonEnabled}
                      aria-label="Toggle JSON output"
                      onClick={() => setJsonEnabled((v) => !v)}
                      title="Request structured JSON output. The gateway resolves the best level the chosen provider can serve, or returns an honest error when it can't."
                    >
                      {"{}"} JSON
                    </button>
                  </div>

                  {presets.length > 0 ? (
                    <>
                      <div className="composer-picker-section">Preset</div>
                      <div style={{ padding: "0 4px 6px" }}>
                        <select
                          className="chat-preset-select"
                          style={{ width: "100%" }}
                          value={activePreset?.id ?? ""}
                          onChange={(event) =>
                            applyPreset(
                              presets.find((p) => p.id === event.target.value) ??
                                null,
                            )
                          }
                          aria-label="Apply a saved preset"
                          title="Apply a saved preset"
                        >
                          <option value="">No preset</option>
                          {presets.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  ) : null}

                  {activeProjectName ? (
                    <>
                      <div className="composer-picker-section">Project</div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "0 4px 6px",
                          fontSize: 12,
                          color: "var(--color-text-sub)",
                        }}
                      >
                        <span>📁 {activeProjectName}</span>
                        <button
                          type="button"
                          className="chat-tool-toggle"
                          style={{ marginLeft: "auto" }}
                          onClick={() => {
                            setActiveProjectId(null);
                            setActiveProjectName(null);
                          }}
                          title="Leave this project"
                        >
                          Leave
                        </button>
                      </div>
                    </>
                  ) : null}

                  {visionReady || settings.blockTrainingProviders ? (
                    <>
                      <div className="composer-picker-section">This route</div>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 6,
                          padding: "0 4px 2px",
                        }}
                      >
                        {visionReady ? (
                          <span
                            className="chat-privacy-chip"
                            title={`${capitalize(effectiveComposerProvider ?? "")} can read attached images`}
                          >
                            <Icon name="image" size={12} /> Vision
                          </span>
                        ) : null}
                        {settings.blockTrainingProviders ? (
                          <span
                            className="chat-privacy-chip"
                            title="Privacy mode — only routing to providers that don't train on your data"
                          >
                            🛡 Privacy
                          </span>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
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
            {/* Icons left: attach sits at the leading edge of the input row. */}
            <Tooltip content="Attach an image (PNG/JPEG/WebP) or a text file">
              <button
                type="button"
                className="chat-attach"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach an image or text file"
              >
                <Icon name="image" size={16} />
              </button>
            </Tooltip>
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
            {/* Send / stop pinned to the trailing (right) edge. */}
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
