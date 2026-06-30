import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ProviderId } from "@zintus/types";
import { useFocusEffect, useRouter } from "expo-router";
import type { ResponseFormat } from "@zintus/types";
import {
  streamChat,
  getGatewayUrl,
  type ChatMcpConfig,
  type McpToolEvent,
} from "@/lib/chat";
import { fetchGatewayHealth } from "@/lib/gateway";
import {
  loadConfig,
  loadJsonMode,
  loadMcpServers,
  loadSelectedProvider,
  loadToolsMode,
  saveJsonMode,
  saveToolsMode,
} from "@/lib/config";
import { activeMcpServersForChat } from "@/lib/mcp-config";
import {
  BUILTIN_TOOL_DEFINITIONS,
  MAX_TOOL_ROUNDS,
  executeBuiltinToolCall,
} from "@/lib/builtin-tools";
import { toChatMessages, type ChatMeta } from "@/lib/messages";
import { migrateLegacyKeys } from "@/lib/secure-keys";
import { COLORS } from "@/lib/theme";
import {
  extractArtifacts,
  foldArtifactVersions,
  type Artifact,
  type VersionedArtifact,
} from "@/lib/artifacts";
import { ArtifactsModal } from "@/components/ArtifactsModal";

// "auto" is a UI-only sentinel: it sends NO provider so the gateway routes
// using the configured strategy.
type ProviderSelection = ProviderId | "auto";

/** One tool call the model made, rendered transparently in the stream. */
interface ToolCallView {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The locally-executed result for a tool call, shown beneath it. */
interface ToolResultView {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  providerId?: ProviderId;
  model?: string;
  /** Transparency metadata (route reason, latency) for an assistant turn. */
  meta?: ChatMeta;
  /** Built-in tool calls the model made on this turn (Tools toggle on). */
  toolCalls?: ToolCallView[];
  /** Locally-executed results for `toolCalls`, paired by id. */
  toolResults?: ToolResultView[];
  /** Server-side MCP tool-loop events (call/result) the gateway streamed for
   *  this turn. Display-only — the gateway already ran them. */
  mcpEvents?: McpToolEvent[];
}

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

/** Render one MCP tool-loop event as a calm one-line summary (no arg/secret
 *  values — only parameter names / char counts come through the parser). */
function mcpEventLine(event: McpToolEvent): string {
  if (event.kind === "call") {
    const where = event.server ? `${event.server}/` : "";
    const args = event.argsSummary ? `(${event.argsSummary})` : "";
    return `🔧 ${where}${event.tool}${args}`;
  }
  return `${event.ok ? "→ " : "error · "}${event.summary}`;
}

/** Compact one-line render of a tool's arguments object. */
function formatToolArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "{…}";
  }
}

/** Returns a pretty-printed JSON string iff `content` is a JSON object/array,
 *  else null. Lets a `response_format: json_object` turn render as formatted
 *  JSON without ever fabricating structure (mirrors desktop's auto-detect). */
function asStructuredJson(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return null;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

/**
 * Fold the whole conversation's assistant turns into versioned artifacts: each
 * message is extracted (ids namespaced per message), concatenated in order, then
 * `foldArtifactVersions` merges same-identity blocks into one entry with a
 * version history. This is what powers the cross-message "vN of M" switcher —
 * the same iterative-artifacts model web/desktop use.
 */
function conversationArtifacts(messages: Message[]): VersionedArtifact[] {
  const flat: Artifact[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || message.streaming || !message.content) {
      continue;
    }
    for (const artifact of extractArtifacts(message.content)) {
      flat.push({ ...artifact, id: `${message.id}:${artifact.id}` });
    }
  }
  return foldArtifactVersions(flat);
}

