import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ProviderId } from "@zintus/types";
import { useFocusEffect, useRouter } from "expo-router";
import { streamChat, getGatewayUrl } from "@/lib/chat";
import { loadConfig, loadSelectedProvider } from "@/lib/config";
import { toChatMessages } from "@/lib/messages";
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
}

export default function ChatScreen() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderSelection>("auto");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void migrateLegacyKeys();
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

    try {
      const result = await streamChat({
        // "auto" -> send no provider so the gateway routes by strategy.
        providerId: selectedProvider === "auto" ? undefined : selectedProvider,
        strategy: selectedProvider === "auto" ? config.routingStrategy : undefined,
        mode: config.contextMode,
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
            style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
            onPress={() => {
              router.push("/providers");
            }}
          >
            <Text style={styles.chipText}>Change</Text>
          </Pressable>
        </View>
      </View>
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
          return (
            <View
              style={[
                styles.bubble,
                isUser ? styles.userBubble : styles.assistantBubble,
              ]}
            >
              {item.streaming && !item.content ? (
                <View style={styles.typingRow}>
                  <ActivityIndicator size="small" color={COLORS.accentBright} />
                  <Text style={styles.typingText}>Thinking…</Text>
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
