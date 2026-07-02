import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * Agent (mobile) — the operator console for the gateway-hosted coding agent,
 * matching web/desktop: arm a task, watch the live instrument readout, and
 * every write HALTS at an approval gate. On a phone the gateway is your home
 * machine (LAN or via the relay) — the "run it on your Mac from your phone"
 * surface. The status pill is the heartbeat; machine output is set in mono.
 */

type RunState = "idle" | "running" | "awaiting" | "done" | "stopped" | "error";

const STATE_LABEL: Record<RunState, string> = {
  idle: "Ready",
  running: "Running",
  awaiting: "Awaiting approval",
  done: "Done",
  stopped: "Stopped",
  error: "Error",
};

const AMBER = "#f59e0b";
const BLUE = "#60a5fa";
const MONO = Platform.select({ ios: "Menlo", android: "monospace" });

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

  const resolved = useMemo(
    () =>
      new Set(
        events
          .filter((e) => e.type === "approval_resolved")
          .map((e) => String(e.approval_id)),
      ),
    [events],
  );
  const pending = events.filter(
    (e) => e.type === "approval_required" && !resolved.has(String(e.approval_id)),
  );

  const runState: RunState = useMemo(() => {
    if (error) return "error";
    const last = [...events].reverse().find((e) =>
      ["done", "stopped", "error"].includes(e.type),
    );
    if (last?.type === "done") return "done";
    if (last?.type === "stopped") return "stopped";
    if (last?.type === "error") return "error";
    if (pending.length > 0) return "awaiting";
    if (running) return "running";
    return "idle";
  }, [events, running, error, pending.length]);

  const stateColor =
    runState === "running"
      ? COLORS.accentBright
      : runState === "awaiting"
        ? AMBER
        : runState === "done"
          ? COLORS.good
          : runState === "error" || runState === "stopped"
            ? COLORS.error
            : COLORS.muted;

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

  const armed = task.trim().length > 0;
  const launchOpen = runState === "idle" || runState === "error";

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Pressable hitSlop={8} onPress={() => router.back()}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Agent</Text>
        <View style={{ width: 44 }} />
      </View>

      {/* Status strip — the console heartbeat. */}
      <View style={styles.strip}>
        <View style={[styles.stripDot, { backgroundColor: stateColor }]} />
        <Text style={[styles.stripState, { color: stateColor }]}>
          {STATE_LABEL[runState]}
        </Text>
        <View style={{ flex: 1 }} />
        {running ? (
          <Pressable style={styles.stripStop} onPress={stop}>
            <Text style={styles.stripStopText}>Stop</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {launchOpen ? (
          <>
            <Text style={styles.fieldLabel}>Task</Text>
            <TextInput
              style={styles.taskInput}
              placeholder="What should the agent do? e.g. add a --json flag to the export script"
              placeholderTextColor={COLORS.muted}
              value={task}
              onChangeText={setTask}
              multiline
            />
            <Text style={styles.fieldLabel}>Sandbox root</Text>
            <TextInput
              style={styles.rootInput}
              placeholder="Path on the gateway host (default: workspace)"
              placeholderTextColor={COLORS.muted}
              value={root}
              onChangeText={setRoot}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <ToggleRow label="Run verify commands" hint="bun test / typecheck" value={allowRun} onChange={setAllowRun} />
            <ToggleRow label="Docker sandbox" hint="isolate commands" value={sandbox} onChange={setSandbox} disabled={!allowRun} />
            <ToggleRow label="Browser tool" hint="read web pages" value={browse} onChange={setBrowse} />
            <ToggleRow label="Auto-approve" hint="skip the gate — careful" value={autoApprove} onChange={setAutoApprove} tone="warn" />

            <Pressable
              style={[styles.launch, !armed && styles.launchOff]}
              onPress={() => void start()}
              disabled={!armed}
            >
              <Text style={styles.launchText}>
                {armed ? "Launch agent" : "Enter a task to launch"}
              </Text>
            </Pressable>
            <Text style={styles.note}>
              Runs on your gateway machine, sandboxed to the root above. Docker
              &amp; the browser tool need those installed there; browsing blocks
              internal hosts by default.
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </>
        ) : (
          <View style={styles.runSummary}>
            <Text style={styles.runTask} numberOfLines={1}>
              {task}
            </Text>
            <Pressable
              onPress={() => {
                setEvents([]);
                setError(null);
              }}
              disabled={running}
            >
              <Text style={[styles.newTask, running && { opacity: 0.4 }]}>New task</Text>
            </Pressable>
          </View>
        )}

        {/* Approval gate — the interrupt. */}
        {pending.map((p) => (
          <View key={String(p.approval_id)} style={styles.gate}>
            <View style={styles.gateHead}>
              <Text style={styles.gateBadge}>WAITING ON YOU</Text>
            </View>
            <Text style={styles.gateWhat}>
              {String(p.tool)} wants to touch {String(p.path)}
            </Text>
            <Text style={styles.gateDiff} numberOfLines={10}>
              {String(p.diff)}
            </Text>
            <View style={styles.gateActions}>
              <Pressable
                style={styles.approve}
                onPress={() => approve(String(p.approval_id), true)}
              >
                <Text style={styles.approveText}>Approve</Text>
              </Pressable>
              <Pressable
                style={styles.decline}
                onPress={() => approve(String(p.approval_id), false)}
              >
                <Text style={styles.declineText}>Decline</Text>
              </Pressable>
            </View>
          </View>
        ))}

        {/* Live run log — mono instrument readout. */}
        <View style={styles.log}>
          {events.length === 0 ? (
            <Text style={styles.logEmpty}>
              The run appears here — routing, the agent&apos;s reasoning, each tool
              call and result, approvals, and the final change summary.
            </Text>
          ) : (
            events.map((e) => <LogLine key={e.seq} event={e} />)
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  disabled,
  tone,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  tone?: "warn";
}) {
  return (
    <View style={[styles.toggle, disabled && { opacity: 0.45 }]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.toggleHint}>{hint}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: tone === "warn" ? AMBER : COLORS.accent, false: COLORS.border }}
      />
    </View>
  );
}

