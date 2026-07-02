import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Linking,
  ScrollView,
  Alert,
  ActivityIndicator,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import { COLORS } from "@/lib/theme";
import {
  isCloudAuthenticated,
  exchangeDeepLinkToken,
  fetchCloudSessions,
  fetchSessionStatus,
  sendCloudControl,
  cloudSignOut,
  mobileLoginUrl,
  RELAY_URL,
  type CloudSession,
  type SessionStatus,
} from "@/lib/cloud";

WebBrowser.maybeCompleteAuthSession();

/**
 * Remote (mobile) — your gateway fleet from your phone. This is the most
 * operator-shaped screen in the app, so it borrows the Agent console language
 * wholesale: the session detail opens with a status-strip heartbeat
 * (Online/Offline), controls are quiet bordered buttons, and machine facts
 * (last-seen, quota %, savings) are set in mono.
 */

type Screen = "sessions" | "detail";

const MONO = Platform.select({ ios: "Menlo", android: "monospace" });

export default function RemoteScreen() {
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>("sessions");
  const [sessions, setSessions] = useState<CloudSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [statusOffline, setStatusOffline] = useState(false);
  const [controlling, setControlling] = useState(false);

  // Bootstrap auth state.
  useEffect(() => {
    setAuthed(isCloudAuthenticated());
    setLoading(false);
  }, []);

  // Deep-link handler (mobile OAuth callback: zintus://auth?token=...).
  useEffect(() => {
    const sub = Linking.addEventListener("url", async ({ url }) => {
      const parsed = new URL(url);
      if (parsed.hostname === "auth") {
        const token = parsed.searchParams.get("token");
        if (token) {
          const result = await exchangeDeepLinkToken(token);
          if (result.ok) {
            setAuthed(true);
            await loadSessions();
          } else {
            Alert.alert("Sign-in failed", "The login link may have expired. Please try again.");
          }
        }
      }
    });
    return () => sub.remove();
  }, []);

  const loadSessions = useCallback(async () => {
    const list = await fetchCloudSessions();
    setSessions(list);
  }, []);

  useEffect(() => {
    if (!authed) return;
    loadSessions();
    const iv = setInterval(() => loadSessions(), 10_000);
    return () => clearInterval(iv);
  }, [authed, loadSessions]);

  async function handleSignIn() {
    await WebBrowser.openBrowserAsync(mobileLoginUrl());
  }

  async function handleSignOut() {
    Alert.alert("Sign out", "Sign out from Zintus Cloud?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          await cloudSignOut();
          setAuthed(false);
          setSessions([]);
          setScreen("sessions");
        },
      },
    ]);
  }

  // SSE live feed for the currently-selected session.
  useEffect(() => {
    if (!selectedId || screen !== "detail") return;

    // Use global EventSource if available (React Native Hermes) — graceful no-op otherwise.
    const ES = typeof EventSource !== "undefined" ? EventSource : null;
    if (!ES) return;

    const token = (() => {
      try {
        const { getCloudSessionToken } = require("@/lib/cloud") as typeof import("@/lib/cloud");
        return getCloudSessionToken();
      } catch { return null; }
    })();

    const url = `${RELAY_URL}/api/sessions/${selectedId}/stream`;
    const es = new ES(url, {
      // Pass session cookie as a custom header — React Native EventSource implementations
      // may support this; standard browser EventSource does not.
      headers: token ? { Cookie: `zintus_session=${token}` } : undefined,
    } as EventSourceInit);

    es.addEventListener("status", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data as string) as SessionStatus;
        setSessionStatus(data);
        setStatusOffline(false);
      } catch {}
    });

    es.addEventListener("gateway_offline", () => {
      setStatusOffline(true);
    });

    es.addEventListener("gateway_online", () => {
      setStatusOffline(false);
    });

    return () => {
      es.close();
    };
  }, [selectedId, screen]);

  async function openSession(id: string) {
    setSelectedId(id);
    setScreen("detail");
    setSessionStatus(null);
    setStatusOffline(false);
    const status = await fetchSessionStatus(id);
    if (status) {
      setSessionStatus(status);
      setStatusOffline(false);
    } else {
      setStatusOffline(true);
    }
  }

  async function control(action: string, value?: unknown) {
    if (!selectedId) return;
    setControlling(true);
    await sendCloudControl(selectedId, action, value);
    setControlling(false);
    const status = await fetchSessionStatus(selectedId);
    if (status) setSessionStatus(status);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.accentBright} />
      </View>
    );
  }

  if (!authed) {
    return (
      <View style={styles.center}>
        <Text style={styles.eyebrow}>ZINTUS CLOUD</Text>
        <Text style={styles.heading}>Your gateway, from anywhere</Text>
        <Text style={styles.sub}>
          Sign in to manage your home gateway from anywhere — no inbound ports,
          keys stay home.
        </Text>
        <Pressable
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          onPress={handleSignIn}
        >
          <Text style={styles.primaryBtnText}>Sign in to Zintus Cloud</Text>
        </Pressable>
      </View>
    );
  }

  if (screen === "detail" && selectedId) {
    const selected = sessions.find((s) => s.id === selectedId);
    const providers = sessionStatus?.providers ?? [];
    const strategy = sessionStatus?.strategy ?? "fastest";
    const STRATEGIES = ["fastest", "economy", "capability"];
    const stateColor = statusOffline ? COLORS.error : COLORS.good;

    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.contentPad}>
        <Pressable
          hitSlop={8}
          onPress={() => { setScreen("sessions"); setSelectedId(null); }}
        >
          <Text style={styles.back}>‹ Gateways</Text>
        </Pressable>

        <Text style={styles.heading}>{selected?.name ?? "Gateway"}</Text>

        {/* Status strip — same heartbeat as the Agent console. */}
        <View style={styles.strip}>
          <View style={[styles.stripDot, { backgroundColor: stateColor }]} />
          <Text style={[styles.stripState, { color: stateColor }]}>
            {statusOffline ? "Offline" : "Online"}
          </Text>
        </View>
        {statusOffline && (
          <Text style={styles.offlineHelp}>
            Gateway offline — open zintus.app/dashboard for help
          </Text>
        )}

        {/* Strategy */}
        <Text style={styles.sectionTitle}>Routing strategy</Text>
        <View style={styles.strategyRow}>
          {STRATEGIES.map((s) => (
            <Pressable
              key={s}
              style={({ pressed }) => [
                styles.strategyChip,
                strategy === s && styles.strategyChipActive,
                pressed && styles.pressed,
              ]}
              onPress={() => control("set_strategy", s)}
              disabled={controlling || statusOffline}
            >
              <Text
                style={[styles.strategyChipText, strategy === s && styles.strategyChipTextActive]}
              >
                {s}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Controls */}
        <View style={styles.controlRow}>
          <Pressable
            style={({ pressed }) => [
              styles.controlBtn,
              sessionStatus?.paused ? styles.controlBtnResume : styles.controlBtnPause,
              pressed && styles.pressed,
            ]}
            onPress={() => control(sessionStatus?.paused ? "resume" : "pause")}
            disabled={controlling || statusOffline}
          >
            <Text
              style={[
                styles.controlBtnText,
                sessionStatus?.paused ? { color: COLORS.good } : { color: COLORS.error },
              ]}
            >
              {sessionStatus?.paused ? "Resume" : "Pause"}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.controlBtn, pressed && styles.pressed]}
            onPress={() => control("reload_keys")}
            disabled={controlling || statusOffline}
          >
            <Text style={styles.controlBtnText}>Reload keys</Text>
          </Pressable>
        </View>

        {/* Providers */}
        {providers.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Providers</Text>
            <View style={styles.providerCard}>
              {providers.map((p) => {
                const pct = Math.round((p.remainingRatio ?? 0) * 100);
                return (
                  <View key={p.id} style={styles.providerRow}>
                    <Text style={styles.providerName} numberOfLines={1}>
                      {p.name}
                    </Text>
                    <View style={styles.quotaTrack}>
                      <View style={[styles.quotaFill, { width: `${pct}%` as `${number}%` }]} />
                    </View>
                    <Text style={styles.providerPct}>{pct}%</Text>
                  </View>
                );
              })}
            </View>
          </>
        )}

        {/* Savings */}
        {sessionStatus?.savings?.estimatedUsdSaved != null && (
          <View style={styles.savingsCard}>
            <Text style={styles.savingsLabel}>ESTIMATED SAVED</Text>
            <Text style={styles.savingsValue}>
              ${sessionStatus.savings.estimatedUsdSaved.toFixed(2)}
            </Text>
          </View>
        )}
      </ScrollView>
    );
  }

  // Sessions list.
  return (
    <View style={styles.container}>
      <View style={styles.listHeader}>
        <Text style={styles.fleetLine}>
          {sessions.length} {sessions.length === 1 ? "gateway" : "gateways"}
        </Text>
        <Pressable hitSlop={8} onPress={handleSignOut}>
          <Text style={styles.signOutBtn}>Sign out</Text>
        </Pressable>
      </View>

      {sessions.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.sub}>No gateways connected yet.</Text>
          <Text style={styles.hint}>
            Run <Text style={styles.code}>zintus serve --cloud</Text> on your home machine.
          </Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listPad}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.sessionCard, pressed && styles.pressed]}
              onPress={() => openSession(item.id)}
            >
              <View style={styles.sessionCardLeft}>
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: item.online ? COLORS.good : COLORS.muted },
                  ]}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.sessionName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.sessionMeta}>
                    {item.online
                      ? "online"
                      : item.last_seen
                        ? `last seen ${new Date(item.last_seen).toLocaleDateString()}`
                        : "never seen"}
                  </Text>
                </View>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.surface },
  contentPad: { padding: 20, paddingBottom: 40 },
  center: {
    flex: 1,
    backgroundColor: COLORS.surface,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  listPad: { padding: 16, paddingTop: 4 },
  listHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 6,
  },
  eyebrow: {
    color: COLORS.muted,
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: 1.5,
    marginBottom: 10,
  },
  heading: { fontSize: 22, fontWeight: "700", color: COLORS.ink, marginBottom: 8 },
  sub: {
    fontSize: 14,
    color: COLORS.muted,
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 20,
  },
  hint: { fontSize: 13, color: COLORS.muted, textAlign: "center" },
  code: { fontFamily: MONO, color: COLORS.ink },
  back: { fontSize: 15, color: COLORS.accentBright, fontWeight: "600", marginBottom: 16 },
  fleetLine: { color: COLORS.muted, fontFamily: MONO, fontSize: 11 },
  signOutBtn: { fontSize: 13, color: COLORS.muted, fontWeight: "600" },
  primaryBtn: {
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 32,
    marginTop: 8,
  },
  primaryBtnText: {
    color: COLORS.onAccent,
    fontWeight: "700",
    fontSize: 15,
    textAlign: "center",
  },
  pressed: { opacity: 0.7 },

  sessionCard: {
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  sessionCardLeft: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  sessionName: { fontSize: 15, fontWeight: "600", color: COLORS.ink },
  sessionMeta: { fontSize: 11, color: COLORS.muted, marginTop: 2, fontFamily: MONO },
  dot: { width: 10, height: 10, borderRadius: 5 },
  chevron: { fontSize: 20, color: COLORS.muted },

  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    backgroundColor: COLORS.panel,
    marginBottom: 8,
  },
  stripDot: { width: 8, height: 8, borderRadius: 4 },
  stripState: { fontSize: 13, fontWeight: "700" },
  offlineHelp: { color: COLORS.error, fontSize: 12, lineHeight: 17, marginBottom: 4 },

  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: COLORS.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 10,
  },
  strategyRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  strategyChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  strategyChipActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  strategyChipText: { fontSize: 13, color: COLORS.muted, fontWeight: "600" },
  strategyChipTextActive: { color: COLORS.onAccent, fontWeight: "800" },
  controlRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  controlBtn: {
    flex: 1,
    backgroundColor: COLORS.panel,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  controlBtnPause: { borderColor: COLORS.error },
  controlBtnResume: { borderColor: COLORS.good },
  controlBtnText: { color: COLORS.ink, fontSize: 14, fontWeight: "600" },

  providerCard: {
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  providerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  providerName: { fontSize: 13, color: COLORS.ink, width: 84 },
  quotaTrack: {
    flex: 1,
    height: 6,
    backgroundColor: COLORS.border,
    borderRadius: 3,
    overflow: "hidden",
  },
  quotaFill: { height: 6, backgroundColor: COLORS.accent, borderRadius: 3 },
  providerPct: {
    fontSize: 11,
    color: COLORS.muted,
    width: 40,
    textAlign: "right",
    fontFamily: MONO,
  },

  savingsCard: {
    marginTop: 20,
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 16,
  },
  savingsLabel: {
    fontSize: 10,
    color: COLORS.muted,
    fontFamily: MONO,
    letterSpacing: 1,
    marginBottom: 4,
  },
  savingsValue: { fontSize: 24, fontWeight: "700", color: COLORS.ink, fontFamily: MONO },
});
