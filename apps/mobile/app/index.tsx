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
import { streamChat, getGatewayUrl } from "@/lib/chat";
import { fetchGatewayHealth } from "@/lib/gateway";
import {
  loadConfig,
  loadJsonMode,
  loadSelectedProvider,
  saveJsonMode,
} from "@/lib/config";
import { toChatMessages, type ChatMeta } from "@/lib/messages";
import { migrateLegacyKeys } from "@/lib/secure-keys";
import { COLORS } from "@/lib/theme";

// "auto" is a UI-only sentinel: it sends NO provider so the gateway routes
// using the configured strategy.
type ProviderSelection = ProviderId | "auto";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  providerId?: ProviderId;
  model?: string;
  /** Transparency metadata (route reason, latency) for an assistant turn. */
  meta?: ChatMeta;
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

export default function ChatScreen() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderSelection>("auto");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gatewayOnline, setGatewayOnline] = useState(true);
  const [gatewayChecked, setGatewayChecked] = useState(false);
  const [jsonMode, setJsonMode] = useState(false);

  useEffect(() => {
    void migrateLegacyKeys();
    setJsonMode(loadJsonMode());
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

    try {
      const result = await streamChat({
        // "auto" -> send no provider so the gateway routes by strategy.
        providerId: selectedProvider === "auto" ? undefined : selectedProvider,
        strategy: selectedProvider === "auto" ? config.routingStrategy : undefined,
        mode: config.contextMode,
        responseFormat,
        messages: toChatMessages([...messages, userMessage]),
        onChunk: (text) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, content: text }
                : message,
            ),
          );
        },
      });

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
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
    } catch (sendError) {
      const message =
        sendError instanceof Error ? sendError.message : "Request failed";
      setError(message);
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId
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
              ) : null}
            </View>
          );
        }}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message..."
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
            <ActivityIndicator color={COLORS.onAccent} />
          ) : (
            <Text style={styles.sendText}>Send</Text>
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
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    maxWidth: "85%",
  },
  userBubble: { alignSelf: "flex-end", backgroundColor: COLORS.accent },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: COLORS.panel },
  bubbleText: { color: COLORS.ink },
  userBubbleText: { color: COLORS.onAccent },
  routeReason: {
    color: COLORS.accentBright,
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 6,
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
  typingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  typingText: { color: COLORS.muted, fontSize: 13 },
  assistantFooter: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  attribution: { color: COLORS.muted, fontSize: 11 },
  copyButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  copyText: { color: COLORS.accentBright, fontSize: 12, fontWeight: "600" },
  composer: {
    flexDirection: "row",
    gap: 8,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sendButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    justifyContent: "center",
    paddingHorizontal: 14,
    minWidth: 56,
    alignItems: "center",
  },
  sendButtonDisabled: { opacity: 0.5 },
  sendText: { color: COLORS.onAccent, fontWeight: "700" },
});
