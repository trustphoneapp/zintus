import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ListRenderItem } from "react-native";
import {
  PROVIDER_IDS,
  textOf,
  type ImageContentBlock,
  type ProviderId,
  type ResponseFormat,
} from "@zintus/types";
import { PROVIDER_METADATA } from "@zintus/providers";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { ChatMessageBubble } from "@/components/ChatMessageBubble";
import {
  buildImageMessageContent,
  formatImageBytes,
  imageSlotsRemaining,
  providerCanSeeImages,
} from "@/lib/image-attachments";
import {
  captureImageFromCamera,
  pickImagesFromLibrary,
} from "@/lib/image-picker";
import { startDictation, type SpeechSession } from "@/lib/speech";
import { ArtifactsModal } from "@/components/ArtifactsModal";
import { streamChat, type ChatMcpConfig } from "@/lib/chat";
import { getGatewayUrl } from "@/lib/gateway-url";
import { fetchGatewayHealth } from "@/lib/gateway";
import {
  loadConfig,
  loadJsonMode,
  loadMcpServers,
  loadSelectedProvider,
  loadToolsMode,
  saveConfig,
  saveJsonMode,
  saveSelectedProvider,
  saveToolsMode,
} from "@/lib/config";
import { activeMcpServersForChat } from "@/lib/mcp-config";
import {
  BUILTIN_TOOL_DEFINITIONS,
  MAX_TOOL_ROUNDS,
  executeBuiltinToolCall,
} from "@/lib/builtin-tools";
import {
  extractArtifacts,
  foldArtifactVersions,
  type Artifact,
  type VersionedArtifact,
} from "@/lib/artifacts";
import { getProject } from "@/lib/projects";
import { CHAT_MODES, deriveRouting, nextMode, type ChatMode } from "@/lib/chat-mode";
import { grantProviderSendConsent, hasProviderSendConsent } from "@/lib/consent";
import { DESTINATIONS, attachmentPrivacyNotice, describeFlow } from "@/lib/data-flow";
import {
  composeMessage,
  pickTextFile,
  type Attachment,
} from "@/lib/attachments";
import {
  fetchRouteOptions,
  type RouteOption,
  type RouteOptions,
} from "@/lib/route-options";
import {
  appendMessage,
  createThread,
  getMessages,
  setThreadGatewayId,
} from "@/lib/history";
import {
  createAssistantPlaceholder,
  createUserMessage,
  toChatMessages,
  type ToolCallView,
  type ToolResultView,
  type UiMessage,
} from "@/lib/messages";
import { migrateLegacyKeys } from "@/lib/secure-keys";
import { takePendingPrompt } from "@/lib/onboarding";
import { COLORS } from "@/lib/theme";

type ProviderSelection = ProviderId | "auto";

const STREAM_FLUSH_MS = 50;

/**
 * Build the chat body's `mcp` block from the user's enabled MCP servers, plus the
 * active tool count for the header indicator. The gateway runs these tools
 * SERVER-SIDE; the phone only displays the activity. Returns `undefined` when
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

/**
 * Fold the whole conversation's assistant turns into versioned artifacts: each
 * message is extracted (ids namespaced per message), concatenated in order, then
 * `foldArtifactVersions` merges same-identity blocks into one entry with a
 * version history. This powers the cross-message "vN of M" switcher — the same
 * iterative-artifacts model web/desktop use.
 */
function conversationArtifacts(messages: UiMessage[]): VersionedArtifact[] {
  const flat: Artifact[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || message.streaming || !message.content) {
      continue;
    }
    for (const artifact of extractArtifacts(textOf(message.content))) {
      flat.push({ ...artifact, id: `${message.id}:${artifact.id}` });
    }
  }
  return foldArtifactVersions(flat);
}

