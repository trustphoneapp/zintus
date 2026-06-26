import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  FlatList,
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
import { PROVIDER_IDS, type ProviderId } from "@zintus/types";
import { PROVIDER_METADATA } from "@zintus/providers";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { ChatMessageBubble } from "@/components/ChatMessageBubble";
import { streamChat } from "@/lib/chat";
import { getGatewayUrl } from "@/lib/gateway-url";
import { fetchGatewayHealth } from "@/lib/gateway";
import { loadConfig, loadSelectedProvider, saveConfig } from "@/lib/config";
import { CHAT_MODES, deriveRouting, nextMode, type ChatMode } from "@/lib/chat-mode";
import { grantProviderSendConsent, hasProviderSendConsent } from "@/lib/consent";
import { DESTINATIONS, describeFlow } from "@/lib/data-flow";
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
  type UiMessage,
} from "@/lib/messages";
import { migrateLegacyKeys } from "@/lib/secure-keys";
import { takePendingPrompt } from "@/lib/onboarding";
import { COLORS } from "@/lib/theme";

type ProviderSelection = ProviderId | "auto";

const STREAM_FLUSH_MS = 50;

export default function ChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ thread?: string }>();
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
  const [routeOptions, setRouteOptions] = useState<
    Record<string, RouteOptions | null>
  >({});

  const threadIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<UiMessage>>(null);
  const pendingSendRef = useRef<string | null>(null);

  useEffect(() => {
    void migrateLegacyKeys();
    const pending = takePendingPrompt();
    if (pending) setInput(pending);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setProvider(loadSelectedProvider());
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

  function newChat() {
    abortRef.current?.abort();
    threadIdRef.current = null;
    setMessages([]);
    setInput("");
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
    async (text: string, oneShotProvider?: ProviderId) => {
      const config = loadConfig();
      const routing = deriveRouting(mode, config.routingStrategy);
      const effectiveProvider =
        oneShotProvider ?? (provider === "auto" ? undefined : provider);

      // Ensure a local thread exists so the conversation persists.
      if (!threadIdRef.current) {
        const thread = await createThread({
          title: text.slice(0, 48),
          defaultProvider: effectiveProvider ?? null,
          strategy: routing.strategy ?? null,
          privacyPosture: routing.posture,
        });
        threadIdRef.current = thread.id;
      }
      const threadId = threadIdRef.current;

      const userMessage = createUserMessage(text);
      const placeholder = createAssistantPlaceholder();
      setMessages((current) => [...current, userMessage, placeholder]);
      setInput("");
      setSending(true);
      setError(null);

      void appendMessage({
        threadId,
        role: "user",
        content: userMessage.content,
      });

      const controller = new AbortController();
      abortRef.current = controller;

      // Throttle stream→state so we don't re-render the list per token.
      let latest = "";
      let flushScheduled = false;
      const flush = () => {
        flushScheduled = false;
        setAssistant(placeholder.id, { content: latest });
      };

      try {
        const result = await streamChat({
          providerId: effectiveProvider,
          strategy: effectiveProvider ? undefined : routing.strategy,
          blockTraining: routing.blockTraining || privateMode,
          mode: config.contextMode,
          threadId: threadIdRef.current ?? undefined,
          messages: toChatMessages([...messages, userMessage]),
          signal: controller.signal,
          onChunk: (t) => {
            latest = t;
            if (!flushScheduled) {
              flushScheduled = true;
              setTimeout(flush, STREAM_FLUSH_MS);
            }
          },
        });

        setAssistant(placeholder.id, {
          streaming: false,
          providerId: result.providerId,
          model: result.model,
          meta: result.meta,
          content: latest || `[${result.providerId}/${result.model}] (empty response)`,
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
      } catch (sendError) {
        if (controller.signal.aborted) {
          setAssistant(placeholder.id, {
            streaming: false,
            content: latest || "(stopped)",
          });
        } else {
          const message =
            sendError instanceof Error ? sendError.message : "Request failed";
          setError(message);
          setAssistant(placeholder.id, {
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
    [messages, mode, provider, privateMode, setAssistant, loadRouteOptions],
  );

  const send = useCallback(
    (oneShotProvider?: ProviderId) => {
      const text = input.trim();
      if (!text || sending || !gatewayOnline) return;
      const routing = deriveRouting(mode, loadConfig().routingStrategy);
      // Apple 5.1.2(i): consent before sending to a third-party provider.
      if (routing.posture !== "local-only" && !hasProviderSendConsent()) {
        pendingSendRef.current = text;
        setConsentVisible(true);
        return;
      }
      void runTurn(text, oneShotProvider);
    },
    [input, sending, gatewayOnline, mode, runTurn],
  );

  function grantConsentAndSend() {
    grantProviderSendConsent();
    setConsentVisible(false);
    const text = pendingSendRef.current;
    pendingSendRef.current = null;
    if (text) void runTurn(text);
  }

  function stop() {
    abortRef.current?.abort();
  }

  const copy = useCallback((text: string) => {
    if (text.trim()) void Share.share({ message: text });
  }, []);

  const lastUserText = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user")?.content ?? "",
    [messages],
  );

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

  const notAvailable = useCallback((feature: string) => {
    Alert.alert(
      `${feature} needs a dev build`,
      `${feature} uses native modules that aren't in this Expo Go-style runtime. Install the dev build (see Settings) to enable it.`,
    );
  }, []);

  const renderItem = useCallback<ListRenderItem<UiMessage>>(
    ({ item }) => (
      <ChatMessageBubble
        message={item}
        routeOptions={item.providerId ? routeOptions[item.providerId] : null}
        onCopy={copy}
        onCopyCode={copy}
        onRetry={!sending ? retry : undefined}
        onRegenerate={!sending ? regenerate : undefined}
        onReport={report}
        onRouteAction={handleRouteAction}
      />
    ),
    [routeOptions, copy, retry, regenerate, report, sending],
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
  const canSend = Boolean(input.trim()) && !sending && gatewayOnline;

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

      <View style={styles.composer}>
        <View style={styles.composerTopRow}>
          <Pressable
            hitSlop={6}
            onPress={() => notAvailable("Attachments")}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          >
            <Text style={styles.iconBtnText}>＋</Text>
          </Pressable>
          <Pressable
            hitSlop={6}
            onPress={() => notAvailable("Voice dictation")}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          >
            <Text style={styles.iconBtnText}>🎤</Text>
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
