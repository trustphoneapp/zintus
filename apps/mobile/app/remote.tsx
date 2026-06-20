import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Linking,
  ScrollView,
  TextInput,
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
  type CloudSession,
  type SessionStatus,
} from "@/lib/cloud";

WebBrowser.maybeCompleteAuthSession();

type Screen = "sessions" | "detail";

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
        <Text style={styles.heading}>Zintus Cloud</Text>
        <Text style={styles.sub}>
          Sign in to manage your home gateway from anywhere — no inbound ports, keys stay home.
        </Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={handleSignIn}>
          <Text style={styles.primaryBtnText}>Sign in to Zintus Cloud</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (screen === "detail" && selectedId) {
    const selected = sessions.find((s) => s.id === selectedId);
    const providers = sessionStatus?.providers ?? [];
    const strategy = sessionStatus?.strategy ?? "fastest";
    const STRATEGIES = ["fastest", "economy", "capability"];

    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.contentPad}>
        <TouchableOpacity onPress={() => { setScreen("sessions"); setSelectedId(null); }}>
          <Text style={styles.back}>← Sessions</Text>
        </TouchableOpacity>

        <Text style={styles.heading}>{selected?.name ?? "Gateway"}</Text>

        {statusOffline && (
          <View style={styles.offlineBanner}>
            <Text style={styles.offlineBannerText}>
              Gateway offline — open zintus.app/dashboard for help
            </Text>
          </View>
        )}

        {!statusOffline && (
          <View style={styles.onlineBadge}>
            <Text style={styles.onlineBadgeText}>● Online</Text>
          </View>
        )}

        {/* Strategy */}
        <Text style={styles.sectionTitle}>Routing strategy</Text>
        <View style={styles.strategyRow}>
          {STRATEGIES.map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.strategyChip, strategy === s && styles.strategyChipActive]}
              onPress={() => control("set_strategy", s)}
              disabled={controlling || statusOffline}
            >
              <Text
                style={[styles.strategyChipText, strategy === s && styles.strategyChipTextActive]}
              >
                {s}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Controls */}
        <View style={styles.controlRow}>
          <TouchableOpacity
            style={[styles.controlBtn, styles.controlBtnSecondary]}
            onPress={() => control(sessionStatus?.paused ? "resume" : "pause")}
            disabled={controlling || statusOffline}
          >
            <Text style={styles.controlBtnText}>
              {sessionStatus?.paused ? "Resume" : "Pause"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.controlBtn}
            onPress={() => control("reload_keys")}
            disabled={controlling || statusOffline}
          >
            <Text style={styles.controlBtnText}>Reload keys</Text>
          </TouchableOpacity>
        </View>

        {/* Providers */}
        {providers.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Providers</Text>
            {providers.map((p) => {
              const pct = Math.round((p.remainingRatio ?? 0) * 100);
              return (
                <View key={p.id} style={styles.providerRow}>
                  <Text style={styles.providerName}>{p.name}</Text>
                  <View style={styles.quotaTrack}>
                    <View style={[styles.quotaFill, { width: `${pct}%` as `${number}%` }]} />
                  </View>
                  <Text style={styles.providerPct}>{pct}%</Text>
                </View>
              );
            })}
          </>
        )}

        {/* Savings */}
        {sessionStatus?.savings?.estimatedUsdSaved != null && (
          <View style={styles.savingsCard}>
            <Text style={styles.savingsLabel}>Estimated saved</Text>
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
        <Text style={styles.heading}>Gateways</Text>
        <TouchableOpacity onPress={handleSignOut}>
          <Text style={styles.signOutBtn}>Sign out</Text>
        </TouchableOpacity>
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
            <TouchableOpacity
              style={styles.sessionCard}
              onPress={() => openSession(item.id)}
            >
              <View style={styles.sessionCardLeft}>
                <View
                  style={[
                    styles.dot,
                    item.online ? styles.dotOnline : styles.dotOffline,
                  ]}
                />
                <View>
                  <Text style={styles.sessionName}>{item.name}</Text>
                  <Text style={styles.sessionMeta}>
                    {item.online
                      ? "Online"
                      : item.last_seen
                        ? `Last seen ${new Date(item.last_seen).toLocaleDateString()}`
                        : "Never seen"}
                  </Text>
                </View>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.surface },
  contentPad: { padding: 20, paddingBottom: 40 },
  center: { flex: 1, backgroundColor: COLORS.surface, alignItems: "center", justifyContent: "center", padding: 32 },
  listPad: { padding: 16 },
  listHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, paddingBottom: 4 },
  heading: { fontSize: 22, fontWeight: "700", color: COLORS.ink, marginBottom: 8 },
  sub: { fontSize: 14, color: COLORS.muted, textAlign: "center", marginBottom: 24, lineHeight: 20 },
  hint: { fontSize: 13, color: COLORS.muted, textAlign: "center" },
  code: { fontFamily: "monospace", color: COLORS.ink },
  back: { fontSize: 14, color: COLORS.muted, marginBottom: 16 },
  signOutBtn: { fontSize: 14, color: COLORS.muted },
  primaryBtn: { backgroundColor: COLORS.accentBright, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 32, marginTop: 8 },
  primaryBtnText: { color: COLORS.surface, fontWeight: "700", fontSize: 15, textAlign: "center" },
  sessionCard: { backgroundColor: COLORS.surface, borderRadius: 12, padding: 16, marginBottom: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sessionCardLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  sessionName: { fontSize: 15, fontWeight: "600", color: COLORS.ink },
  sessionMeta: { fontSize: 12, color: COLORS.muted, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotOnline: { backgroundColor: "#22c55e" },
  dotOffline: { backgroundColor: COLORS.muted },
  chevron: { fontSize: 20, color: COLORS.muted },
  offlineBanner: { backgroundColor: COLORS.surface, borderRadius: 10, padding: 14, marginBottom: 16, borderLeftWidth: 3, borderLeftColor: "#f04438" },
  offlineBannerText: { color: "#f04438", fontSize: 13 },
  onlineBadge: { alignSelf: "flex-start", backgroundColor: "rgba(34,197,94,0.12)", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 16 },
  onlineBadgeText: { color: "#22c55e", fontSize: 12, fontWeight: "600" },
  sectionTitle: { fontSize: 13, fontWeight: "600", color: COLORS.muted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 20, marginBottom: 10 },
  strategyRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  strategyChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  strategyChipActive: { backgroundColor: COLORS.accentBright, borderColor: COLORS.accentBright },
  strategyChipText: { fontSize: 13, color: COLORS.muted },
  strategyChipTextActive: { color: COLORS.surface, fontWeight: "600" },
  controlRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  controlBtn: { flex: 1, backgroundColor: COLORS.surface, borderRadius: 8, paddingVertical: 10, alignItems: "center", borderWidth: 1, borderColor: COLORS.border },
  controlBtnSecondary: { borderColor: "#f04438" },
  controlBtnText: { color: COLORS.ink, fontSize: 14, fontWeight: "500" },
  providerRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  providerName: { fontSize: 13, color: COLORS.ink, width: 80 },
  quotaTrack: { flex: 1, height: 6, backgroundColor: COLORS.border, borderRadius: 3 },
  quotaFill: { height: 6, backgroundColor: COLORS.accentBright, borderRadius: 3 },
  providerPct: { fontSize: 12, color: COLORS.muted, width: 36, textAlign: "right" },
  savingsCard: { marginTop: 20, backgroundColor: COLORS.surface, borderRadius: 12, padding: 16 },
  savingsLabel: { fontSize: 12, color: COLORS.muted, marginBottom: 4 },
  savingsValue: { fontSize: 24, fontWeight: "700", color: COLORS.ink },
});