export default function ChatScreen() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [openArtifacts, setOpenArtifacts] = useState<VersionedArtifact[]>([]);
  const [input, setInput] = useState("");
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderSelection>("auto");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gatewayOnline, setGatewayOnline] = useState(true);
  const [gatewayChecked, setGatewayChecked] = useState(false);
  const [jsonMode, setJsonMode] = useState(false);
  const [toolsMode, setToolsMode] = useState(false);
  // Count of MCP tools active across enabled servers — drives the header
  // indicator. Refreshed on focus (the MCP screen may have changed it).
  const [mcpToolCount, setMcpToolCount] = useState(0);

  useEffect(() => {
    void migrateLegacyKeys();
    setJsonMode(loadJsonMode());
    setToolsMode(loadToolsMode());
  }, []);

  useEffect(() => {
    let active = true;
    async function refresh() {
      const health = await fetchGatewayHealth();
      if (!active) return;
      setGatewayOnline(Boolean(health?.ok));
      setGatewayChecked(true);
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      setSelectedProvider(loadSelectedProvider());
      setMcpToolCount(activeMcpForChat().toolCount);
    }, []),
  );

  function toggleAuto() {
    setSelectedProvider((current) =>
      current === "auto" ? loadSelectedProvider() : "auto",
    );
  }

  async function copyMessage(content: string) {
    if (!content.trim()) {
      return;
    }
    try {
      await Share.share({ message: content });
    } catch {
      // Share sheet dismissed/unavailable — ignore.
    }
  }

  async function send() {
    if (!input.trim() || sending) {
      return;
    }

    const config = loadConfig();
    const userMessage: Message = {
      id: `${Date.now()}-user`,
      role: "user",
      content: input.trim(),
    };
    const assistantId = `${Date.now()}-assistant`;

    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ]);
    setInput("");
    setSending(true);
    setError(null);

    // When JSON mode is on, ask the gateway for json_object structured output;
    // it resolves the best level the routed provider can actually serve.
    const responseFormat: ResponseFormat | undefined = jsonMode
      ? { type: "json_object" }
      : undefined;

    // Shared routing params for every turn this send makes (the tool loop reuses
    // them each round). "auto" -> send no provider so the gateway routes by strategy.
    const routing = {
      providerId:
        selectedProvider === "auto" ? undefined : selectedProvider,
      strategy:
        selectedProvider === "auto" ? config.routingStrategy : undefined,
      mode: config.contextMode,
      responseFormat,
    } as const;

    // Built-in tool definitions are sent only when the Tools toggle is on; the
    // chat then runs the bounded execute→feed-back loop locally (the SAME loop
    // web/desktop/CLI run — "one Zintus" tools-everywhere parity).
    const tools = toolsMode ? BUILTIN_TOOL_DEFINITIONS : undefined;

    // Enabled MCP servers for this turn (server-side tool loop). Undefined when
    // none are enabled, so a normal turn carries no `mcp` field at all.
    const { mcp } = activeMcpForChat();

    // The bubble the active turn streams into — updated as the tool loop opens a
    // fresh bubble per round, so a mid-loop error attaches to the right one.
    let currentAssistantId = assistantId;

    try {
      // The conversation we feed the gateway. The tool loop appends the model's
      // assistant tool_call turn and our tool_result turn each round.
      const convo = toChatMessages([...messages, userMessage]);

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        let streamedText = "";
        const result = await streamChat({
          ...routing,
          tools,
          mcp,
          messages: convo,
          onChunk: (text) => {
            streamedText = text;
            const id = currentAssistantId;
            setMessages((current) =>
              current.map((message) =>
                message.id === id ? { ...message, content: text } : message,
              ),
            );
          },
          // Each server-side MCP call/result lands live on the active bubble —
          // calm transparency without ever executing a tool on the phone.
          onMcpToolEvent: (event) => {
            const id = currentAssistantId;
            setMessages((current) =>
              current.map((message) =>
                message.id === id
                  ? { ...message, mcpEvents: [...(message.mcpEvents ?? []), event] }
                  : message,
              ),
            );
          },
        });

        const calls = result.toolCalls ?? [];

        // No tool calls -> this is the final answer; settle the bubble and stop.
        if (calls.length === 0) {
          const id = currentAssistantId;
          setMessages((current) =>
            current.map((message) =>
              message.id === id
                ? {
                    ...message,
                    streaming: false,
                    providerId: result.providerId,
                    model: result.model,
                    meta: result.meta,
                    content:
                      message.content ||
                      `[${result.providerId}/${result.model}] (empty response)`,
                  }
                : message,
            ),
          );
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
        const settledId = currentAssistantId;
        setMessages((current) =>
          current.map((message) =>
            message.id === settledId
              ? {
                  ...message,
                  streaming: false,
                  providerId: result.providerId,
                  model: result.model,
                  meta: result.meta,
                  toolCalls: toolViews,
                  toolResults: resultViews,
                  content: hitCap
                    ? message.content ||
                      `Stopped after ${MAX_TOOL_ROUNDS} tool rounds.`
                    : message.content,
                }
              : message,
          ),
        );

        // Bounded: a model still calling tools at the cap is surfaced, not looped.
        if (hitCap) break;

        // Feed the assistant tool_call turn + our tool_result turn back, then
        // open a fresh bubble for the next round's answer.
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

        const nextId = `${Date.now()}-assistant-${round}`;
        currentAssistantId = nextId;
        setMessages((current) => [
          ...current,
          { id: nextId, role: "assistant", content: "", streaming: true },
        ]);
      }
    } catch (sendError) {
      const message =
        sendError instanceof Error ? sendError.message : "Request failed";
      setError(message);
      setMessages((current) =>
        current.map((item) =>
          item.id === currentAssistantId
            ? {
                ...item,
                streaming: false,
                content: `Error: ${message}`,
              }
            : item,
        ),
      );
    } finally {
      setSending(false);
    }
  }

  const chipLabel = selectedProvider === "auto" ? "Auto" : selectedProvider;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Zintus</Text>
        <View style={styles.chipRow}>
          <Pressable
            style={({ pressed }) => [
              styles.chip,
              selectedProvider === "auto" && styles.chipActive,
              pressed && styles.pressed,
            ]}
            onPress={toggleAuto}
          >
            <Text
              style={[
                styles.chipText,
                selectedProvider === "auto" && styles.chipTextActive,
              ]}
            >
              {chipLabel}
            </Text>
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
            <Text
              style={[styles.chipText, jsonMode && styles.chipTextActive]}
            >
              {"{} JSON"}
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
            <Text
              style={[styles.chipText, toolsMode && styles.chipTextActive]}
            >
              {"🔧 Tools"}
            </Text>
          </Pressable>
          {mcpToolCount > 0 ? (
            <Pressable
              style={({ pressed }) => [
                styles.chip,
                styles.chipActive,
                pressed && styles.pressed,
              ]}
              onPress={() => {
                router.push("/mcp");
              }}
            >
              <Text style={[styles.chipText, styles.chipTextActive]}>
                {`🔧 ${mcpToolCount} tools active`}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
            onPress={() => {
              router.push("/providers");
            }}
          >
            <Text style={styles.chipText}>Change</Text>
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
      <Text style={styles.gatewayHint}>
        Gateway: {getGatewayUrl()}
        {selectedProvider === "auto" ? " · auto-routing" : ""}
      </Text>
      {error && <Text style={styles.errorText}>{error}</Text>}

      <FlatList
        style={styles.list}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={
          messages.length === 0 ? styles.emptyContainer : undefined
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Ask anything</Text>
            <Text style={styles.emptySubtitle}>
              {selectedProvider === "auto"
                ? "Auto mode routes your message to the best available free provider."
                : `Messages route through ${selectedProvider}. Tap Auto to let the gateway choose.`}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const isUser = item.role === "user";
          // The headline "why this provider/model" — the prominent route reason
          // from the gateway's metadata frame. Mirrors web/desktop's top-line pill.
          const routeReason = !isUser ? item.meta?.routeReason : undefined;
          // Render a settled assistant turn that is itself JSON as formatted
          // monospace (the response_format: json_object path), never faking it.
          const structuredJson =
            !isUser && !item.streaming ? asStructuredJson(item.content) : null;
          // Count of artifact-worthy blocks in THIS turn — drives the
          // "Artifacts (N)" affordance. The viewer itself shows the whole
          // conversation's folded version history.
          const artifactCount =
            !isUser && !item.streaming && item.content
              ? extractArtifacts(item.content).length
              : 0;
          return (
            <View
              style={[
                styles.bubble,
                isUser ? styles.userBubble : styles.assistantBubble,
              ]}
            >
              {routeReason ? (
                <Text style={styles.routeReason} numberOfLines={2}>
                  {routeReason}
                </Text>
              ) : null}

              {item.streaming && !item.content ? (
                <View style={styles.typingRow}>
                  <ActivityIndicator size="small" color={COLORS.accentBright} />
                  <Text style={styles.typingText}>Thinking…</Text>
                </View>
              ) : structuredJson ? (
                <View style={styles.jsonBlock}>
                  <Text style={styles.jsonLabel}>JSON output</Text>
                  <Text style={styles.jsonText}>{structuredJson}</Text>
                </View>
              ) : (
                <Text style={[styles.bubbleText, isUser && styles.userBubbleText]}>
                  {item.content}
                  {item.streaming ? (
                    <Text style={styles.cursor}>▋</Text>
                  ) : null}
                </Text>
              )}

              {item.toolCalls && item.toolCalls.length > 0 ? (
                <View style={styles.toolBlock}>
                  {item.toolCalls.map((call) => {
                    const toolResult = item.toolResults?.find(
                      (r) => r.toolCallId === call.id,
                    );
                    return (
                      <View key={call.id} style={styles.toolCallRow}>
                        <Text style={styles.toolCallName} numberOfLines={2}>
                          {`🔧 ${call.name}(${formatToolArgs(call.arguments)})`}
                        </Text>
                        {toolResult ? (
                          <Text
                            style={[
                              styles.toolResult,
                              toolResult.isError && styles.toolResultError,
                            ]}
                            numberOfLines={4}
                          >
                            {toolResult.isError ? "error · " : "→ "}
                            {toolResult.content}
                          </Text>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              ) : null}

              {item.mcpEvents && item.mcpEvents.length > 0 ? (
                <View style={styles.toolBlock}>
                  {item.mcpEvents.map((event, i) => (
                    <Text
                      key={`${event.kind}-${event.id}-${i}`}
                      style={[
                        event.kind === "call"
                          ? styles.toolCallName
                          : styles.toolResult,
                        event.kind === "result" &&
                          !event.ok &&
                          styles.toolResultError,
                      ]}
                      numberOfLines={3}
                    >
                      {mcpEventLine(event)}
                    </Text>
                  ))}
                </View>
              ) : null}

              {!isUser && !item.streaming && item.content ? (
                <View style={styles.assistantFooter}>
                  {item.providerId ? (
                    <Text style={styles.attribution}>
                      {item.providerId}
                      {item.model ? ` · ${item.model}` : ""}
                      {item.meta?.latencyMs
                        ? ` · ${item.meta.latencyMs} ms`
                        : ""}
                    </Text>
                  ) : (
                    <View />
                  )}
                  <View style={styles.footerActions}>
                    {artifactCount > 0 ? (
                      <Pressable
                        style={({ pressed }) => [
                          styles.copyButton,
                          styles.artifactButton,
                          pressed && styles.pressed,
                        ]}
                        onPress={() => {
                          setOpenArtifacts(conversationArtifacts(messages));
                          setArtifactsOpen(true);
                        }}
                      >
                        <Text style={styles.artifactText}>
                          {`📄 Artifacts (${artifactCount})`}
                        </Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      style={({ pressed }) => [
                        styles.copyButton,
                        pressed && styles.pressed,
                      ]}
                      onPress={() => {
                        void copyMessage(item.content);
                      }}
                    >
                      <Text style={styles.copyText}>Copy</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {/* Per-response Private-Mode badge — mirrors web/desktop's pill
                  copy + honesty exactly. `privacyHonored` is undefined when
                  Private Mode was off (no badge), true when a no-training
                  provider served the turn, false when a may-train provider was
                  used anyway. Never claim "honored" unless the gateway confirmed it. */}
              {!isUser && !item.streaming && item.meta?.privacyHonored != null ? (
                <View
                  style={[
                    styles.privacyBadge,
                    item.meta.privacyHonored
                      ? styles.privacyBadgeHonored
                      : styles.privacyBadgeBroken,
                  ]}
                >
                  <Text
                    style={[
                      styles.privacyBadgeText,
                      { color: item.meta.privacyHonored ? COLORS.good : COLORS.warn },
                    ]}
                  >
                    {item.meta.privacyHonored
                      ? "✓ Private Mode honored"
                      : "⚠ Private Mode not honored"}
                  </Text>
                </View>
              ) : null}
            </View>
          );
        }}
      />

      <ArtifactsModal
        visible={artifactsOpen}
        artifacts={openArtifacts}
        onClose={() => setArtifactsOpen(false)}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message Zintus…"
          placeholderTextColor={COLORS.muted}
          editable={!sending}
          onSubmitEditing={() => {
            void send();
          }}
        />
        <Pressable
          style={({ pressed }) => [
            styles.sendButton,
            (sending || !input.trim()) && styles.sendButtonDisabled,
            pressed && !sending && input.trim() ? styles.pressed : null,
          ]}
          onPress={() => {
            void send();
          }}
          disabled={sending || !input.trim()}
        >
          {sending ? (
            <ActivityIndicator color={COLORS.onAccent} size="small" />
          ) : (
            <Text style={styles.sendArrow}>↑</Text>
          )}
        </Pressable>
      </View>
    </View>
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
  chipRow: { flexDirection: "row", gap: 8 },
  gatewayHint: {
    color: COLORS.muted,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingBottom: 8,
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
  offlineText: {
    color: COLORS.error,
    fontSize: 13,
    fontWeight: "600",
  },
  offlineSub: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 2,
  },
  chip: {
    backgroundColor: COLORS.panel,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  chipActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  chipText: { color: COLORS.accentBright, textTransform: "capitalize" },
  chipTextActive: { color: COLORS.onAccent, fontWeight: "700" },
  pressed: { opacity: 0.7 },
  list: { flex: 1, paddingHorizontal: 16 },
  emptyContainer: { flexGrow: 1, justifyContent: "center" },
  empty: { alignItems: "center", paddingHorizontal: 24 },
  emptyTitle: {
    color: COLORS.ink,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 8,
  },
  emptySubtitle: {
    color: COLORS.muted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  bubble: {
    marginBottom: 14,
    borderWidth: 1,
  },
  // iOS design: user = #27272b bubble, asymmetric bottom-right corner.
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "82%",
    backgroundColor: COLORS.userBubble,
    borderColor: COLORS.userBubbleBorder,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 16,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  // Mobile exception (spec §3): assistant IS a card — narrow screens read
  // poorly as plain full-width text. bg --color-elevated, 0.5px border, radius 14.
  assistantBubble: {
    alignSelf: "flex-start",
    maxWidth: "90%",
    backgroundColor: COLORS.elevated,
    borderColor: COLORS.border,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 15,
  },
  bubbleText: { color: COLORS.ink, fontSize: 15, lineHeight: 24 },
  userBubbleText: { color: COLORS.userText, lineHeight: 22 },
  routeReason: {
    color: COLORS.accentBright,
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 6,
  },
  privacyBadge: {
    alignSelf: "flex-start",
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  privacyBadgeHonored: {
    borderColor: COLORS.good,
    backgroundColor: "rgba(52,211,153,0.12)",
  },
  privacyBadgeBroken: {
    borderColor: COLORS.warn,
    backgroundColor: "rgba(245,158,11,0.12)",
  },
  privacyBadgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  jsonBlock: {
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 10,
  },
  jsonLabel: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  jsonText: {
    color: COLORS.ink,
    fontSize: 12,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
  },
  cursor: { color: COLORS.accentBright },
  toolBlock: {
    marginTop: 8,
    gap: 6,
  },
  toolCallRow: {
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 8,
  },
  toolCallName: {
    color: COLORS.accentBright,
    fontSize: 12,
    fontWeight: "600",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
  },
  toolResult: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 4,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
  },
  toolResultError: { color: COLORS.error },
  typingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  typingText: { color: COLORS.muted, fontSize: 13 },
  assistantFooter: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  attribution: { color: COLORS.muted, fontSize: 11 },
  footerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  copyButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  copyText: { color: COLORS.accentBright, fontSize: 12, fontWeight: "600" },
  artifactButton: { borderColor: COLORS.accent },
  artifactText: { color: COLORS.accentBright, fontSize: 12, fontWeight: "600" },
  composer: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.elevated,
    color: COLORS.ink,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 11,
    fontSize: 15,
  },
  // Circular brand-accent send button with a white up-arrow (iOS design).
  sendButton: {
    backgroundColor: COLORS.accent,
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  sendButtonDisabled: { backgroundColor: COLORS.sendDisabled },
  sendArrow: { color: COLORS.onAccent, fontSize: 20, fontWeight: "700", lineHeight: 22 },
});
