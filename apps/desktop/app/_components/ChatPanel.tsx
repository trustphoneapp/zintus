"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUp, ImagePlus, Layers, MessageSquarePlus, Paperclip, Plus, Square, Wrench } from "lucide-react";
import type {
  ContentBlock,
  ImageContentBlock,
  ProviderId,
  ResponseFormat,
  RoutingStrategy,
} from "@zintus/types";
import { PROVIDER_IDS } from "@zintus/types";
import { processImage, MediaError } from "@zintus/media";
import {
  streamChat,
  sanitizeSendHistory,
  UnsupportedCapabilityError,
  type ChatMcpConfig,
  type ChatMessage,
  type McpToolEvent,
} from "@/lib/chat-client";
import { activeMcpServersForChat, loadMcpServers } from "@/lib/mcp-config";
import { saveTextFile } from "@/lib/download";
import {
  acceptImageFile,
  buildImageMessageContent,
  formatImageBytes,
  imageSlotsRemaining,
  isImageMime,
  providerCanSeeImages,
} from "@/lib/image-attachments";
import {
  createChatMessage,
  useChatStore,
  useProviderStatusStore,
  useSettingsStore,
  type UiImageMeta,
} from "@/lib/store";
import {
  BUILTIN_TOOL_DEFINITIONS,
  BUILTIN_WEB_TOOLS,
  executeWebToolCall,
} from "@/lib/web-tools";
import {
  DATA_FLOW,
  grantProviderSendConsent,
  hasProviderSendConsent,
} from "@/lib/consent";
import { getActiveProject, setActiveProjectId } from "@/lib/projects";
import {
  extractArtifacts,
  foldArtifactVersions,
  type Artifact,
} from "@/lib/artifacts";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { MessageBubble } from "./MessageBubble";
import { ArtifactPanel } from "./ArtifactPanel";

// Text-like files we extract on-device (parity with web/mobile). Images now ride
// as real ImageContentBlocks via @zintus/media (see ImageAttachment below).
const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|env|tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|scala|sh|bash|zsh|sql|html?|xml|css|scss|less|log|conf)$/i;

interface TextAttachment {
  id: string;
  name: string;
  content: string;
}

/** An attached image is processed by @zintus/media into the `block` we SEND;
 *  `previewUrl` is a local object URL of the ORIGINAL file (thumbnail only — never
 *  sent, never logged). Mirrors web's ImageAttachment. */
interface ImageAttachment {
  id: string;
  name: string;
  previewUrl: string;
  block: ImageContentBlock;
}

function attachmentBlocks(atts: TextAttachment[]): string {
  return atts
    .map((a) => `[File: ${a.name}]\n\`\`\`\n${a.content}\n\`\`\``)
    .join("\n\n");
}

/**
 * Build the chat body's `mcp` block from the user's enabled MCP servers
 * (mcp-config's `loadMcpServers` → `activeMcpServersForChat`), plus the active
 * tool count for the header indicator. The gateway runs these tools SERVER-SIDE;
 * the desktop only displays the resulting activity. Returns `undefined` when
 * nothing is enabled. Mirrors web's `activeMcpForChat`.
 */
function activeMcpForChat(): { mcp: ChatMcpConfig | undefined; toolCount: number } {
  const { servers } = activeMcpServersForChat(loadMcpServers());
  if (servers.length === 0) {
    return { mcp: undefined, toolCount: 0 };
  }
  const enabledTools = servers.flatMap((s) => s.enabledTools);
  return {
    mcp: {
      servers: servers.map((s) => s.config),
      // Omit when no concrete tool names are known yet (server enabled but not
      // tested) so the gateway offers every tool it discovers rather than
      // suppressing them all with an empty allow-list.
      ...(enabledTools.length > 0 ? { enabledTools } : {}),
    },
    toolCount: enabledTools.length,
  };
}