function LogLine({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "started":
      return <Text style={[styles.ev, { color: COLORS.accentBright }]}>▶ sandbox {String(event.root)}</Text>;
    case "routed":
      return (
        <Text style={[styles.ev, styles.evMuted]}>
          → {String(event.provider ?? "?")}
          {event.model ? ` · ${String(event.model)}` : ""}
        </Text>
      );
    case "text":
      return <Text style={styles.evText}>{String(event.text)}</Text>;
    case "tool_call":
      return (
        <Text style={[styles.ev, { color: BLUE }]}>
          {String(event.tool)}({JSON.stringify(event.arguments)})
        </Text>
      );
    case "tool_result":
      return (
        <Text style={[styles.ev, event.is_error ? { color: AMBER } : styles.evMuted]}>
          {event.is_error ? "! " : "✓ "}
          {String(event.tool)} → {String(event.content).slice(0, 160)}
        </Text>
      );
    case "approval_required":
      return (
        <Text style={[styles.ev, { color: AMBER }]}>
          ⏸ approval — {String(event.tool)} {String(event.path)}
        </Text>
      );
    case "approval_resolved":
      return (
        <Text style={[styles.ev, styles.evMuted]}>
          {event.approved ? "✓ approved" : "✗ declined"}
          {event.auto ? " (auto)" : ""}
        </Text>
      );
    case "done":
      return (
        <Text style={[styles.ev, { color: COLORS.good, fontWeight: "700" }]}>
          ✓ done · {String(event.rounds)} round(s) · {String(event.mutations)} change(s)
        </Text>
      );
    case "stopped":
      return <Text style={[styles.ev, { color: COLORS.error }]}>⏹ stopped</Text>;
    case "error":
      return <Text style={[styles.ev, { color: COLORS.error }]}>✗ {String(event.message)}</Text>;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.surface },
  header: {
    paddingTop: 56,
    paddingHorizontal: 16,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  back: { color: COLORS.accentBright, fontSize: 15, fontWeight: "600", width: 44 },
  title: { color: COLORS.ink, fontSize: 20, fontWeight: "700" },

  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  stripDot: { width: 8, height: 8, borderRadius: 4 },
  stripState: { fontSize: 13, fontWeight: "700" },
  stripStop: {
    borderWidth: 1,
    borderColor: COLORS.error,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  stripStopText: { color: COLORS.error, fontSize: 12, fontWeight: "700" },

  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 10 },

  fieldLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginTop: 4,
  },
  taskInput: {
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
    minHeight: 72,
    fontSize: 14,
  },
  rootInput: {
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    fontFamily: MONO,
  },

  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  toggleLabel: { color: COLORS.ink, fontSize: 14, fontWeight: "600" },
  toggleHint: { color: COLORS.muted, fontSize: 11, marginTop: 1 },

  launch: {
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 6,
  },
  launchOff: { opacity: 0.4 },
  launchText: { color: COLORS.onAccent, fontWeight: "700", fontSize: 15 },
  note: { color: COLORS.muted, fontSize: 11, lineHeight: 16 },
  error: { color: COLORS.error, fontSize: 13 },

  runSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  runTask: { flex: 1, color: COLORS.ink, fontSize: 14 },
  newTask: { color: COLORS.accentBright, fontSize: 12, fontWeight: "700" },

  gate: {
    borderWidth: 1,
    borderColor: AMBER,
    backgroundColor: "rgba(245,158,11,0.08)",
    borderRadius: 14,
    padding: 12,
    gap: 8,
  },
  gateHead: { flexDirection: "row" },
  gateBadge: {
    color: "#fff",
    backgroundColor: AMBER,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
  },
  gateWhat: { color: COLORS.ink, fontSize: 13, fontWeight: "600" },
  gateDiff: { color: COLORS.muted, fontSize: 11, fontFamily: MONO, lineHeight: 16 },
  gateActions: { flexDirection: "row", gap: 8 },
  approve: { backgroundColor: COLORS.good, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  approveText: { color: "#04120b", fontWeight: "700" },
  decline: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  declineText: { color: COLORS.ink, fontWeight: "600" },

  log: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    borderRadius: 14,
    padding: 12,
    minHeight: 180,
    gap: 2,
  },
  logEmpty: { color: COLORS.muted, fontSize: 13, lineHeight: 18 },
  ev: { fontFamily: MONO, fontSize: 12, color: COLORS.ink, lineHeight: 17 },
  evMuted: { color: COLORS.muted },
  evText: { color: COLORS.ink, fontSize: 13.5, lineHeight: 19, marginTop: 2 },
});
