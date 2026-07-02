import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import {
  createAgentTask,
  resolveApproval,
  stopAgent,
  streamAgentEvents,
  type AgentEvent,
} from "@/lib/agents";
import { COLORS } from "@/lib/theme";

/**
 * Agent mode (mobile) — kick off a sandboxed coding task that runs on your
 * gateway machine and watch it live from your phone (LAN or via the relay).
 * Every file write / command pauses for your approval unless auto-approve is on.
 * Mirrors the web/desktop `/agent` surfaces.
 */
export default function AgentScreen() {
  const router = useRouter();
  const [task, setTask] = useState("");
  const [root, setRoot] = useState("");
  const [allowRun, setAllowRun] = useState(false);
  const [sandbox, setSandbox] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [events]);

  const start = useCallback(async () => {
    if (!task.trim() || running) return;
    setEvents([]);
    setError(null);
    setRunning(true);
    try {
      const id = await createAgentTask({
        task,
        root: root.trim() || undefined,
        allowRun,
        autoApprove,
        // Docker sandbox is only meaningful with allowRun (it isolates run_command).
        sandbox: allowRun ? sandbox : false,
        browse,
      });
      setAgentId(id);
      const controller = new AbortController();
      abortRef.current = controller;
      await streamAgentEvents(
        id,
        (e) => setEvents((prev) => [...prev, e]),
        controller.signal,
      );
    } catch (err) {
      if (!abortRef.current?.signal.aborted) {
        setError(err instanceof Error ? err.message : "Agent request failed");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [task, root, allowRun, sandbox, browse, autoApprove, running]);

  const stop = useCallback(() => {
    if (agentId) void stopAgent(agentId);
  }, [agentId]);

  const approve = useCallback(
    (approvalId: string, approved: boolean) => {
      if (agentId) void resolveApproval(agentId, approvalId, approved);
    },
    [agentId],
  );

  const resolved = new Set(
    events
      .filter((e) => e.type === "approval_resolved")
      .map((e) => String(e.approval_id)),
  );
  const pending = events.filter(
    (e) => e.type === "approval_required" && !resolved.has(String(e.approval_id)),
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Pressable hitSlop={8} onPress={() => router.back()}>
          <Text style={styles.headerLink}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Agent</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.subtitle}>
          Runs on your gateway machine, sandboxed to the root below. Writes and
          commands pause for your approval.
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Task — e.g. “add a --json flag to the export script”"
          placeholderTextColor={COLORS.muted}
          value={task}
          onChangeText={setTask}
          editable={!running}
          multiline
        />
        <TextInput
          style={styles.inputSmall}
          placeholder="Sandbox root (default: gateway workspace)"
          placeholderTextColor={COLORS.muted}
          value={root}
          onChangeText={setRoot}
          editable={!running}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Allow verify commands</Text>
          <Switch value={allowRun} onValueChange={setAllowRun} disabled={running} />
        </View>
        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, !allowRun && styles.toggleLabelOff]}>
            Docker sandbox
          </Text>
          <Switch
            value={sandbox}
            onValueChange={setSandbox}
            disabled={running || !allowRun}
          />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Browser tool</Text>
          <Switch value={browse} onValueChange={setBrowse} disabled={running} />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Auto-approve writes</Text>
          <Switch value={autoApprove} onValueChange={setAutoApprove} disabled={running} />
        </View>
        <Text style={styles.hostNote}>
          Docker sandbox &amp; the browser tool need Docker / Playwright on the
          gateway host; if absent, the agent proceeds without them. Browsing
          blocks private/internal hosts by default.
        </Text>

        {running ? (
          <Pressable style={styles.stopBtn} onPress={stop}>
            <Text style={styles.stopText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.runBtn, !task.trim() && styles.runBtnDisabled]}
            onPress={() => void start()}
            disabled={!task.trim()}
          >
            <Text style={styles.runText}>Run agent</Text>
          </Pressable>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {pending.map((p) => (
          <View key={String(p.approval_id)} style={styles.approvalCard}>
            <Text style={styles.approvalTitle}>
              {String(p.tool)} wants to touch {String(p.path)}
            </Text>
            <Text style={styles.diff} numberOfLines={8}>
              {String(p.diff)}
            </Text>
            <View style={styles.approvalActions}>
              <Pressable
                style={styles.approveBtn}
                onPress={() => approve(String(p.approval_id), true)}
              >
                <Text style={styles.approveText}>Approve</Text>
              </Pressable>
              <Pressable
                style={styles.declineBtn}
                onPress={() => approve(String(p.approval_id), false)}
              >
                <Text style={styles.declineText}>Decline</Text>
              </Pressable>
            </View>
          </View>
        ))}

        <View style={styles.log}>
          {events.length === 0 ? (
            <Text style={styles.logEmpty}>
              Events stream here — routing, the agent&apos;s text, tool calls and
              results, approvals, and the final change summary.
            </Text>
          ) : (
            events.map((e) => <EventLine key={e.seq} event={e} />)
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function EventLine({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "started":
      return <Text style={styles.evStarted}>▶ sandbox {String(event.root)}</Text>;
    case "routed":
      return (
        <Text style={styles.evMuted}>
          → routed to {String(event.provider ?? "?")}
          {event.model ? ` · ${String(event.model)}` : ""}
        </Text>
      );
    case "text":
      return <Text style={styles.evText}>{String(event.text)}</Text>;
    case "tool_call":
      return (
        <Text style={styles.evTool}>
          🔧 {String(event.tool)}({JSON.stringify(event.arguments)})
        </Text>
      );
    case "tool_result":
      return (
        <Text style={event.is_error ? styles.evWarn : styles.evMuted}>
          {event.is_error ? "⚠ " : "✓ "}
          {String(event.tool)} → {String(event.content).slice(0, 160)}
        </Text>
      );
    case "approval_required":
      return (
        <Text style={styles.evWarn}>
          ⏸ approval required: {String(event.tool)} → {String(event.path)}
        </Text>
      );
    case "approval_resolved":
      return (
        <Text style={styles.evMuted}>
          {event.approved ? "✔ approved" : "✖ declined"}
          {event.auto ? " (auto)" : ""}
        </Text>
      );
    case "done":
      return (
        <Text style={styles.evDone}>
          ✅ done · {String(event.rounds)} round(s) · {String(event.mutations)} change(s)
        </Text>
      );
    case "stopped":
      return <Text style={styles.evError}>⏹ stopped</Text>;
    case "error":
      return <Text style={styles.evError}>✗ {String(event.message)}</Text>;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.surface },
  header: {
    paddingTop: 56,
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLink: { color: COLORS.accentBright, fontSize: 15, fontWeight: "600", width: 44 },
  title: { color: COLORS.ink, fontSize: 20, fontWeight: "700" },
  scroll: { flex: 1 },
  subtitle: { color: COLORS.muted, fontSize: 13, lineHeight: 18 },
  input: {
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    borderRadius: 10,
    padding: 12,
    minHeight: 72,
    borderWidth: 1,
    borderColor: COLORS.border,
    fontSize: 14,
  },
  inputSmall: {
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    fontSize: 13,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toggleLabel: { color: COLORS.ink, fontSize: 14 },
  toggleLabelOff: { color: COLORS.muted },
  hostNote: { color: COLORS.muted, fontSize: 11, lineHeight: 16 },
  runBtn: {
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  runBtnDisabled: { opacity: 0.4 },
  runText: { color: COLORS.onAccent, fontWeight: "700", fontSize: 15 },
  stopBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.error,
    paddingVertical: 12,
    alignItems: "center",
  },
  stopText: { color: COLORS.error, fontWeight: "700", fontSize: 15 },
  error: { color: COLORS.error, fontSize: 13 },
  approvalCard: {
    borderWidth: 1,
    borderColor: COLORS.warn,
    backgroundColor: "rgba(245,158,11,0.10)",
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  approvalTitle: { color: COLORS.warn, fontWeight: "700", fontSize: 13 },
  diff: {
    color: COLORS.muted,
    fontSize: 11,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
  },
  approvalActions: { flexDirection: "row", gap: 8 },
  approveBtn: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  approveText: { color: COLORS.onAccent, fontWeight: "700" },
  declineBtn: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  declineText: { color: COLORS.ink, fontWeight: "600" },
  log: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    borderRadius: 10,
    padding: 12,
    minHeight: 160,
    gap: 2,
  },
  logEmpty: { color: COLORS.muted, fontSize: 12, lineHeight: 18 },
  evStarted: { color: COLORS.accentBright, fontSize: 12 },
  evMuted: { color: COLORS.muted, fontSize: 12 },
  evText: { color: COLORS.ink, fontSize: 13 },
  evTool: {
    color: "#60a5fa",
    fontSize: 12,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
  },
  evWarn: { color: COLORS.warn, fontSize: 12 },
  evDone: { color: COLORS.good, fontSize: 13, fontWeight: "700" },
  evError: { color: COLORS.error, fontSize: 13 },
});