export function ChatPanel() {
  const { settings, hydrate, update } = useSettingsStore();
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
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<TextAttachment[]>([]);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  // Inline composer notice (image rejections, vision warnings). tone styles it.
  const [notice, setNotice] = useState<{ tone: "error" | "warn"; text: string } | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  // "+" attach menu (web-composer parity) — closes on outside click / Escape.
  const [plusOpen, setPlusOpen] = useState(false);
  const plusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!plusOpen) return;
    function onDown(e: MouseEvent) {
      if (plusRef.current && !plusRef.current.contains(e.target as Node)) {
        setPlusOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPlusOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [plusOpen]);
  // Synchronous mirror of the image count so a multi-file pick honors the max-4 cap
  // (state is async; closing over it would read a stale count).
  const imageCountRef = useRef(0);
  // Live mirror of attachments for the unmount cleanup (revoke object URLs that
  // were never transferred to a sent bubble).
  const imageAttachmentsRef = useRef<ImageAttachment[]>([]);
  useEffect(() => {
    imageCountRef.current = imageAttachments.length;
    imageAttachmentsRef.current = imageAttachments;
  }, [imageAttachments]);
  useEffect(
    () => () => {
      for (const a of imageAttachmentsRef.current) URL.revokeObjectURL(a.previewUrl);
    },
    [],
  );
  // Image blocks of the most recent user turn — kept in memory (NOT persisted to
  // thread history, where only text + metadata live) so Regenerate can re-send the
  // same image instead of silently dropping it. Mirrors web's lastSentImagesRef.
  const lastSentImagesRef = useRef<ImageContentBlock[]>([]);

  // Structured-output (JSON) toggle (persisted): when on, the turn asks the
  // gateway for `response_format: { type: "json_object" }`. The gateway resolves
  // the best level the routed provider can serve; the bubble renders whatever JSON
  // actually comes back (no fake structure claimed).
  const [jsonMode, setJsonMode] = useState(() => {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("zintus:desktop-json") === "true";
    }
    return false;
  });

  // Tools toggle (persisted): when on, the built-in browser-safe tools
  // (calculator, current_datetime, random_number) are offered to the model and
  // executed locally in a bounded loop. Requires a tool-capable provider.
  const [toolsEnabled, setToolsEnabled] = useState(() => {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("zintus:desktop-tools") === "true";
    }
    return false;
  });

  // Count of MCP tools active this chat (header indicator). Recomputed on mount
  // and whenever the window regains focus (the user may have just edited servers
  // in the MCP settings screen).
  const [mcpToolCount, setMcpToolCount] = useState(0);

  useEffect(() => {
    setActiveProjectName(getActiveProject()?.name ?? null);
  }, []);

  useEffect(() => {
    const refresh = () => setMcpToolCount(activeMcpForChat().toolCount);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      // ── Image branch — process HONESTLY via @zintus/media (canvas decode/
      //    resize/re-encode + EXIF strip). Bytes are NEVER logged. ──────────────
      if (isImageMime(file.type)) {
        if (!acceptImageFile(file.type)) {
          setNotice({
            tone: "error",
            text: `${file.type || "That image type"} isn't supported — use PNG, JPEG, or WebP.`,
          });
          continue;
        }
        if (imageSlotsRemaining(imageCountRef.current) === 0) {
          setNotice({ tone: "warn", text: "You can attach up to 4 images per message." });
          continue;
        }
        try {
          const block = await processImage(file, { name: file.name });
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const previewUrl = URL.createObjectURL(file);
          imageCountRef.current += 1;
          setImageAttachments((prev) => [...prev, { id, name: file.name, previewUrl, block }]);
          setNotice(null);
        } catch (error) {
          // MediaError messages are safe (sizes/dimensions/mime only — no bytes).
          const reason =
            error instanceof MediaError ? error.message : "couldn't be processed";
          setNotice({ tone: "error", text: `Couldn't attach ${file.name}: ${reason}` });
        }
        continue;
      }

      // ── Text branch — extracted + folded into the prompt (unchanged) ─────────
      if (!TEXT_EXT.test(file.name)) continue;
      const reader = new FileReader();
      reader.onload = (e) => {
        setAttachments((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            content: String(e.target?.result ?? ""),
          },
        ]);
      };
      reader.readAsText(file);
    }
  }, []);

  const removeImage = useCallback((id: string) => {
    setImageAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
  }, [messages]);

  // Shared streaming path used by both send and regenerate. When Tools is on, runs
  // a BOUNDED (max 5 rounds) STATELESS execute->feed-back loop: on returned
  // toolCalls we stamp them on the current bubble, run each tool locally, append
  // an assistant turn (text + tool_call blocks) and a user turn (tool_result
  // blocks) to a local conversation, spawn a fresh assistant bubble and re-stream
  // until the model stops calling tools. Desktop is gateway-only and already
  // stateless (the full history is sent every turn), so there is no threadId to
  // drop. Mirrors web's streamAssistant.
  const runTurn = useCallback(
    async (history: ChatMessage[], assistantId: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setActiveProvider(null);

      const convo: ChatMessage[] = [...history];
      let currentAssistantId = assistantId;
      const MAX_TOOL_ROUNDS = 5;
      // Minimal honest structured-output request: ask only for syntactically-valid
      // JSON (json_object). The gateway resolves the best level the routed provider
      // can serve and we render exactly what comes back.
      const responseFormat: ResponseFormat | undefined = jsonMode
        ? { type: "json_object" }
        : undefined;

      // The user's enabled MCP servers for this turn. The gateway runs the tool
      // loop SERVER-SIDE and streams call/result frames; we only display them.
      const { mcp } = activeMcpForChat();

      try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
          let streamedText = "";
          // Server-side MCP activity for THIS round's assistant bubble.
          const roundMcpEvents: McpToolEvent[] = [];
          const result = await streamChat({
            messages: convo,
            settings,
            providerId: selectedProvider ?? undefined,
            mode: settings.contextMode,
            tools: toolsEnabled ? BUILTIN_TOOL_DEFINITIONS : undefined,
            responseFormat,
            mcp,
            signal: controller.signal,
            onChunk: (text) => {
              if (!controller.signal.aborted) {
                streamedText = text;
                updateMessage(currentAssistantId, { content: text });
              }
            },
            onMcpToolEvent: (event) => {
              if (controller.signal.aborted) return;
              roundMcpEvents.push(event);
              updateMessage(currentAssistantId, {
                mcpToolEvents: [...roundMcpEvents],
              });
            },
          });
          updateMessage(currentAssistantId, {
            providerId: result.providerId,
            model: result.model,
            compression: result.compression,
            meta: result.meta,
          });
          setActiveProvider(result.providerId);
          void refresh();

          const calls = result.toolCalls ?? [];
          if (calls.length === 0) break;

          // Render the tool calls on the current assistant bubble.
          updateMessage(currentAssistantId, {
            toolCalls: calls.map((c) => ({
              id: c.id,
              name: c.name,
              arguments: c.arguments,
            })),
          });

          if (round === MAX_TOOL_ROUNDS) {
            if (!streamedText.trim()) {
              updateMessage(currentAssistantId, {
                content: `_Stopped after ${MAX_TOOL_ROUNDS} tool rounds._`,
              });
            }
            break;
          }

          // Execute each call locally (built-in, browser-safe tools) and feed the
          // results back on the next request as tool_result blocks.
          const results = calls.map((c) =>
            executeWebToolCall({
              id: c.id,
              name: c.name,
              arguments: c.arguments,
            }),
          );

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
          const next = createChatMessage("assistant", "");
          appendMessage(next);
          currentAssistantId = next.id;
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        // The gateway refused the route for a missing capability (e.g. vision):
        // render its honest message + suggestions instead of a bare error.
        if (error instanceof UnsupportedCapabilityError) {
          const lines = [
            error.message,
            ...(error.suggestions.length > 0
              ? [
                  "",
                  "Try a different provider:",
                  ...error.suggestions.map((s) => `- ${s.provider} — ${s.reason}`),
                ]
              : []),
          ];
          updateMessage(currentAssistantId, { content: lines.join("\n") });
          return;
        }
        updateMessage(currentAssistantId, {
          content: error instanceof Error ? error.message : "Request failed",
        });
      } finally {
        setLoading(false);
      }
    },
    [
      settings,
      selectedProvider,
      toolsEnabled,
      jsonMode,
      setActiveProvider,
      setLoading,
      updateMessage,
      refresh,
      appendMessage,
    ],
  );

  const doSend = useCallback(
    async (trimmed: string) => {
      // A project's instructions ride as a leading system message on a fresh
      // thread (the server owns context afterwards), mirroring web's presets.
      const project = getActiveProject();
      const leading: ChatMessage[] =
        messages.length === 0 && project?.instructions
          ? [{ role: "system" as const, content: project.instructions }]
          : [];
      const blocks = attachmentBlocks(attachments);
      const userText = blocks ? `${blocks}\n\n${trimmed}`.trim() : trimmed;
      const imageBlocks = imageAttachments.map((a) => a.block);
      // Remember this turn's images so Regenerate can re-send them (bytes aren't
      // kept in thread history).
      lastSentImagesRef.current = imageBlocks;

      // The SENT user content: a block array (text first, then images in order)
      // when images are attached, else plain text. The gateway reads images from
      // these blocks — NEVER an `[Image: name]` text note.
      const userContent: string | ContentBlock[] =
        imageBlocks.length > 0
          ? buildImageMessageContent(userText, imageBlocks)
          : userText;
      // Sanitize the store-derived history: the tools loop can leave empty
      // assistant bubbles and adjacent same-role turns. Desktop is stateless
      // (no threadId), so this store IS the history — replaying it raw would ship
      // a malformed conversation that a strict role-alternation provider rejects.
      const history: ChatMessage[] = [
        ...leading,
        ...sanitizeSendHistory([
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          { role: "user" as const, content: userContent },
        ]),
      ];
      // The stored user bubble carries image METADATA (never base64) so it honestly
      // shows which image(s) this turn included.
      const sentImageMeta: UiImageMeta[] = imageAttachments.map((a) => ({
        name: a.block.name ?? a.name,
        mimeType: a.block.mimeType,
        bytes: a.block.bytes,
        width: a.block.width,
        height: a.block.height,
        exifStripped: a.block.exifStripped,
        previewUrl: a.previewUrl,
      }));
      appendMessage(createChatMessage("user", userText, sentImageMeta));
      const assistant = createChatMessage("assistant", "");
      appendMessage(assistant);
      setPrompt("");
      setAttachments([]);
      // Don't revoke preview URLs here — they're transferred to the sent bubble's
      // thumbnail (freed on unmount / explicit remove).
      setImageAttachments([]);
      imageCountRef.current = 0;
      await runTurn(history, assistant.id);
    },
    [messages, attachments, imageAttachments, appendMessage, setPrompt, runTurn],
  );

  const send = useCallback(() => {
    const trimmed = prompt.trim();
    if ((!trimmed && attachments.length === 0 && imageAttachments.length === 0) || loading) {
      return;
    }
    // Vision guard: a concrete non-vision provider can't read images — warn and
    // hold (don't waste a request, don't drop the image). Auto routing (no explicit
    // provider) is allowed; the gateway returns an honest 422 if it can't be served.
    const effectiveProvider = selectedProvider ?? settings.defaultProvider ?? null;
    if (
      imageAttachments.length > 0 &&
      effectiveProvider &&
      !providerCanSeeImages(effectiveProvider)
    ) {
      setNotice({
        tone: "warn",
        text: `${effectiveProvider} can't read images — switch to a vision provider (e.g. Gemini) or remove the image.`,
      });
      return;
    }
    setNotice(null);
    // Consent before the first send to a third-party provider (parity w/ mobile).
    if (!hasProviderSendConsent()) {
      setPendingPrompt(trimmed);
      setConsentOpen(true);
      return;
    }
    void doSend(trimmed);
  }, [
    prompt,
    attachments,
    imageAttachments,
    selectedProvider,
    settings,
    loading,
    doSend,
  ]);

  function grantAndSend() {
    grantProviderSendConsent();
    setConsentOpen(false);
    const p = pendingPrompt;
    setPendingPrompt(null);
    // Send whenever a send is PENDING (p is a string — possibly "" for an
    // image-only turn). Guarding on truthiness dropped image-only first sends
    // after consent; `send()` already validated there is content (text or image).
    if (p !== null) void doSend(p);
  }

  const regenerate = useCallback(async () => {
    if (loading) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;
    const idx = messages.findIndex((m) => m.id === lastAssistant.id);

    // Regenerate must re-send the same image. The bytes aren't in history; they
    // live in lastSentImagesRef. If they're gone (e.g. after a reload) say so
    // rather than silently regenerating text-only — mirrors web.
    const lastUser = [...messages.slice(0, idx)].reverse().find((m) => m.role === "user");
    const reuseImages =
      lastUser?.images && lastUser.images.length > 0 ? lastSentImagesRef.current : [];
    if (lastUser?.images && lastUser.images.length > 0 && reuseImages.length === 0) {
      setNotice({
        tone: "warn",
        text: "Re-attach the image to regenerate this turn — images aren't kept after a reload.",
      });
      return;
    }

    // Sanitize: drop empty/dangling tool-round assistant bubbles and merge
    // adjacent same-role turns so Regenerate never replays a malformed
    // conversation (this also adds the `&& content` filter web has).
    const history = sanitizeSendHistory(
      messages.slice(0, idx).map((m) => ({ role: m.role, content: m.content })),
    );
    if (history.length === 0) return;
    // Re-attach the image blocks to the trailing user turn so the model sees them.
    if (reuseImages.length > 0) {
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i]!.role === "user") {
          const text =
            typeof history[i]!.content === "string"
              ? (history[i]!.content as string)
              : "";
          history[i] = {
            role: "user",
            content: buildImageMessageContent(text, reuseImages),
          };
          break;
        }
      }
    }
    updateMessage(lastAssistant.id, {
      content: "",
      toolCalls: undefined,
      mcpToolEvents: undefined,
    });
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
    // Route through saveTextFile so the export uses the native OS save dialog in
    // a Tauri build (the raw anchor path silently failed in the packaged app).
    void saveTextFile("zintus-chat.md", md, "text/markdown");
  }, [messages]);

  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  // ── Artifacts / canvas drawer ──────────────────────────────────────────────
  // Every artifact-worthy block (substantial code, full HTML, SVG, long markdown
  // doc) across the conversation. Detection is pure + identical to web (see
  // lib/artifacts.ts); ids are namespaced by message so two turns never collide.
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const { artifactList, artifactsByMessage } = useMemo(() => {
    const flat: Artifact[] = [];
    const byMessage: Record<string, Artifact[]> = {};
    for (const m of messages) {
      if (m.role !== "assistant" || !m.content) continue;
      const arts = extractArtifacts(m.content).map((a) => ({
        ...a,
        id: `${m.id}:${a.id}`,
      }));
      if (arts.length > 0) {
        byMessage[m.id] = arts;
        flat.push(...arts);
      }
    }
    // Fold re-emitted bodies into version histories so one artifact ≠ many.
    return { artifactList: foldArtifactVersions(flat), artifactsByMessage: byMessage };
  }, [messages]);

  const openArtifact = useCallback((id: string) => {
    setActiveArtifactId(id);
    setArtifactPanelOpen(true);
  }, []);

  // Close the drawer if the conversation no longer has any artifacts (e.g. after
  // a regenerate or switching to an empty thread).
  useEffect(() => {
    if (artifactList.length === 0) {
      setArtifactPanelOpen(false);
      setActiveArtifactId(null);
    }
  }, [artifactList.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 pb-4">
      {/* No card chrome: in the desktop shell the conversation IS the page
          (Claude-desktop pattern), not a panel floating inside one. */}
      <Card className="flex min-h-0 flex-1 flex-col border-0 bg-transparent shadow-none">
        <CardHeader className="flex flex-row items-center justify-between px-0">
          <CardTitle className="sr-only">Chat</CardTitle>
          <div className="flex items-center gap-2">
            {activeProjectName && (
              <span style={{ fontSize: 12, color: "var(--color-purple-bright, #c4b5fd)", display: "flex", alignItems: "center", gap: 4 }}>
                📁 {activeProjectName}
                <button
                  type="button"
                  title="Leave project"
                  onClick={() => {
                    setActiveProjectId(null);
                    setActiveProjectName(null);
                  }}
                  style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0 }}
                >
                  ×
                </button>
              </span>
            )}
            {activeProvider && (
              <Badge style={{ color: "var(--color-purple-bright)" }}>
                routed → {activeProvider}
              </Badge>
            )}
            <Link
              href="/settings/mcp"
              title={
                mcpToolCount > 0
                  ? `${mcpToolCount} MCP tool${mcpToolCount === 1 ? "" : "s"} active — the gateway runs them server-side. Manage in MCP settings.`
                  : "Connect MCP tool servers (run by your gateway) for this chat."
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 12,
                textDecoration: "none",
                padding: "2px 8px",
                borderRadius: 999,
                border: "1px solid",
                borderColor:
                  mcpToolCount > 0 ? "#7C3AED" : "var(--color-border)",
                color:
                  mcpToolCount > 0 ? "#a78bfa" : "var(--color-text-muted)",
                background:
                  mcpToolCount > 0 ? "rgba(124,58,237,0.10)" : "transparent",
              }}
            >
              <Wrench size={12} />
              {mcpToolCount > 0
                ? `${mcpToolCount} tool${mcpToolCount === 1 ? "" : "s"} active`
                : "MCP"}
            </Link>
            {artifactList.length > 0 && (
              <Button
                type="button"
                variant="secondary"
                aria-pressed={artifactPanelOpen}
                onClick={() => {
                  if (artifactPanelOpen) {
                    setArtifactPanelOpen(false);
                  } else {
                    openArtifact(activeArtifactId ?? artifactList[0]!.id);
                  }
                }}
                title="Show the substantial code, HTML, SVG and long documents from this chat"
              >
                <Layers size={14} style={{ marginRight: 4 }} />
                Artifacts ({artifactList.length})
              </Button>
            )}
            {messages.length > 0 && (
              <Button type="button" variant="secondary" onClick={exportThread}>
                Export
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3 px-0">


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
                  toolCalls={message.toolCalls}
                  mcpToolEvents={message.mcpToolEvents}
                  artifacts={artifactsByMessage[message.id]}
                  onOpenArtifact={openArtifact}
                  onRegenerate={
                    message.id === lastAssistantId && !loading ? regenerate : undefined
                  }
                />
              ))
            )}
          </div>

          {notice ? (
            <div
              style={{
                fontSize: 12,
                color:
                  notice.tone === "error"
                    ? "var(--color-bad, #f87171)"
                    : "var(--color-warn, #f59e0b)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {notice.text}
              <button type="button" onClick={() => setNotice(null)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>×</button>
            </div>
          ) : null}
          {imageAttachments.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {imageAttachments.map((a) => (
                <span
                  key={a.id}
                  title={`${a.block.width}×${a.block.height} · ${formatImageBytes(a.block.bytes)}${a.block.exifStripped ? " · EXIF stripped" : ""}`}
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, background: "var(--color-elevated)", border: "1px solid var(--color-border)", borderRadius: 8, padding: 4 }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.previewUrl}
                    alt={a.name}
                    width={28}
                    height={28}
                    style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4 }}
                  />
                  <span style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                  <span style={{ color: "var(--color-text-muted)" }}>{formatImageBytes(a.block.bytes)}</span>
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => removeImage(a.id)} style={{ background: "none", border: "none", color: "var(--color-text-muted)", cursor: "pointer", padding: 0 }}>×</button>
                </span>
              ))}
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {attachments.map((a) => (
                <span key={a.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, background: "var(--color-elevated)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "4px 8px" }}>
                  📄 {a.name}
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))} style={{ background: "none", border: "none", color: "var(--color-text-muted)", cursor: "pointer", padding: 0 }}>×</button>
                </span>
              ))}
            </div>
          ) : null}
          <input
            type="file"
            ref={fileInputRef}
            accept=".txt,.md,.markdown,.csv,.json,.yaml,.yml,.toml,.ts,.tsx,.js,.jsx,.py,.go,.rs,.sh,.sql,.html,.css,.xml"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            type="file"
            ref={imageInputRef}
            accept="image/png,image/jpeg,image/webp"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {/* Composer — web-app parity: one rounded container, "+" attach
              menu bottom-left, compact mode chips + route pulldowns, round
              accent send arrow bottom-right. */}
          <div
            style={{
              border: "1px solid var(--color-border)",
              background: "var(--color-elevated)",
              borderRadius: 16,
              padding: "10px 12px 8px",
            }}
          >
            <Textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask anything…"
              className="border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
              style={{ resize: "none" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="mt-1 flex items-center gap-1.5">
              {/* + attach menu */}
              <div ref={plusRef} style={{ position: "relative" }}>
                <button
                  type="button"
                  aria-label="Add attachments"
                  aria-expanded={plusOpen}
                  onClick={() => setPlusOpen((v) => !v)}
                  className="app-icon-btn"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 30,
                    height: 30,
                    border: "1px solid var(--color-border)",
                    borderRadius: 8,
                    color: "var(--color-text-sub)",
                    cursor: "pointer",
                  }}
                >
                  <Plus size={15} />
                </button>
                {plusOpen ? (
                  <div
                    role="menu"
                    style={{
                      position: "absolute",
                      bottom: 38,
                      left: 0,
                      minWidth: 200,
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 12,
                      padding: 4,
                      boxShadow: "var(--shadow-md)",
                      zIndex: 30,
                    }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setPlusOpen(false);
                        fileInputRef.current?.click();
                      }}
                      className="app-icon-btn"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                        width: "100%",
                        padding: "8px 10px",
                        border: "none",
                        borderRadius: 8,
                        color: "var(--color-text)",
                        fontSize: 13,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <Paperclip size={14} style={{ color: "var(--color-text-sub)" }} />
                      Add files
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setPlusOpen(false);
                        imageInputRef.current?.click();
                      }}
                      title="PNG/JPEG/WebP — decoded, resized and EXIF-stripped on this device; needs a vision-capable provider."
                      className="app-icon-btn"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                        width: "100%",
                        padding: "8px 10px",
                        border: "none",
                        borderRadius: 8,
                        color: "var(--color-text)",
                        fontSize: 13,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <ImagePlus size={14} style={{ color: "var(--color-text-sub)" }} />
                      Add photos
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Mode chips */}
              <ComposerChip
                active={Boolean(settings.blockTrainingProviders)}
                onClick={() =>
                  update({ blockTrainingProviders: !settings.blockTrainingProviders })
                }
                title="Private Mode — refuse providers that train on your data (may reduce availability)"
              >
                Private
              </ComposerChip>
              <ComposerChip
                active={toolsEnabled}
                onClick={() =>
                  setToolsEnabled((v) => {
                    const next = !v;
                    if (typeof localStorage !== "undefined") {
                      localStorage.setItem("zintus:desktop-tools", String(next));
                    }
                    return next;
                  })
                }
                title={`Let the model call built-in tools (${BUILTIN_WEB_TOOLS.map((t) => t.definition.name).join(", ")}). Runs locally on this device; needs a tool-capable provider.`}
              >
                Tools
              </ComposerChip>
              <ComposerChip
                active={jsonMode}
                onClick={() =>
                  setJsonMode((v) => {
                    const next = !v;
                    if (typeof localStorage !== "undefined") {
                      localStorage.setItem("zintus:desktop-json", String(next));
                    }
                    return next;
                  })
                }
                title="Structured output — request response_format: json_object. The gateway resolves the best level the routed provider can serve; only real JSON is rendered."
              >
                JSON
              </ComposerChip>

              {/* Route pulldowns — compact, borderless */}
              <select
                id="provider-select"
                aria-label="Provider override"
                value={selectedProvider ?? "auto"}
                onChange={(e) => {
                  const value = e.target.value;
                  setSelectedProvider(value === "auto" ? null : (value as ProviderId));
                }}
                style={{
                  height: 28,
                  border: "none",
                  background: "transparent",
                  color: "var(--color-text-sub)",
                  fontSize: 12,
                  padding: "0 4px",
                  cursor: "pointer",
                }}
              >
                <option value="auto">Auto ({settings.routingStrategy})</option>
                {PROVIDER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <select
                aria-label="Routing strategy"
                value={settings.routingStrategy}
                onChange={(e) =>
                  update({ routingStrategy: e.target.value as RoutingStrategy })
                }
                title="Routing strategy (used in Auto mode)"
                style={{
                  height: 28,
                  border: "none",
                  background: "transparent",
                  color: "var(--color-text-sub)",
                  fontSize: 12,
                  padding: "0 4px",
                  cursor: "pointer",
                }}
              >
                <option value="fastest">Fastest</option>
                <option value="capability">Capability</option>
                <option value="economy">Cheapest</option>
              </select>

              <div style={{ flex: 1 }} />

              {loading ? (
                <button
                  type="button"
                  onClick={stop}
                  aria-label="Stop generating"
                  title="Stop generating"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-surface)",
                    color: "var(--color-text)",
                    cursor: "pointer",
                  }}
                >
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  aria-label="Send"
                  disabled={
                    !prompt.trim() &&
                    attachments.length === 0 &&
                    imageAttachments.length === 0
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    border: "none",
                    background: "var(--color-purple-mid)",
                    color: "#fff",
                    cursor: "pointer",
                    opacity:
                      !prompt.trim() &&
                      attachments.length === 0 &&
                      imageAttachments.length === 0
                        ? 0.4
                        : 1,
                  }}
                >
                  <ArrowUp size={16} strokeWidth={2.4} />
                </button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {artifactPanelOpen && artifactList.length > 0 ? (
        <ArtifactPanel
          artifacts={artifactList}
          activeId={activeArtifactId}
          onSelect={setActiveArtifactId}
          onClose={() => setArtifactPanelOpen(false)}
        />
      ) : null}

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

/** Small pill toggle for the composer row (Private / Tools / JSON). */
function ComposerChip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      style={{
        height: 28,
        padding: "0 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        border: `1px solid ${active ? "var(--color-purple-mid)" : "var(--color-border)"}`,
        background: active ? "var(--color-purple-faint)" : "transparent",
        color: active ? "var(--color-purple-bright)" : "var(--color-text-sub)",
        transition: "all 120ms ease",
      }}
    >
      {children}
    </button>
  );
}