export default function ChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ thread?: string; project?: string }>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [provider, setProvider] = useState<ProviderSelection>("auto");
  const [mode, setMode] = useState<ChatMode>("auto");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gatewayOnline, setGatewayOnline] = useState(true);
  const [gatewayChecked, setGatewayChecked] = useState(false);
  const [consentVisible, setConsentVisible] = useState(false);
  const [overrideVisible, setOverrideVisible] = useState(false);
  const [privateMode, setPrivateMode] = useState(
    () => loadConfig().blockTrainingProviders ?? false,
  );
  const [privateExplainVisible, setPrivateExplainVisible] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [images, setImages] = useState<ImageContentBlock[]>([]);
  const [listening, setListening] = useState(false);
  const speechRef = useRef<SpeechSession | null>(null);
  const [routeOptions, setRouteOptions] = useState<
    Record<string, RouteOptions | null>
  >({});
  const [jsonMode, setJsonMode] = useState(false);
  const [toolsMode, setToolsMode] = useState(false);
  // Count of MCP tools active across enabled servers — drives the header
  // indicator. Refreshed on focus (the MCP screen may have changed it).
  const [mcpToolCount, setMcpToolCount] = useState(0);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [openArtifacts, setOpenArtifacts] = useState<VersionedArtifact[]>([]);

  const threadIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<UiMessage>>(null);
  const pendingSendRef = useRef<{
    composed: string;
    atts: Attachment[];
    imgs: ImageContentBlock[];
    oneShot?: ProviderId;
  } | null>(null);

  const activeProject = useMemo(
    () =>
      typeof params.project === "string" && params.project
        ? getProject(params.project)
        : null,
    [params.project],
  );

  useEffect(() => {
    void migrateLegacyKeys();
    setJsonMode(loadJsonMode());
    setToolsMode(loadToolsMode());
    const pending = takePendingPrompt();
    if (pending) setInput(pending);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setProvider(loadSelectedProvider());
      setMcpToolCount(activeMcpForChat().toolCount);
    }, []),
  );

  // Continue a thread opened from History (?thread=<id>): hydrate its messages.
  useFocusEffect(
    useCallback(() => {
      const id = typeof params.thread === "string" ? params.thread : undefined;
      if (!id || id === threadIdRef.current) return;
      void (async () => {
        const stored = await getMessages(id);
        threadIdRef.current = id;
        setMessages(
          stored.map((m) => ({
            id: m.id,
            storedId: m.id,
            role: m.role,
            content: m.content,
            providerId: m.providerId ?? undefined,
            model: m.model ?? undefined,
            meta: m.meta ?? undefined,
          })),
        );
      })();
    }, [params.thread]),
  );

  // Apply a project's routing defaults when chatting inside it.
  useFocusEffect(
    useCallback(() => {
      if (!activeProject) return;
      if (activeProject.defaultProvider) {
        setProvider(activeProject.defaultProvider);
        saveSelectedProvider(activeProject.defaultProvider);
      }
      if (activeProject.privateDefault) {
        setPrivateMode(true);
        saveConfig({ blockTrainingProviders: true });
      }
    }, [activeProject]),
  );

  function newChat() {
    abortRef.current?.abort();
    threadIdRef.current = null;
    setMessages([]);
    setInput("");
    setAttachments([]);
    setImages([]);
    setError(null);
    router.setParams({ thread: "" });
  }

  function togglePrivate() {
    const next = !privateMode;
    setPrivateMode(next);
    saveConfig({ blockTrainingProviders: next });
    if (next) setPrivateExplainVisible(true);
  }

  // Gateway health: polled ONLY while the Chat tab is focused AND the app is
  // foregrounded, with 5→30s backoff while status is unchanged and the in-flight
  // probe aborted on teardown. Replaces the old always-on 5s setInterval that
  // woke the radio ~720x/hour even when blurred (battery + store-compliance).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let controller: AbortController | null = null;
      let delay = 5000;
      const onlineRef = { current: null as boolean | null };

      const tick = async () => {
        controller?.abort();
        controller = new AbortController();
        const health = await fetchGatewayHealth(controller.signal);
        if (cancelled) return;
        const online = Boolean(health?.ok);
        delay =
          onlineRef.current === online ? Math.min(delay * 1.5, 30000) : 5000;
        onlineRef.current = online;
        setGatewayOnline(online);
        setGatewayChecked(true);
        timer = setTimeout(() => void tick(), delay);
      };

      void tick();

      const sub = AppState.addEventListener("change", (state) => {
        if (state === "active") {
          if (!timer && !cancelled) {
            delay = 5000;
            void tick();
          }
        } else {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          controller?.abort();
        }
      });

      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
        controller?.abort();
        sub.remove();
      };
    }, []),
  );

  const setAssistant = useCallback(
    (id: string, patch: Partial<UiMessage>) => {
      setMessages((current) =>
        current.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      );
    },
    [],
  );

  const loadRouteOptions = useCallback(async (providerId: ProviderId) => {
    const options = await fetchRouteOptions(providerId);
    setRouteOptions((prev) => ({ ...prev, [providerId]: options }));
  }, []);

  const runTurn = useCallback(
    async (
      text: string,
      oneShotProvider?: ProviderId,
      atts: Attachment[] = [],
      imgs: ImageContentBlock[] = [],
    ) => {
      const config = loadConfig();
      const routing = deriveRouting(mode, config.routingStrategy);
      const effectiveProvider =
        oneShotProvider ?? (provider === "auto" ? undefined : provider);

      // Ensure a local thread exists so the conversation persists.
      if (!threadIdRef.current) {
        const thread = await createThread({
          title: text.slice(0, 48) || (imgs.length ? "Image" : "Chat"),
          projectId: activeProject?.id ?? null,
          defaultProvider: effectiveProvider ?? null,
          strategy: routing.strategy ?? null,
          privacyPosture: routing.posture,
        });
        threadIdRef.current = thread.id;
      }
      const threadId = threadIdRef.current;

      // A turn with images rides as a real multimodal ContentBlock[] (text +
      // EXIF-stripped image blocks) — never an "[Image: name]" fake.
      const userMessage = createUserMessage(
        imgs.length ? buildImageMessageContent(text, imgs) : text,
      );
      const placeholder = createAssistantPlaceholder();
      setMessages((current) => [...current, userMessage, placeholder]);
      setInput("");
      setSending(true);
      setError(null);

      // History stores the TEXT + attachment/image METADATA only — never the
      // image base64 bytes (keeps the on-device SQLite small; the bytes were a
      // one-shot input to the model).
      void appendMessage({
        threadId,
        role: "user",
        content: text,
        attachments:
          atts.length || imgs.length
            ? [
                ...atts.map((a) => ({
                  kind: "file" as const,
                  name: a.name,
                  mimeType: a.mimeType,
                  bytes: a.bytes,
                })),
                ...imgs.map((im, i) => ({
                  kind: "file" as const,
                  name: im.name ?? `image-${i + 1}.jpg`,
                  mimeType: im.mimeType,
                  bytes: im.bytes,
                })),
              ]
            : null,
      });

      const controller = new AbortController();
      abortRef.current = controller;

      // When JSON mode is on, ask the gateway for json_object structured output;
      // it resolves the best level the routed provider can actually serve.
      const responseFormat: ResponseFormat | undefined = jsonMode
        ? { type: "json_object" }
        : undefined;

      // Built-in tool definitions are sent only when the Tools toggle is on; the
      // chat then runs the bounded execute→feed-back loop locally (the SAME loop
      // web/desktop/CLI run — "one Zintus" tools-everywhere parity).
      const tools = toolsMode ? BUILTIN_TOOL_DEFINITIONS : undefined;

      // Enabled MCP servers for this turn (server-side tool loop). Undefined when
      // none are enabled, so a normal turn carries no `mcp` field at all.
      const { mcp } = activeMcpForChat();

      // The bubble the active turn streams into — the tool loop opens a fresh
      // bubble per round, so a mid-loop error attaches to the right one.
      let currentAssistantId = placeholder.id;

      // Throttle stream→state so we don't re-render the list per token.
      let latest = "";
      let flushScheduled = false;
      const flush = () => {
        flushScheduled = false;
        setAssistant(currentAssistantId, { content: latest });
      };

      try {
        // The conversation we feed the gateway. The tool loop appends the model's
        // assistant tool_call turn and our tool_result turn each round.
        const convo = toChatMessages([...messages, userMessage]);
        if (activeProject?.instructions) {
          convo.unshift({ role: "system", content: activeProject.instructions });
        }

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
          latest = "";
          const result = await streamChat({
            providerId: effectiveProvider,
            strategy: effectiveProvider ? undefined : routing.strategy,
            blockTraining: routing.blockTraining || privateMode,
            mode: config.contextMode,
            threadId: threadIdRef.current ?? undefined,
            responseFormat,
            tools,
            mcp,
            messages: convo,
            signal: controller.signal,
            onChunk: (t) => {
              latest = t;
              if (!flushScheduled) {
                flushScheduled = true;
                setTimeout(flush, STREAM_FLUSH_MS);
              }
            },
            // Each server-side MCP call/result lands live on the active bubble —
            // calm transparency without ever executing a tool on the phone.
            onMcpToolEvent: (event) => {
              const id = currentAssistantId;
              setMessages((current) =>
                current.map((m) =>
                  m.id === id
                    ? { ...m, mcpEvents: [...(m.mcpEvents ?? []), event] }
                    : m,
                ),
              );
            },
          });

          const calls = result.toolCalls ?? [];

          // No tool calls -> this is the final answer; settle the bubble,
          // persist it, and stop.
          if (calls.length === 0) {
            setAssistant(currentAssistantId, {
              streaming: false,
              providerId: result.providerId,
              model: result.model,
              meta: result.meta,
              content:
                latest ||
                `[${result.providerId}/${result.model}] (empty response)`,
            });

            if (result.threadId && threadId) {
              void setThreadGatewayId(threadId, result.threadId);
            }
            void appendMessage({
              threadId,
              role: "assistant",
              content: latest,
              providerId: result.providerId,
              model: result.model,
              meta: result.meta,
            });
            void loadRouteOptions(result.providerId);
            break;
          }

          // Execute each built-in tool locally; an unknown tool / failure comes
          // back as an honest isError result the model can recover from.
          const toolViews: ToolCallView[] = calls.map((c) => ({
            id: c.id,
            name: c.name,
            arguments: c.arguments,
          }));
          const results = calls.map((c) =>
            executeBuiltinToolCall({
              id: c.id,
              name: c.name,
              arguments: c.arguments,
            }),
          );
          const resultViews: ToolResultView[] = results.map((r) => {
            const call = calls.find((c) => c.id === r.toolCallId);
            return {
              toolCallId: r.toolCallId,
              name: call?.name ?? "tool",
              content: r.content,
              isError: r.isError,
            };
          });

          const hitCap = round === MAX_TOOL_ROUNDS;
          setAssistant(currentAssistantId, {
            streaming: false,
            providerId: result.providerId,
            model: result.model,
            meta: result.meta,
            toolCalls: toolViews,
            toolResults: resultViews,
            ...(hitCap && !latest
              ? { content: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds.` }
              : {}),
          });

          // Persist the intermediate turn when it streamed visible text.
          if (latest.trim()) {
            void appendMessage({
              threadId,
              role: "assistant",
              content: latest,
              providerId: result.providerId,
              model: result.model,
              meta: result.meta,
            });
          }

          // Bounded: a model still calling tools at the cap is surfaced, not looped.
          if (hitCap) break;

          // Feed the assistant tool_call turn + our tool_result turn back, then
          // open a fresh bubble for the next round's answer.
          convo.push({
            role: "assistant",
            content: [
              ...(latest.trim()
                ? [{ type: "text" as const, text: latest }]
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

          const next = createAssistantPlaceholder();
          const nextId = `${next.id}-${round}`;
          currentAssistantId = nextId;
          setMessages((current) => [...current, { ...next, id: nextId }]);
        }
      } catch (sendError) {
        if (controller.signal.aborted) {
          setAssistant(currentAssistantId, {
            streaming: false,
            content: latest || "(stopped)",
          });
        } else {
          const message =
            sendError instanceof Error ? sendError.message : "Request failed";
          setError(message);
          setAssistant(currentAssistantId, {
            streaming: false,
            error: true,
            content: `Error: ${message}`,
          });
        }
      } finally {
        setSending(false);
        abortRef.current = null;
      }
    },
    [
      messages,
      mode,
      provider,
      privateMode,
      jsonMode,
      toolsMode,
      activeProject,
      setAssistant,
      loadRouteOptions,
    ],
  );

  const send = useCallback(
    (oneShotProvider?: ProviderId) => {
      const text = input.trim();
      if (
        (!text && attachments.length === 0 && images.length === 0) ||
        sending ||
        !gatewayOnline
      ) {
        return;
      }
      // Capability guard: a concrete non-vision provider can't see images. Warn
      // BEFORE burning a request the provider will 422 (auto routing is fine —
      // the router picks a vision provider or the gateway returns a handled 422).
      const targetProvider =
        oneShotProvider ?? (provider === "auto" ? "auto" : provider);
      if (images.length > 0 && !providerCanSeeImages(targetProvider)) {
        Alert.alert(
          "This provider can't see images",
          `${targetProvider} has no vision model. Switch to Auto or a vision-capable provider (e.g. Gemini), or remove the image.`,
        );
        return;
      }
      const composed = composeMessage(text, attachments);
      const atts = attachments;
      const imgs = images;
      const routing = deriveRouting(mode, loadConfig().routingStrategy);
      // Apple 5.1.2(i): consent before sending to a third-party provider.
      if (routing.posture !== "local-only" && !hasProviderSendConsent()) {
        pendingSendRef.current = { composed, atts, imgs, oneShot: oneShotProvider };
        setConsentVisible(true);
        return;
      }
      setAttachments([]);
      setImages([]);
      void runTurn(composed, oneShotProvider, atts, imgs);
    },
    [input, attachments, images, sending, gatewayOnline, mode, provider, runTurn],
  );

  function grantConsentAndSend() {
    grantProviderSendConsent();
    setConsentVisible(false);
    const pending = pendingSendRef.current;
    pendingSendRef.current = null;
    if (pending) {
      setAttachments([]);
      setImages([]);
      void runTurn(pending.composed, pending.oneShot, pending.atts, pending.imgs);
    }
  }

  async function addImage(source: "library" | "camera") {
    const slots = imageSlotsRemaining(images.length);
    if (slots <= 0) {
      Alert.alert("Image limit", "You can attach up to 4 images per message.");
      return;
    }
    const result =
      source === "camera"
        ? await captureImageFromCamera(slots)
        : await pickImagesFromLibrary(slots);
    if (!result.ok) {
      Alert.alert("Couldn't add image", result.reason);
      return;
    }
    if (result.blocks.length > 0) {
      setImages((prev) => [...prev, ...result.blocks].slice(0, 4));
    }
  }

  function promptAddImage() {
    Alert.alert("Add image", "Send a photo to a vision-capable model.", [
      { text: "Photo Library", onPress: () => void addImage("library") },
      { text: "Take Photo", onPress: () => void addImage("camera") },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function addAttachment() {
    const att = await pickTextFile();
    if (!att) return;
    if (att.unsupported) {
      Alert.alert(
        "Can't read this file on-device",
        `${att.name} isn't a text format Zintus can extract here (PDFs aren't supported yet). For photos, use the 🖼 image button. Text files — txt, md, csv, json, code — work here.`,
      );
      return;
    }
    if (att.truncated) {
      Alert.alert(
        "Large file truncated",
        `${att.name} was truncated to fit the prompt budget.`,
      );
    }
    setAttachments((prev) => [...prev, att]);
  }

  function stop() {
    abortRef.current?.abort();
  }

  const copy = useCallback((text: string) => {
    if (text.trim()) void Share.share({ message: text });
  }, []);

  const lastUserText = useMemo(() => {
    const last = [...messages].reverse().find((m) => m.role === "user");
    return last ? textOf(last.content) : "";
  }, [messages]);

  const retry = useCallback(() => {
    if (lastUserText) void runTurn(lastUserText);
  }, [lastUserText, runTurn]);

  const regenerate = useCallback(() => {
    if (!lastUserText) return;
    const lastProvider = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.providerId)?.providerId;
    const idx = lastProvider ? PROVIDER_IDS.indexOf(lastProvider) : -1;
    const next = PROVIDER_IDS[(idx + 1) % PROVIDER_IDS.length];
    void runTurn(lastUserText, next);
  }, [lastUserText, messages, runTurn]);

  const report = useCallback(() => {
    // Play Gen-AI policy / Apple 1.2: in-app way to flag offensive AI content.
    Alert.alert(
      "Report this response",
      "Flag this AI-generated response as offensive, unsafe, or inaccurate? This stays on your device and helps you track problem providers.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Report",
          style: "destructive",
          onPress: () =>
            Alert.alert("Reported", "Thanks — response flagged on this device."),
        },
      ],
    );
  }, []);

  // Voice dictation: uses on-device speech recognition WHEN the native module
  // is present (dev/preview build), else shows the honest fallback. It only
  // fills the composer — Zintus NEVER auto-sends a transcript.
  const toggleDictation = useCallback(async () => {
    if (listening) {
      speechRef.current?.stop();
      speechRef.current = null;
      setListening(false);
      return;
    }
    const session = await startDictation({
      onTranscript: (t) => setInput(t),
      onError: (msg) => {
        setListening(false);
        speechRef.current = null;
        Alert.alert("Dictation error", msg);
      },
      onEnd: () => {
        setListening(false);
        speechRef.current = null;
      },
    });
    if ("unavailable" in session) {
      Alert.alert("Voice dictation", session.unavailable);
      return;
    }
    speechRef.current = session;
    setListening(true);
  }, [listening]);

  const openArtifactsViewer = useCallback(() => {
    setOpenArtifacts(conversationArtifacts(messages));
    setArtifactsOpen(true);
  }, [messages]);

  const renderItem = useCallback<ListRenderItem<UiMessage>>(
    ({ item }) => {
      // Count of artifact-worthy blocks in THIS turn — drives the "Artifacts (N)"
      // action. The viewer itself shows the whole conversation's folded history.
      const artifactCount =
        item.role === "assistant" && !item.streaming && item.content
          ? extractArtifacts(textOf(item.content)).length
          : 0;
      return (
        <ChatMessageBubble
          message={item}
          routeOptions={item.providerId ? routeOptions[item.providerId] : null}
          artifactCount={artifactCount}
          onCopy={copy}
          onCopyCode={copy}
          onRetry={!sending ? retry : undefined}
          onRegenerate={!sending ? regenerate : undefined}
          onReport={report}
          onRouteAction={handleRouteAction}
          onOpenArtifacts={openArtifactsViewer}
        />
      );
    },
    [routeOptions, copy, retry, regenerate, report, sending, openArtifactsViewer],
  );

  function handleRouteAction(action: RouteOption) {
    switch (action) {
      case "switch_provider":
      case "use_local":
        router.push("/providers");
        break;
      case "compress_harder":
        Alert.alert(
          "Compress harder",
          "Tokzen already compresses every turn. Shorter prompts and fewer attachments stretch your free-tier budget further.",
        );
        break;
      case "wait":
        Alert.alert("Wait for reset", "No healthy alternative right now — your quota will recover at the provider's reset time.");
        break;
    }
  }

  const keyExtractor = useCallback((item: UiMessage) => item.id, []);
  const modeDef = CHAT_MODES.find((m) => m.mode === mode)!;
  const canSend =
    (Boolean(input.trim()) || attachments.length > 0 || images.length > 0) &&
    !sending &&
    gatewayOnline;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>Zintus</Text>
          <Pressable hitSlop={6} onPress={newChat}>
            <Text style={styles.headerLink}>＋ New</Text>
          </Pressable>
          <Pressable hitSlop={6} onPress={() => router.push("/history")}>
            <Text style={styles.headerLink}>History</Text>
          </Pressable>
          <Pressable hitSlop={6} onPress={() => router.push("/projects")}>
            <Text style={styles.headerLink}>Projects</Text>
          </Pressable>
          <Pressable hitSlop={6} onPress={() => router.push("/agent")}>
            <Text style={styles.headerLink}>Agent</Text>
          </Pressable>
          <Pressable hitSlop={6} onPress={togglePrivate}>
            <Text style={[styles.headerLink, privateMode && styles.shieldOn]}>
              {privateMode ? "🛡 Private" : "🛡"}
            </Text>
          </Pressable>
        </View>
        <View style={styles.chipRow}>
          <Pressable
            style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
            onPress={() => setMode((m) => nextMode(m))}
          >
            <Text style={styles.chipText}>{modeDef.label}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.chip,
              jsonMode && styles.chipActive,
              pressed && styles.pressed,
            ]}
            accessibilityRole="switch"
            accessibilityState={{ checked: jsonMode }}
            onPress={() => {
              setJsonMode((current) => {
                const next = !current;
                saveJsonMode(next);
                return next;
              });
            }}
          >
            <Text style={[styles.chipText, jsonMode && styles.chipTextActive]}>
              {"{}"}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.chip,
              toolsMode && styles.chipActive,
              pressed && styles.pressed,
            ]}
            accessibilityRole="switch"
            accessibilityState={{ checked: toolsMode }}
            onPress={() => {
              setToolsMode((current) => {
                const next = !current;
                saveToolsMode(next);
                return next;
              });
            }}
          >
            <Text style={[styles.chipText, toolsMode && styles.chipTextActive]}>
              🔧
            </Text>
          </Pressable>
          {mcpToolCount > 0 ? (
            <Pressable
              style={({ pressed }) => [
                styles.chip,
                styles.chipActive,
                pressed && styles.pressed,
              ]}
              onPress={() => router.push("/mcp")}
            >
              <Text style={[styles.chipText, styles.chipTextActive]}>
                {`MCP ${mcpToolCount}`}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            style={({ pressed }) => [
              styles.chip,
              provider === "auto" && styles.chipActive,
              pressed && styles.pressed,
            ]}
            onPress={() => router.push("/providers")}
          >
            <Text
              style={[
                styles.chipText,
                provider === "auto" && styles.chipTextActive,
              ]}
            >
              {provider === "auto" ? "Auto" : provider}
            </Text>
          </Pressable>
        </View>
      </View>

      {gatewayChecked && !gatewayOnline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>
            Gateway offline — run `zintus serve` on your computer
          </Text>
          <Text style={styles.offlineSub}>
            Expecting it at {getGatewayUrl()} · set the gateway URL in Settings
            (your computer&apos;s LAN IP, not localhost)
          </Text>
        </View>
      )}

      {activeProject ? (
        <Text style={styles.projectBadge}>📁 {activeProject.name}</Text>
      ) : null}
      <Text style={styles.gatewayHint}>
        Gateway: {getGatewayUrl()} · {modeDef.hint}
      </Text>
      {error && <Text style={styles.errorText}>{error}</Text>}

      <FlatList
        ref={listRef}
        style={styles.list}
        data={messages}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={
          messages.length === 0 ? styles.emptyContainer : styles.listContent
        }
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        windowSize={10}
        maxToRenderPerBatch={8}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Ask anything</Text>
            <Text style={styles.emptySubtitle}>
              {provider === "auto"
                ? "Auto mode routes your message to the best available free provider — through your gateway, using your own keys."
                : `Messages route through ${provider}. Tap the chip to change.`}
            </Text>
          </View>
        }
      />

      <ArtifactsModal
        visible={artifactsOpen}
        artifacts={openArtifacts}
        onClose={() => setArtifactsOpen(false)}
      />

      <View style={styles.composer}>
        {attachments.length > 0 ? (
          <View style={styles.attachWrap}>
            <View style={styles.attachChips}>
              {attachments.map((a) => (
                <View key={a.id} style={styles.attachChip}>
                  <Text style={styles.attachName} numberOfLines={1}>
                    📄 {a.name}
                    {a.truncated ? " (truncated)" : ""}
                  </Text>
                  <Pressable
                    hitSlop={6}
                    onPress={() =>
                      setAttachments((prev) => prev.filter((x) => x.id !== a.id))
                    }
                  >
                    <Text style={styles.attachRemove}>×</Text>
                  </Pressable>
                </View>
              ))}
            </View>
            <Text style={styles.attachNotice}>
              {attachmentPrivacyNotice("standard")[0]}
            </Text>
          </View>
        ) : null}
        {images.length > 0 ? (
          <View style={styles.imageStrip}>
            {images.map((img, i) => (
              <View key={`${i}-${img.bytes}`} style={styles.imageThumbWrap}>
                <Image
                  source={{ uri: `data:${img.mimeType};base64,${img.data}` }}
                  style={styles.imageThumb}
                />
                <Pressable
                  hitSlop={6}
                  onPress={() =>
                    setImages((prev) => prev.filter((_, idx) => idx !== i))
                  }
                  style={styles.imageRemove}
                >
                  <Text style={styles.imageRemoveText}>×</Text>
                </Pressable>
                <Text style={styles.imageSize} numberOfLines={1}>
                  {formatImageBytes(img.bytes)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.composerTopRow}>
          <Pressable
            hitSlop={6}
            onPress={() => void addAttachment()}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          >
            <Text style={styles.iconBtnText}>＋</Text>
          </Pressable>
          <Pressable
            hitSlop={6}
            onPress={promptAddImage}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          >
            <Text style={styles.iconBtnText}>🖼</Text>
          </Pressable>
          <Pressable
            hitSlop={6}
            onPress={() => void toggleDictation()}
            style={({ pressed }) => [
              styles.iconBtn,
              listening && styles.iconBtnActive,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.iconBtnText}>{listening ? "⏹" : "🎤"}</Text>
          </Pressable>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={gatewayOnline ? "Message…" : "Gateway offline"}
            placeholderTextColor={COLORS.muted}
            editable={!sending}
            multiline
          />
        </View>
        <View style={styles.composerBottomRow}>
          <Text style={styles.composerMeta}>
            {provider === "auto" ? `Auto · ${modeDef.label}` : provider}
            {jsonMode ? " · JSON" : ""}
            {toolsMode ? " · tools" : ""}
          </Text>
          {sending ? (
            <Pressable
              onPress={stop}
              style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
            >
              <Text style={styles.stopText}>Stop</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => send()}
              onLongPress={() => input.trim() && setOverrideVisible(true)}
              disabled={!canSend}
              style={({ pressed }) => [
                styles.sendButton,
                !canSend && styles.sendButtonDisabled,
                pressed && canSend && styles.pressed,
              ]}
            >
              <Text style={styles.sendText}>Send</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Pre-send consent (Apple 5.1.2(i)) — where the data actually goes. */}
      <Modal visible={consentVisible} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Before your first send</Text>
            <Text style={styles.modalBody}>
              Your message goes to the AI provider you choose, routed through your
              own gateway. Here&apos;s exactly where data travels:
            </Text>
            <ScrollView style={styles.flowList}>
              {describeFlow("standard").map((item, i) => (
                <View key={i} style={styles.flowItem}>
                  <Text style={styles.flowDest}>
                    {DESTINATIONS[item.destination].label}
                  </Text>
                  <Text style={styles.flowData}>{item.data}</Text>
                  <Text style={styles.flowDetail}>{item.detail}</Text>
                </View>
              ))}
            </ScrollView>
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setConsentVisible(false)}
                style={({ pressed }) => [styles.modalBtn, pressed && styles.pressed]}
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={grantConsentAndSend}
                style={({ pressed }) => [
                  styles.modalBtn,
                  styles.modalBtnPrimary,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.modalBtnPrimaryText}>Got it — send</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Private Mode explainer (shown the first time it's enabled). */}
      <Modal visible={privateExplainVisible} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🛡 Private Mode on</Text>
            <Text style={styles.modalBody}>
              Zintus will refuse providers that train on your data for every
              message. Your prompts still travel to a no-training provider
              through your gateway — for fully on-device processing, pick a local
              runtime (Ollama / LM Studio).
              {"\n\n"}Tradeoff: blocking training providers can reduce
              availability, so some free providers may be skipped.
            </Text>
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setPrivateExplainVisible(false)}
                style={({ pressed }) => [
                  styles.modalBtn,
                  styles.modalBtnPrimary,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.modalBtnPrimaryText}>Got it</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Long-press Send → one-message provider override. */}
      <Modal visible={overrideVisible} transparent animationType="slide">
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setOverrideVisible(false)}
        >
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Send this message via…</Text>
            <ScrollView>
              {PROVIDER_IDS.map((id) => (
                <Pressable
                  key={id}
                  onPress={() => {
                    setOverrideVisible(false);
                    send(id);
                  }}
                  style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
                >
                  <Text style={styles.sheetRowText}>
                    {PROVIDER_METADATA[id]?.name ?? id}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.surface },
  header: {
    paddingTop: 56,
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: { color: COLORS.ink, fontSize: 22, fontWeight: "700" },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerLink: { color: COLORS.accentBright, fontSize: 13, fontWeight: "600" },
  shieldOn: { color: COLORS.good, fontWeight: "800" },
  chipRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
    justifyContent: "flex-end",
    flexShrink: 1,
  },
  gatewayHint: {
    color: COLORS.muted,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  projectBadge: {
    color: COLORS.accentBright,
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 16,
    paddingBottom: 2,
  },
  errorText: {
    color: COLORS.error,
    fontSize: 13,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  offlineBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.error,
    backgroundColor: COLORS.panel,
  },
  offlineText: { color: COLORS.error, fontSize: 13, fontWeight: "600" },
  offlineSub: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
  chip: {
    backgroundColor: COLORS.panel,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  chipActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  chipText: { color: COLORS.accentBright, textTransform: "capitalize" },
  chipTextActive: { color: COLORS.onAccent, fontWeight: "700" },
  pressed: { opacity: 0.7 },
  list: { flex: 1, paddingHorizontal: 16 },
  listContent: { paddingBottom: 8 },
  emptyContainer: { flexGrow: 1, justifyContent: "center" },
  empty: { alignItems: "center", paddingHorizontal: 24 },
  emptyTitle: { color: COLORS.ink, fontSize: 18, fontWeight: "700", marginBottom: 8 },
  emptySubtitle: {
    color: COLORS.muted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  composer: {
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    gap: 8,
  },
  attachWrap: { gap: 6 },
  attachChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  attachChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    maxWidth: "100%",
    backgroundColor: COLORS.panel,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  attachName: { color: COLORS.ink, fontSize: 12, flexShrink: 1 },
  attachRemove: { color: COLORS.muted, fontSize: 16, fontWeight: "800" },
  attachNotice: { color: COLORS.muted, fontSize: 11, lineHeight: 15 },
  imageStrip: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  imageThumbWrap: { position: "relative" },
  imageThumb: {
    width: 64,
    height: 64,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  imageRemove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  imageRemoveText: { color: COLORS.ink, fontSize: 13, fontWeight: "800", lineHeight: 15 },
  imageSize: { color: COLORS.muted, fontSize: 9, textAlign: "center", marginTop: 2 },
  composerTopRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  composerBottomRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  composerMeta: { color: COLORS.muted, fontSize: 11, textTransform: "capitalize" },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: COLORS.panel,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  iconBtnActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  iconBtnText: { color: COLORS.accentBright, fontSize: 18 },
  input: {
    flex: 1,
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    maxHeight: 140,
    minHeight: 38,
  },
  sendButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    justifyContent: "center",
    paddingHorizontal: 18,
    paddingVertical: 8,
    alignItems: "center",
  },
  sendButtonDisabled: { opacity: 0.4 },
  sendText: { color: COLORS.onAccent, fontWeight: "700" },
  stopButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.error,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  stopText: { color: COLORS.error, fontWeight: "700" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: COLORS.panel,
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalTitle: { color: COLORS.ink, fontSize: 17, fontWeight: "800", marginBottom: 8 },
  modalBody: { color: COLORS.muted, fontSize: 13, lineHeight: 19, marginBottom: 10 },
  flowList: { maxHeight: 230 },
  flowItem: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    paddingVertical: 8,
  },
  flowDest: { color: COLORS.accentBright, fontSize: 12, fontWeight: "800" },
  flowData: { color: COLORS.ink, fontSize: 13, fontWeight: "600", marginTop: 1 },
  flowDetail: { color: COLORS.muted, fontSize: 12, lineHeight: 17, marginTop: 1 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 14 },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 9 },
  modalBtnText: { color: COLORS.muted, fontWeight: "700" },
  modalBtnPrimary: { backgroundColor: COLORS.accent },
  modalBtnPrimaryText: { color: COLORS.onAccent, fontWeight: "800" },
  sheet: {
    marginTop: "auto",
    backgroundColor: COLORS.panel,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: "70%",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sheetTitle: { color: COLORS.ink, fontSize: 15, fontWeight: "800", marginBottom: 8 },
  sheetRow: {
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  sheetRowText: { color: COLORS.ink, fontSize: 15 },
});
