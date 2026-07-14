"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useShallow } from "zustand/react/shallow";
import type { ResearchDepth } from "@/lib/gateway";
import { MessageBubble } from "@/app/_components/MessageBubble";
import { ArtifactPanel } from "@/app/_components/ArtifactPanel";
import {
  buildArtifactRefeed,
  extractConversationArtifacts,
  foldArtifactVersions,
  type ArtifactVersion,
  type ExtractCacheEntry,
} from "@/lib/artifacts";
import {
  decideSpend,
  denyReasonText,
  newArtifactBudget,
  NO_CONSENT,
} from "@/lib/artifact-quota";
import { ProviderPicker } from "@/app/_components/ProviderPicker";
import { StructuredOutputControl } from "@/app/_components/StructuredOutputControl";
import {
  buildResponseFormat,
  parseStructuredResponse,
  validateAgainstSchema,
  LEGACY_JSON_KEY,
  STRUCTURED_MODE_KEY,
  STRUCTURED_SCHEMA_KEY,
  type StructuredMode,
} from "@/lib/structured-output";
import { ThemeToggle } from "@/components/marketing/ThemeToggle";
import { LocalKeyManager } from "@/app/_components/LocalKeyManager";
import { ConsentDialog } from "@/app/_components/ConsentDialog";
import { useDismissableMenu } from "@/app/_components/useDismissableMenu";
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
  imageAwareHistory,
  UnsupportedCapabilityError,
  type ChatMcpConfig,
  type ChatMessage,
  type McpToolEvent,
} from "@/lib/chat-client";
import { activeMcpServersForChat, loadMcpServers } from "@/lib/mcp-config";
import { processImage, MediaError } from "@zintus/media";
import type { ContentBlock, ImageContentBlock, ProviderId } from "@zintus/types";
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
import { extractPdfText } from "@/lib/extract-pdf";
import { memorySystemMessage } from "@/lib/memory";
import { downloadFile } from "@/lib/download";
import {
  grantProviderSendConsent,
  hasProviderSendConsent,
} from "@/lib/consent";
import {
  getActiveProject,
  setActiveProjectId,
  listProjects,
  createProject,
  type Project,
} from "@/lib/projects";
import { captureScreenshotFile, screenshotSupported } from "@/lib/screenshot";
import { loadPresets, type Preset } from "@/lib/presets";
import { useProviderStatusStore, useSettingsStore } from "@/lib/store";
import { useSidebarStore } from "@/lib/sidebar-store";
import {
  useSpeechRecognition,
  appendDictation,
} from "@/lib/use-speech-recognition";
import { LOCAL_PROVIDER_IDS, PROVIDER_BY_ID } from "@/lib/providers";
import { readPinnedModel, unpinModel } from "@/lib/pinned-model";
import {
  deriveProviderStatus,
  resolveProviderStatusInput,
} from "@/app/(app)/providers/status";

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

/** A text or PDF file: its text is extracted client-side and folded into the
 *  prompt. `pages` is set for PDFs so the chip can show "📄 extracted N pages";
 *  `truncated` flags a long PDF whose tail we stopped reading. */
interface TextAttachment {
  id: string;
  kind: "text";
  name: string;
  content: string;
  mimeType: string;
  pages?: number;
  truncated?: boolean;
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
 * Build the chat body's `mcp` block from the user's enabled MCP servers (PR2's
 * `loadMcpServers` → `activeMcpServersForChat`), plus the active tool count for
 * the header indicator. The gateway runs these tools SERVER-SIDE; the web only
 * displays the resulting activity. Returns `undefined` when nothing is enabled.
 */
async function activeMcpForChat(): Promise<{
  mcp: ChatMcpConfig | undefined;
  toolCount: number;
}> {
  const { servers } = activeMcpServersForChat(await loadMcpServers());
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

/** Stable empty reference so the per-thread artifact-edits selector doesn't
 *  return a fresh object each render (which would thrash zustand subscribers). */
const EMPTY_ARTIFACT_EDITS: Record<string, ArtifactVersion[]> = {};

/** Client opt-in for artifact mode (re-feed + tag-authoring). Off by default —
 *  same posture as goal 1's per-request flag. Toggled in settings. */
function artifactModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("zintus:artifact-mode") === "true";
  } catch {
    return false;
  }
}

export default function ChatPage() {
  const { settings, hydrate, update: updateSettings } = useSettingsStore();
  const { unlock } = useProviderStatusStore();
  const router = useRouter();
  const toggleSidebar = useSidebarStore((s) => s.toggle);
  // Atomic value selectors — re-render only when these specific fields change
  // (not on unrelated store writes like terminal-line spam or savings updates).
  const threadId = useAppStore((s) => s.threadId);
  const activeThreadId = useAppStore((s) => s.activeThreadId);
  const selectedProvider = useAppStore((s) => s.selectedProvider);
  const gatewayConnected = useAppStore((s) => s.gatewayConnected);
  const gatewayProviders = useAppStore((s) => s.gatewayProviders);
  const vaultProviders = useProviderStatusStore((s) => s.providers);
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
    switchThread,
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
      switchThread: s.switchThread,
    })),
  );
  const messages = useAppStore(
    (state) =>
      state.threads.find((t) => t.id === state.activeThreadId)?.messages ?? [],
  );
  const activeThreadTitle = useAppStore(
    (state) =>
      state.threads.find((t) => t.id === state.activeThreadId)?.title ?? "New chat",
  );
  const incognito = useAppStore(
    (state) =>
      state.threads.find((t) => t.id === state.activeThreadId)?.incognito ??
      false,
  );
  // Persisted per-artifact user edits for the active thread (survive reload).
  const threadArtifactEdits = useAppStore(
    (state) => state.artifactEdits[state.activeThreadId] ?? EMPTY_ARTIFACT_EDITS,
  );
  const addArtifactEdit = useAppStore((state) => state.addArtifactEdit);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [keyManagerOpen, setKeyManagerOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [notice, setNotice] = useState<ComposerNotice | null>(null);
  // Pinned-provider readiness notice: dismissed per pinned-provider (a repin
  // to a different provider — or a status flip that changes which provider is
  // pinned — makes it reappear). Purely informational; it never blocks send,
  // LocalKeyManager's vault dialog remains the hard gate.
  const [dismissedPinnedProvider, setDismissedPinnedProvider] =
    useState<ProviderId | null>(null);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);
  // Count of MCP tools active this chat (header indicator). Read from localStorage
  // on mount + when the window regains focus (e.g. after editing /settings/mcp).
  const [mcpToolCount, setMcpToolCount] = useState(0);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  // Local mode = no cloud session cookie. Set after mount to avoid an SSR/CSR
  // hydration mismatch (document.cookie is client-only).
  const [localMode, setLocalMode] = useState(false);
  // Collapsed secondary-controls popover ("⚙ More") and the New-chat affordance
  // menu (which owns the incognito option). Both close on outside click.
  const [moreOpen, setMoreOpen] = useState(false);
  const [newChatMenuOpen, setNewChatMenuOpen] = useState(false);
  // Composer "+" (Add) menu — screenshot / project / GitHub / skills, plus the
  // existing file picker. `addProjectSubOpen` reveals the project picker inline.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addProjectSubOpen, setAddProjectSubOpen] = useState(false);
  const [projectList, setProjectList] = useState<Project[]>([]);
  // Resolved after mount (reads `navigator`) so the control's enabled/disabled
  // state is stable between SSR and the client.
  const [canScreenshot, setCanScreenshot] = useState(false);
  // Gate theme-dependent UI until mount: next-themes returns `undefined` during
  // SSR, so rendering the resolved theme immediately causes a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const newChatRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Private mode remembers the chat you were in so turning it OFF restores it.
  const prevThreadIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Scroll anchoring (10.3b): track whether the user is pinned to the bottom so
  // streaming auto-scroll never fights a user who scrolled up to read history.
  const messagesRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
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

  // Canvas / artifact mode (persisted): adds artifact-authoring instructions to
  // the prompt and re-feeds the current version on the next turn. Off by default.
  const [artifactMode, setArtifactMode] = useState(() => {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("zintus:artifact-mode") === "true";
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

  // Research mode (persisted): when on, the composer routes the prompt to the
  // real Deep Research surface (/research) at the chosen depth instead of a
  // normal chat turn. No fake inline research — it runs where the backend lives.
  const [researchMode, setResearchMode] = useState(() => {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("zintus:research-mode") === "true";
    }
    return false;
  });
  const [researchDepth, setResearchDepth] = useState<ResearchDepth>(() => {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem("zintus:research-depth");
      if (saved === "quick" || saved === "standard" || saved === "deep") {
        return saved;
      }
    }
    return "standard";
  });

  // Structured-output control (persisted): off / json_object / json_schema. In
  // json_schema mode the user pastes a JSON Schema; we build the exact
  // `response_format` the gateway/engine already accept. The gateway resolves the
  // best level the chosen provider can serve, or returns an honest 422. Only
  // Gemini guarantees json_schema; others are best-effort (see the caveat).
  const [jsonMode, setJsonMode] = useState<StructuredMode>(() => {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(STRUCTURED_MODE_KEY);
      if (saved === "json_object" || saved === "json_schema" || saved === "off") {
        return saved;
      }
      // Migrate the legacy boolean toggle → json_object.
      if (localStorage.getItem(LEGACY_JSON_KEY) === "true") return "json_object";
    }
    return "off";
  });
  const [jsonSchemaText, setJsonSchemaText] = useState(() =>
    typeof localStorage !== "undefined"
      ? (localStorage.getItem(STRUCTURED_SCHEMA_KEY) ?? "")
      : "",
  );
  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STRUCTURED_MODE_KEY, jsonMode);
    }
  }, [jsonMode]);
  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STRUCTURED_SCHEMA_KEY, jsonSchemaText);
    }
  }, [jsonSchemaText]);

  // The built response_format for this turn (or an inline error when a pasted
  // json_schema is malformed — we then BLOCK the send and never ship a broken
  // schema). Recomputed only when the mode/schema changes.
  const structuredBuild = useMemo(
    () => buildResponseFormat({ mode: jsonMode, schemaText: jsonSchemaText }),
    [jsonMode, jsonSchemaText],
  );
  const schemaError =
    jsonMode === "json_schema" ? (structuredBuild.error ?? null) : null;

  // ── Artifacts / canvas side panel ─────────────────────────────────────────
  // The panel lists every artifact-worthy block (substantial code, full HTML,
  // SVG, long markdown doc) across the conversation. Detection is pure (see
  // lib/artifacts.ts); ids are namespaced by message so two turns never collide.
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  // Per-message extraction cache: re-parse only the message whose content
  // changed (a streamed token grows the LAST message; prior ones are cache hits).
  const artifactCacheRef = useRef<Map<string, ExtractCacheEntry>>(new Map());
  const { artifactList, artifactsByMessage } = useMemo(() => {
    // While streaming, the last assistant message is mid-write — hold it back
    // until its fences close so a half-open block doesn't thrash the panel.
    const streamingId = loading
      ? [...messages].reverse().find((m) => m.role === "assistant")?.id
      : undefined;
    const { flat, byMessage } = extractConversationArtifacts(
      messages,
      artifactCacheRef.current,
      { streamingId },
    );
    // Fold re-emitted bodies into version histories so one artifact ≠ many.
    return { artifactList: foldArtifactVersions(flat), artifactsByMessage: byMessage };
  }, [messages, loading]);

  // Live refs so the send handler can read the CURRENT artifact state without a
  // stale closure (and without widening the big send useCallback's deps).
  const artifactListRef = useRef(artifactList);
  artifactListRef.current = artifactList;
  const activeArtifactIdRef = useRef(activeArtifactId);
  activeArtifactIdRef.current = activeArtifactId;
  const threadArtifactEditsRef = useRef(threadArtifactEdits);
  threadArtifactEditsRef.current = threadArtifactEdits;

  /** The current artifact's latest version (user edit if any, else the model's),
   *  serialised as a re-feed block — or null when there's nothing to re-feed. */
  function currentArtifactRefeed(): string | null {
    const list = artifactListRef.current;
    if (list.length === 0) return null;
    const activeId = activeArtifactIdRef.current;
    const active =
      list.find((a) => a.id === activeId) ??
      list.find((a) => a.versions.some((v) => v.sourceId === activeId)) ??
      list[list.length - 1];
    if (!active) return null;
    const edits = threadArtifactEditsRef.current[active.id] ?? [];
    const latest =
      edits.length > 0 ? edits[edits.length - 1] : active.versions[active.versions.length - 1];
    if (!latest) return null;
    const modelId = active.id.startsWith("decl:") ? active.id.slice("decl:".length) : active.id;
    return buildArtifactRefeed({
      kind: latest.kind,
      title: latest.title,
      content: latest.content,
      language: latest.language,
      declaredId: modelId,
    });
  }

  /** Re-bake the current artifact on another model: pre-load the composer with
   *  the target model forced + the current version + an instruction, and let the
   *  user confirm with ⏎ (explicit consent before the spend — the cost is shown). */
  const handleRebake = useCallback(
    (targetModel: string, targetProvider: string, estUsd: number) => {
      const refeed = currentArtifactRefeed();
      if (!refeed) return;
      // Resolve the artifact being re-baked (same pick as the re-feed).
      const list = artifactListRef.current;
      const activeId = activeArtifactIdRef.current;
      const active =
        list.find((a) => a.id === activeId) ??
        list.find((a) => a.versions.some((v) => v.sourceId === activeId)) ??
        list[list.length - 1];
      if (!active) return;
      // Quota gate: enforce the per-artifact cap + rate. The user clicking
      // Re-bake (then confirming with ⏎) IS the consent, so consent isn't
      // required here — but the spend cap still is.
      const store = useAppStore.getState();
      const budget = store.artifactBudgets[activeThreadId]?.[active.id] ?? newArtifactBudget();
      const consent = store.artifactConsents[activeThreadId]?.[active.id] ?? NO_CONSENT;
      const decision = decideSpend(budget, consent, estUsd, { requireConsent: false });
      if (!decision.allow) {
        setNotice({
          tone: "warn",
          text: `Re-bake blocked — ${denyReasonText(decision.reason)} (cap $${budget.capUsd.toFixed(2)}, spent $${budget.spentUsd.toFixed(4)}).`,
        });
        return;
      }
      // Account the estimate now (conservative); the real charge is reconciled
      // by the normal per-response cost path when the turn runs.
      store.recordArtifactSpend(activeThreadId, active.id, estUsd);
      try {
        localStorage.setItem(
          "zintus:selected-model",
          JSON.stringify({ id: targetModel, provider: targetProvider }),
        );
      } catch {
        /* storage unavailable — provider is still forced below */
      }
      setSelectedProvider(targetProvider as ProviderId);
      setInput(
        `Re-bake this artifact on ${targetModel} — keep it functionally identical, ` +
          `just regenerate it and re-emit it with the same artifact id.\n\n${refeed}`,
      );
      setArtifactPanelOpen(true);
      setNotice({
        tone: "ok",
        text: `Loaded a re-bake on ${targetModel} (~$${estUsd.toFixed(5)} est.). Press ⏎ to run it.`,
      });
      inputRef.current?.focus();
    },
    [setSelectedProvider, activeThreadId],
  );

  const openArtifact = useCallback((id: string) => {
    setActiveArtifactId(id);
    setArtifactPanelOpen(true);
  }, []);

  // Close the panel if the conversation no longer has any artifacts (e.g. after
  // a regenerate or switching to an empty thread).
  useEffect(() => {
    if (artifactList.length === 0) {
      setArtifactPanelOpen(false);
      setActiveArtifactId(null);
    }
  }, [artifactList.length]);

  useEffect(() => {
    hydrate();
    void unlock();
    setLocalMode(!document.cookie.includes("zintus_session="));
    setPresets(loadPresets());
    setActiveProjectName(getActiveProject()?.name ?? null);
    setCanScreenshot(screenshotSupported());
    setMounted(true);
  }, [hydrate, unlock]);

  // Keep the header's "🔧 N tools active" indicator in sync with the user's MCP
  // settings (localStorage): recompute on mount + whenever the window regains
  // focus (the user may have just changed servers in /settings/mcp).
  useEffect(() => {
    const refresh = () =>
      void activeMcpForChat().then(({ toolCount }) => setMcpToolCount(toolCount));
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

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
    // Reset scroll-anchor state so a freshly-opened thread starts pinned to the
    // bottom. A stale atBottomRef=false (from having scrolled up in the previous
    // thread) would otherwise disable auto-scroll and mis-show the jump pill; the
    // messages effect below re-anchors to the bottom once atBottomRef is true.
    atBottomRef.current = true;
    setShowJump(false);
  }, [activeThreadId]);

  // Auto-scroll to the latest ONLY while anchored at the bottom (10.3b) — never
  // yank a user who has scrolled up. Reduced-motion → no smooth scroll.
  useEffect(() => {
    if (!atBottomRef.current) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    bottomRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
  }, [messages]);

  // Track distance from the bottom of the scroll region: re-anchor when near the
  // bottom, and reveal the "Jump to latest" pill once ≥300px away.
  const handleMessagesScroll = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distance < 80;
    setShowJump(distance > 300);
  }, []);

  const jumpToBottom = useCallback(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    bottomRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  // Auto-grow the composer textarea (1 → ~8 lines) as the user types, then let
  // it scroll. Keyed to `input` so it also collapses back after send/clear.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 184)}px`;
  }, [input]);

  // Dismiss each composer popover consistently: mousedown-outside (unchanged),
  // Escape (restores focus to the trigger), and focus-out of the subtree.
  useDismissableMenu(moreOpen, () => setMoreOpen(false), moreRef);
  useDismissableMenu(newChatMenuOpen, () => setNewChatMenuOpen(false), newChatRef);
  useDismissableMenu(
    addMenuOpen,
    () => {
      setAddMenuOpen(false);
      setAddProjectSubOpen(false);
    },
    addMenuRef,
  );

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

      const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");

      // ── PDF branch — text extracted CLIENT-SIDE, then folded in like text ───
      // Bytes never leave the browser; a scanned/corrupt/oversize PDF yields an
      // honest notice (no fabricated text). See lib/extract-pdf.ts for the
      // CSP-safe (eval-free, no-worker, no-WASM) pdf.js config.
      if (file.type === "application/pdf" || ext === ".pdf") {
        const result = await extractPdfText(file);
        if ("error" in result) {
          setNotice({ tone: "error", text: `${file.name}: ${result.error}` });
          continue;
        }
        setAttachments((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            kind: "text",
            name: file.name,
            content: result.text,
            mimeType: "application/pdf",
            pages: result.pages,
            truncated: result.truncated,
          },
        ]);
        if (result.truncated) {
          setNotice({
            tone: "warn",
            text: `${file.name}: read the first ${result.pages} pages — the rest wasn't included.`,
          });
        } else {
          setNotice(null);
        }
        continue;
      }

      // ── Text branch — extracted + sent inline (unchanged) ──────────────────
      if (!TEXT_EXTENSIONS.has(ext)) {
        setNotice({
          tone: "error",
          text: `${file.name} isn't a supported file — attach an image (PNG/JPEG/WebP), a PDF, or a text file.`,
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

  // "Take a screenshot": prompt the browser's screen picker, grab one frame,
  // then run it through the SAME image pipeline as a file attachment (resize +
  // EXIF strip + vision guard). Cancelling the picker is a quiet no-op.
  const handleScreenshot = useCallback(async () => {
    setAddMenuOpen(false);
    try {
      const file = await captureScreenshotFile();
      await handleFiles([file]);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Couldn't capture the screen.";
      // A user-cancelled capture shouldn't read as an error.
      if (!/cancelled/i.test(reason)) {
        setNotice({ tone: "error", text: reason });
      }
    }
  }, [handleFiles]);

  // "Add to project": make `project` the active project so its instructions lead
  // this (and the next) chat, and show the header chip. Real, local-first — same
  // mechanism as the Projects page. No chat is lost; the project just scopes it.
  const attachToProject = useCallback((project: Project) => {
    setActiveProjectId(project.id);
    setActiveProjectName(project.name);
    setAddMenuOpen(false);
    setAddProjectSubOpen(false);
    setNotice({
      tone: "ok",
      text: `This chat is now in “${project.name}” — its instructions lead each new chat.`,
    });
  }, []);

  const streamAssistant = useCallback(
    async (
      assistantId: string,
      sendMessages: ChatMessage[],
      promptForLog: string,
      hadImages: boolean,
      // Regenerate-with-model override (10.6): when present it forces the route
      // for THIS turn only — `null` = Auto, a ProviderId = that provider — and
      // bypasses the pinned catalog model. Absent → normal composer routing.
      override?: { provider: ProviderId | null },
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

      // The user's enabled MCP servers for this turn (read fresh, like apiKeys).
      // When present the gateway runs the tools SERVER-SIDE and streams
      // `mcp_tool_call`/`mcp_tool_result` events; we only display them.
      const { mcp } = await activeMcpForChat();

      // Route for this turn: an override (regenerate-with-model) forces the
      // provider and ignores the pinned catalog model; otherwise use the
      // composer's selected provider.
      const overrideActive = override !== undefined;
      const effectiveProvider = overrideActive
        ? (override.provider ?? undefined)
        : (selectedProvider ?? undefined);

      // Catalog "Use this model": route to the exact chosen model, but ONLY when it
      // belongs to the currently-selected provider (avoid a stale model after the
      // user switches providers in the composer). Skipped under an override.
      let catalogModel: string | undefined;
      if (!overrideActive) {
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
      }

      // The last assistant text streamed this turn — used after the loop to
      // locally validate a json_schema response (non-blocking honesty notice).
      let finalText = "";

      try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
          let streamedText = "";
          // Server-side MCP tool-loop events for THIS round's request, accumulated
          // and patched onto the active assistant bubble as they stream in.
          const roundMcpEvents: McpToolEvent[] = [];
          const result = await streamChat({
            messages: convo,
            providerId: effectiveProvider,
            model: catalogModel,
            mode: settings.contextMode,
            threadId: useThread ? threadId : undefined,
            // Active project (if any) — compiles the project's memory facts into
            // this turn's context alongside thread + global facts.
            projectId: getActiveProject()?.id,
            // Incognito/private: tell the gateway to persist NOTHING durable for
            // this turn (conversation, memory, traces, cache, activity).
            persist: incognito ? false : undefined,
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
            responseFormat: structuredBuild.responseFormat,
            mcp,
            artifactMode: artifactModeEnabled(),
            signal: controller.signal,
            onChunk: (text) => {
              streamedText = text;
              updateMessage(currentAssistantId, text);
            },
            onMcpToolEvent: (event) => {
              roundMcpEvents.push(event);
              patchMessage(currentAssistantId, {
                mcpToolEvents: [...roundMcpEvents],
              });
            },
          });

          finalText = streamedText;
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

        // json_schema turn: validate the response LOCALLY and, if it doesn't
        // conform, surface a NON-BLOCKING notice. The output still renders
        // (MessageBubble shows the JSON) — best-effort honesty, never a crash.
        const schema = structuredBuild.responseFormat?.schema;
        if (schema && finalText.trim()) {
          const parsed = parseStructuredResponse(finalText);
          if (parsed !== undefined) {
            const issues = validateAgainstSchema(parsed, schema);
            if (issues.length > 0) {
              const first = issues[0]!;
              const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
              setNotice({
                tone: "warn",
                text: `Response doesn't match the schema: ${first.path} ${first.message}${more}. Showing it anyway.`,
              });
            }
          }
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
        // Preserve whatever partially streamed — do NOT overwrite the body with
        // "Error: …". The failure rides ONLY in the `error` field; MessageBubble
        // renders the partial answer with a compact error card beneath it.
        const rawPayload =
          error instanceof Error ? (error.stack ?? error.message) : String(error);
        patchMessage(currentAssistantId, { error: rawPayload });
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
      structuredBuild,
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
    // Research mode: hand the prompt off to the real Deep Research surface at
    // the chosen depth (it owns the research backend + consent). Honest — no
    // fake inline research.
    if (researchMode && input.trim()) {
      router.push(
        `/research?q=${encodeURIComponent(input.trim())}&depth=${researchDepth}`,
      );
      setInput("");
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
    // Never send a broken json_schema: surface the parse error and hold the turn.
    if (schemaError) {
      setNotice({ tone: "error", text: `JSON Schema is invalid: ${schemaError}` });
      setMoreOpen(true);
      return;
    }
    const prompt = input.trim();

    // Text-file attachments fold into the prompt (extracted text). Images do NOT
    // — they ride as real content blocks below; no fake "[Image: …]" note.
    let textPrefix = "";
    for (const att of attachments) {
      if (att.kind !== "text") continue;
      if (att.pages !== undefined) {
        // PDF: extracted text, not source — label honestly with the page count.
        const more = att.truncated ? ` (first ${att.pages}, truncated)` : "";
        textPrefix += `[PDF: ${att.name} — ${att.pages} page${att.pages === 1 ? "" : "s"}${more}]\n\`\`\`\n${att.content}\n\`\`\`\n\n`;
      } else {
        const ext = att.name.split(".").pop() ?? "txt";
        textPrefix += `[File: ${att.name}]\n\`\`\`${ext}\n${att.content}\n\`\`\`\n\n`;
      }
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

    // Re-feed (goal 4, opt-in): when artifact mode is on, prepend the user's
    // CURRENT artifact version (incl. local edits) as invisible context so a
    // follow-up like "make the button bigger" edits the version they're looking
    // at — not the model's original. Only affects the SENT content; the visible
    // bubble stays the user's plain text.
    const refeed = artifactModeEnabled() ? currentArtifactRefeed() : null;
    const sentUserText = refeed ? `${refeed}\n\n---\n\nMy request: ${userText}` : userText;

    // The SENT user content: a block array (text first, then images) when images
    // are attached, else plain text. The gateway reads images from these blocks.
    const userMessageContent: string | ContentBlock[] =
      imageBlocks.length > 0
        ? buildImageMessageContent(sentUserText, imageBlocks)
        : sentUserText;

    // Sanitize the store-derived history before sending: the tools loop can
    // leave empty-content assistant bubbles and adjacent same-role turns that a
    // strict role-alternation provider (Gemini) would reject. Subsumes the old
    // `&& content` intent. The trailing user turn is preserved.
    const history: ChatMessage[] = sanitizeSendHistory([
      ...imageAwareHistory(messages),
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
    schemaError,
    selectedProvider,
    settings,
    streamAssistant,
    threadId,
    toolsEnabled,
    researchMode,
    researchDepth,
    router,
  ]);

  const regenerate = useCallback(async (override?: ProviderId | null) => {
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
      imageAwareHistory(
        (s.threads.find((t) => t.id === s.activeThreadId)?.messages ?? []).filter(
          (message) => message.id !== assistant.id && message.content,
        ),
      ),
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
      override === undefined ? undefined : { provider: override },
    );
  }, [appendMessage, dropLastAssistant, loading, messages, streamAssistant, threadId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
  }, []);

  // Esc stops an in-flight stream from anywhere on the page (10.7), not only
  // when the composer textarea holds focus.
  useEffect(() => {
    if (!loading) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") stop();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loading, stop]);

  // Voice input (dictation): the BROWSER's Web Speech recognizer fills the
  // composer textarea — no audio touches the gateway/relay, and the user still
  // presses send. Finalized chunks append to the existing `input` state so they
  // ride the normal send path. Interim words show as a live preview only.
  const handleDictation = useCallback((chunk: string) => {
    setInput((prev) => appendDictation(prev, chunk));
  }, []);
  const speech = useSpeechRecognition({ onFinalTranscript: handleDictation });
  const toggleDictation = useCallback(() => {
    if (speech.listening) speech.stop();
    else speech.start();
  }, [speech]);
  // Surface a recognition error (denied mic / no speech) as a calm composer
  // notice, consistent with attachment errors.
  useEffect(() => {
    if (speech.error) setNotice({ tone: "warn", text: speech.error });
  }, [speech.error]);

  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;

  // Thread-header meta (design parity): "N messages · routed via X · saved ~$Y".
  const routedVia = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.providerId)?.providerId;
  const savedThisChat = messages.reduce(
    (sum, m) => sum + (m.meta?.savedUsd ?? 0),
    0,
  );

  // Providers offered in the last answer's "Regenerate with" menu (10.6): the
  // ones the user actually has a usable key/runtime for, plus the routed
  // provider so its checkmark shows. Empty → the plain Regenerate button.
  const regenerateProviders = useMemo<ProviderId[]>(() => {
    const set = new Set<string>();
    for (const p of gatewayProviders) {
      if (p.hasKey) set.add(p.id);
      if ((p.id === "ollama" || p.id === "lmstudio") && p.available) set.add(p.id);
    }
    for (const v of vaultProviders) {
      if (v.hasKey) set.add(v.id);
    }
    if (routedVia) set.add(routedVia);
    return [...set] as ProviderId[];
  }, [gatewayProviders, vaultProviders, routedVia]);

  // The provider the next send will (likely) hit — used to surface an honest,
  // non-interactive "Vision" capability chip next to the attach control so it's
  // clear up front whether the selected route can actually read an image.
  const effectiveComposerProvider =
    selectedProvider ?? settings.defaultProvider ?? null;
  const visionReady = effectiveComposerProvider
    ? providerCanSeeImages(effectiveComposerProvider)
    : false;

  // Task 3 — pinned-model key notice. "Pinned" means the catalog pin
  // (Models page's "Use this model", or the composer's model picker) targets
  // the CURRENTLY selected provider — a stale pin left over from a since-
  // changed provider is not a pin. Re-reads localStorage whenever
  // `selectedProvider` changes, mirroring the send-path's own pin check.
  const pinnedModel = useMemo(() => {
    if (!selectedProvider) return null;
    const sel = readPinnedModel();
    return sel && sel.provider === selectedProvider ? sel : null;
  }, [selectedProvider]);
  const pinnedProviderId = pinnedModel
    ? (pinnedModel.provider as ProviderId)
    : null;

  // Reuse the EXACT status derivation the Providers page uses (deriveProviderStatus
  // + resolveProviderStatusInput) — this notice never re-judges "ready" on its own.
  const pinnedProviderStatus = useMemo(() => {
    if (!pinnedProviderId) return null;
    const isLocal = LOCAL_PROVIDER_IDS.has(pinnedProviderId);
    const gateway = gatewayProviders.find((p) => p.id === pinnedProviderId);
    const vault = vaultProviders.find((p) => p.id === pinnedProviderId);
    return deriveProviderStatus(
      resolveProviderStatusInput({ isLocal, gatewayConnected, gateway, vault }),
    );
  }, [pinnedProviderId, gatewayProviders, vaultProviders, gatewayConnected]);

  // Only two of deriveProviderStatus's outcomes are "not ready" for this
  // informational strip — a keyed-but-degraded provider (cooldown/exhausted/
  // unavailable) is left to the existing send-time error handling instead.
  const pinnedNoticeKind: "key" | "local" | null =
    pinnedProviderStatus?.key === "needs-key"
      ? "key"
      : pinnedProviderStatus?.key === "local-stopped" ||
          pinnedProviderStatus?.key === "local-unknown"
        ? "local"
        : null;
  const showPinnedNotice =
    pinnedNoticeKind !== null &&
    pinnedProviderId !== null &&
    dismissedPinnedProvider !== pinnedProviderId;

  // Private toggle: turning ON opens a fresh empty private chat (and remembers
  // where you were); turning OFF restores that previous chat exactly as it was.
  const togglePrivate = useCallback(() => {
    if (!incognito) {
      prevThreadIdRef.current = activeThreadId;
      newChat(true);
    } else {
      const prev = prevThreadIdRef.current;
      const exists =
        prev != null &&
        useAppStore.getState().threads.some((t) => t.id === prev);
      if (exists) {
        switchThread(prev!);
      } else {
        newChat(false);
      }
      prevThreadIdRef.current = null;
    }
  }, [incognito, activeThreadId, newChat, switchThread]);

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
    <div className="chat-layout">
    <div className="screen chat-screen">
      {mounted && incognito ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            padding: "8px 16px",
            background: "var(--c-accent-light)",
            borderBottom: "0.5px solid var(--c-border)",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--c-accent)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Private · this chat won&apos;t be saved
          </span>
        </div>
      ) : localMode && gatewayConnected ? (
        <div className="chat-local-banner">
          <span className="chat-local-banner-dot" aria-hidden />
          <span>Local mode — chats stay on this device.</span>
          <a href="/login">Sign in for account &amp; billing →</a>
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
      <div className="chat-header">
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
          {/* Hamburger toggles the sidebar (collapse to rail / expand). */}
          <button
            type="button"
            className="chat-header-icon"
            onClick={toggleSidebar}
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
          </button>
          {mounted && incognito ? (
            <span className="chat-privacy-chip" title="Incognito — nothing saved">
              🕶 Incognito
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
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* MCP indicator (contextual): only when servers with tools are on. */}
          {mcpToolCount > 0 ? (
            <a
              href="/settings/mcp"
              className="chat-tool-toggle"
              title="MCP tools available to the model this chat — manage in settings"
              style={{ textDecoration: "none", color: "var(--color-purple-light)" }}
            >
              🔧 {mcpToolCount} tool{mcpToolCount === 1 ? "" : "s"} active
            </a>
          ) : null}
          {/* Artifacts toggle (contextual): only when artifacts exist. */}
          {artifactList.length > 0 ? (
            <button
              type="button"
              className={`chat-tool-toggle${artifactPanelOpen ? " active" : ""}`}
              onClick={() => {
                if (artifactPanelOpen) setArtifactPanelOpen(false);
                else openArtifact(activeArtifactId ?? artifactList[0]!.id);
              }}
              aria-pressed={artifactPanelOpen}
              aria-label="Toggle the artifacts panel"
              title="Substantial code, HTML, SVG, and long docs from this chat"
            >
              <Icon name="layers" size={13} />
              Artifacts ({artifactList.length})
            </button>
          ) : null}

          {/* Search ⌘K — opens the global command palette. */}
          <button
            type="button"
            className="chat-header-search"
            onClick={() =>
              document.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
              )
            }
            title="Search (⌘K)"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <span>Search</span>
            <kbd>⌘K</kbd>
          </button>

          {/* Share — export this chat as Markdown. */}
          <button
            type="button"
            className="chat-header-icon"
            onClick={exportThread}
            disabled={messages.length === 0}
            aria-label="Export this chat as Markdown"
            title="Export this chat as Markdown"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" /></svg>
          </button>

          {/* Colour mode — Light ↔ Indigo toggle (the site's one dark mode). */}
          <ThemeToggle />

          {/* Private / incognito — starts a fresh chat in the toggled privacy mode. */}
          <button
            type="button"
            className={`chat-header-icon${mounted && incognito ? " active" : ""}`}
            onClick={togglePrivate}
            aria-pressed={incognito}
            aria-label="Private mode"
            title={
              incognito
                ? "Private mode on — this chat isn't saved. Click to start a normal chat."
                : "Start a private chat that won't be saved"
            }
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
          </button>
        </div>
      </div>

      <div className="chat-messages" ref={messagesRef} onScroll={handleMessagesScroll}>
        <div className="chat-thread">
        {messages.length > 0 ? (
          <div className="chat-thread-head">
            <h1>{activeThreadTitle}</h1>
            <div className="chat-thread-meta">
              <span>{messages.length} message{messages.length === 1 ? "" : "s"}</span>
              {routedVia ? (
                <>
                  <span aria-hidden>·</span>
                  <span>routed via {capitalize(routedVia)}</span>
                </>
              ) : null}
              {savedThisChat > 0 ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="chat-thread-saved">
                    saved ~${savedThisChat.toFixed(2)} this chat
                  </span>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-mark">
              <Icon name="zap" size={22} />
            </div>
            <h2>Ask anything</h2>
            <p>Routed automatically across your free providers.</p>
            <div className="chat-empty-chips">
              {PROMPT_CARDS.slice(0, 3).map((card) => (
                <button
                  key={card.title}
                  type="button"
                  className="chat-empty-chip"
                  title={card.body}
                  onClick={() => {
                    setInput(card.title);
                    inputRef.current?.focus();
                  }}
                >
                  {card.title}
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
              mcpToolEvents={message.mcpToolEvents}
              isStreaming={loading && message.id === lastAssistantId}
              artifacts={artifactsByMessage[message.id]}
              onOpenArtifact={openArtifact}
              onRegenerate={
                message.id === lastAssistantId && !loading
                  ? regenerate
                  : undefined
              }
              regenerateProviders={regenerateProviders}
            />
          ))
        )}
        <div ref={bottomRef} />
        </div>
      </div>

      {/* Floating "Jump to latest" pill (10.3b) — appears when scrolled away. */}
      {showJump ? (
        <button
          type="button"
          className="chat-jump"
          onClick={jumpToBottom}
          aria-label="Jump to latest"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
          Jump to latest
        </button>
      ) : null}

      <div className="chat-composer-wrap">
        {showPinnedNotice && pinnedProviderId && pinnedModel ? (
          <div
            className={`pinned-provider-notice${pinnedNoticeKind === "key" ? " is-key" : ""}`}
            role="status"
          >
            <span className="ppn-dot" aria-hidden="true" />
            <span className="ppn-text">
              {pinnedNoticeKind === "key" ? (
                <>
                  ⚠ {PROVIDER_BY_ID[pinnedProviderId]?.name ?? pinnedProviderId} needs a key to
                  route {pinnedModel.id} —{" "}
                </>
              ) : (
                <>
                  Runs on your machine — make sure{" "}
                  {PROVIDER_BY_ID[pinnedProviderId]?.name ?? pinnedProviderId} is serving.{" "}
                </>
              )}
            </span>
            {pinnedNoticeKind === "key" ? (
              <>
                <Link href={`/providers?provider=${pinnedProviderId}`} className="ppn-action">
                  Add key →
                </Link>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  className="ppn-action"
                  onClick={() => unpinModel(setSelectedProvider)}
                >
                  use Auto instead
                </button>
              </>
            ) : (
              <Link href={`/providers?provider=${pinnedProviderId}`} className="ppn-action">
                Setup →
              </Link>
            )}
            <button
              type="button"
              className="ppn-dismiss"
              onClick={() => setDismissedPinnedProvider(pinnedProviderId)}
              aria-label="Dismiss"
            >
              <Icon name="x" size={10} />
            </button>
          </div>
        ) : null}
        <div
          className="chat-composer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void handleFiles(e.dataTransfer.files);
          }}
        >
          {/* Composer: notice + attachments, then an auto-grow textarea, then a
              single action row inside the card — left = attach (+) and the folded
              "More" tools control; right = mic + send. */}
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
                      {att.pages !== undefined ? (
                        <span className="chat-attachment-meta">
                          📄 extracted {att.pages} page{att.pages === 1 ? "" : "s"}
                          {att.truncated ? " (truncated)" : ""}
                        </span>
                      ) : null}
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
          <input
            type="file"
            ref={fileInputRef}
            accept="image/jpeg,image/png,image/webp,application/pdf,.pdf,.txt,.md,.ts,.js,.tsx,.jsx,.py,.json,.sh,.yaml,.toml,.rs,.go,.css"
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
            placeholder={
              mounted && researchMode
                ? `Research mode (${researchDepth}) — ⏎ runs Deep Research on this prompt`
                : "Message Zintus…"
            }
          />
          {/* Single action row inside the card. */}
          <div className="chat-composer-actions">
            <div className="chat-composer-actions-left">
              {/* Composer "+" (Add) menu — design parity. Files, screenshot, and
                  project are real; GitHub + Skills are honestly disabled until
                  those integrations exist (no dead buttons). */}
              <div className="composer-picker" ref={addMenuRef}>
                <Tooltip content="Add files, a screenshot, or attach to a project">
                  <button
                    type="button"
                    className={`chat-attach${addMenuOpen ? " active" : ""}`}
                    aria-haspopup="menu"
                    aria-expanded={addMenuOpen}
                    aria-label="Add files, screenshot, or project"
                    onClick={() => {
                      setAddMenuOpen((v) => {
                        const next = !v;
                        if (next) setProjectList(listProjects());
                        return next;
                      });
                      setAddProjectSubOpen(false);
                    }}
                  >
                    <Icon name="plus" size={18} />
                  </button>
                </Tooltip>
                {addMenuOpen ? (
                  <div
                    className="composer-picker-menu"
                    role="menu"
                    style={{ minWidth: 230, left: 0, right: "auto" }}
                  >
                    <button
                      type="button"
                      className="composer-picker-option"
                      onClick={() => {
                        setAddMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                    >
                      <Icon name="paperclip" size={14} />
                      <span>Add files or photos</span>
                    </button>

                    <button
                      type="button"
                      className="composer-picker-option"
                      disabled={!canScreenshot}
                      onClick={() => void handleScreenshot()}
                      title={
                        canScreenshot
                          ? "Capture a screen, window, or tab and attach it (EXIF stripped)"
                          : "Screen capture needs a Chromium or Firefox desktop browser"
                      }
                    >
                      <Icon name="image" size={14} />
                      <span>Take a screenshot</span>
                      {!canScreenshot ? (
                        <span className="composer-picker-hint">Unsupported</span>
                      ) : null}
                    </button>

                    <button
                      type="button"
                      className={`composer-picker-option${addProjectSubOpen ? " active" : ""}`}
                      aria-expanded={addProjectSubOpen}
                      onClick={() => setAddProjectSubOpen((v) => !v)}
                    >
                      <Icon name="layers" size={14} />
                      <span>Add to project</span>
                      <Icon name="chevron-down" size={11} />
                    </button>
                    {addProjectSubOpen ? (
                      <div className="composer-project-sub">
                        {projectList.length === 0 ? (
                          <p className="composer-picker-empty">No projects yet.</p>
                        ) : (
                          projectList.map((project) => (
                            <button
                              key={project.id}
                              type="button"
                              className={`composer-picker-option${activeProjectName === project.name ? " active" : ""}`}
                              onClick={() => attachToProject(project)}
                            >
                              <span aria-hidden>📁</span>
                              <span>{project.name}</span>
                            </button>
                          ))
                        )}
                        <button
                          type="button"
                          className="composer-picker-option"
                          onClick={() => {
                            const name = window.prompt("New project name");
                            if (!name?.trim()) return;
                            const project = createProject({ name: name.trim() });
                            setProjectList(listProjects());
                            attachToProject(project);
                          }}
                        >
                          <Icon name="plus" size={14} />
                          <span>New project…</span>
                        </button>
                      </div>
                    ) : null}

                    <button
                      type="button"
                      className="composer-picker-option"
                      disabled
                      title="GitHub import isn't connected yet — coming soon."
                    >
                      <Icon name="grid" size={14} />
                      <span>Add from GitHub</span>
                      <span className="composer-picker-hint">Soon</span>
                    </button>

                    <button
                      type="button"
                      className="composer-picker-option"
                      disabled
                      title="Skills aren't available yet — coming soon."
                    >
                      <Icon name="zap" size={14} />
                      <span>Skills</span>
                      <span className="composer-picker-hint">Soon</span>
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Folded "More" tools control (search, tools, presets, project). */}
              <div className="composer-picker" ref={moreRef}>
                <button
                  type="button"
                  className={`chat-tool-toggle${
                    mounted &&
                    (webSearchEnabled ||
                      toolsEnabled ||
                      researchMode ||
                      jsonMode !== "off" ||
                      activePreset ||
                      activeProjectName ||
                      settings.blockTrainingProviders)
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
                  <span className="chat-more-label">More</span>
                </button>

                {moreOpen ? (
                  <div
                    className="composer-picker-menu"
                    role="menu"
                    style={{ minWidth: 252, padding: 8, left: 0, right: "auto" }}
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
                        className={`chat-tool-toggle${artifactMode ? " active" : ""}`}
                        aria-pressed={artifactMode}
                        aria-label="Toggle canvas / artifact mode"
                        onClick={() => {
                          setArtifactMode((v) => {
                            const next = !v;
                            if (typeof localStorage !== "undefined") {
                              localStorage.setItem("zintus:artifact-mode", String(next));
                            }
                            return next;
                          });
                        }}
                        title="Canvas: the model marks substantial deliverables as editable artifacts, and your current version is fed back on the next turn so edits build on what you're looking at. Off by default."
                      >
                        <Icon name="layers" size={13} />
                        Canvas
                      </button>
                      <button
                        type="button"
                        className={`chat-tool-toggle${researchMode ? " active" : ""}`}
                        aria-pressed={researchMode}
                        aria-label="Toggle research mode"
                        onClick={() => {
                          setResearchMode((v) => {
                            const next = !v;
                            if (typeof localStorage !== "undefined") {
                              localStorage.setItem("zintus:research-mode", String(next));
                            }
                            return next;
                          });
                        }}
                        title="Research: send this prompt to Deep Research — it searches multiple sources, synthesizes, and cites. Runs on the Research page at the depth below."
                      >
                        <Icon name="globe" size={13} />
                        Research
                      </button>
                    </div>

                    {/* Depth selector — only meaningful when research mode is on. */}
                    {researchMode ? (
                      <div style={{ padding: "0 4px 6px" }}>
                        <div
                          role="radiogroup"
                          aria-label="Research depth"
                          style={{ display: "flex", gap: 6 }}
                        >
                          {(
                            [
                              { value: "quick", label: "Quick", hint: "1 search · ~10s" },
                              { value: "standard", label: "Standard", hint: "3 searches · ~30s" },
                              { value: "deep", label: "Deep", hint: "5 searches · ~60s" },
                            ] as Array<{ value: ResearchDepth; label: string; hint: string }>
                          ).map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              role="radio"
                              aria-checked={researchDepth === option.value}
                              className={`chat-tool-toggle${researchDepth === option.value ? " active" : ""}`}
                              onClick={() => {
                                setResearchDepth(option.value);
                                if (typeof localStorage !== "undefined") {
                                  localStorage.setItem("zintus:research-depth", option.value);
                                }
                              }}
                              title={option.hint}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <StructuredOutputControl
                      mode={jsonMode}
                      schemaText={jsonSchemaText}
                      error={schemaError}
                      onModeChange={setJsonMode}
                      onSchemaTextChange={setJsonSchemaText}
                    />

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

              {/* Model picker moved into the composer action row (10.1). */}
              <ProviderPicker />
            </div>

            <div className="chat-composer-actions-right">
              {/* Voice input (dictation). Honest about support: the Web Speech
                  API is Chromium-only in practice, so when unsupported we show a
                  disabled mic with a plain-spoken tooltip rather than hide it. The
                  active tooltip is honest about where the audio goes. */}
              {speech.supported ? (
                <Tooltip
                  content={
                    speech.listening
                      ? "Stop dictation"
                      : "Dictate — uses your browser's speech service (Chrome sends audio to Google); no audio reaches Zintus"
                  }
                >
                  <button
                    type="button"
                    className={`chat-mic${speech.listening ? " is-listening" : ""}`}
                    onClick={toggleDictation}
                    aria-label={speech.listening ? "Stop dictation" : "Start dictation"}
                    aria-pressed={speech.listening}
                  >
                    <Icon name="mic" size={18} />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip content="Voice input needs a Chromium-based browser (Chrome or Edge)">
                  <button
                    type="button"
                    className="chat-mic"
                    disabled
                    aria-label="Voice input not available in this browser"
                  >
                    <Icon name="mic" size={18} />
                  </button>
                </Tooltip>
              )}
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
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
          {speech.listening ? (
            <div className="chat-mic-status" role="status" aria-live="polite">
              <span className="chat-mic-dot" aria-hidden />
              <span>
                Listening{speech.transcript ? `: ${speech.transcript}` : "… speak now"}
              </span>
            </div>
          ) : null}
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
    {artifactPanelOpen && artifactList.length > 0 ? (
      <ArtifactPanel
        artifacts={artifactList}
        activeId={activeArtifactId}
        userVersions={threadArtifactEdits}
        onSaveVersion={(artifactId, version) =>
          addArtifactEdit(activeThreadId, artifactId, version)
        }
        onRebake={handleRebake}
        onSelect={setActiveArtifactId}
        onClose={() => setArtifactPanelOpen(false)}
      />
    ) : null}
    </div>
  );
}
