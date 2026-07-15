import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { COLORS } from "@/lib/theme";
import { createAndPlanEngineerRun, engineerHumanDecision, getEngineerMobileData, getEngineerRepository, getEngineerRun, listEngineerRuns, recoverEngineerStaleBase, resolveEngineerDecision, type EngineerMobileData, type EngineerRepository, type EngineerRun } from "@/lib/engineer";

export default function EngineerScreen() {
  const [repository, setRepository] = useState<EngineerRepository | null>(null);
  const [runs, setRuns] = useState<EngineerRun[]>([]);
  const [run, setRun] = useState<EngineerRun | null>(null);
  const [data, setData] = useState<EngineerMobileData | null>(null);
  const [task, setTask] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    const [canonical, history] = await Promise.all([getEngineerRepository(), listEngineerRuns()]);
    setRepository(canonical); setRuns(history);
  }, []);
  const loadRun = useCallback(async (runId: string) => {
    const [nextRun, nextData] = await Promise.all([getEngineerRun(runId), getEngineerMobileData(runId)]);
    setRun(nextRun); setData(nextData);
  }, []);
  useFocusEffect(useCallback(() => { void loadDashboard().catch((cause) => setError(cause instanceof Error ? cause.message : "Engineer gateway unavailable")); }, [loadDashboard]));
  useEffect(() => {
    if (!run || run.terminalAt) return;
    const timer = setInterval(() => void loadRun(run.runId).catch(() => undefined), 5_000);
    return () => clearInterval(timer);
  }, [loadRun, run]);

  const create = async () => {
    if (!repository || !task.trim()) return;
    setBusy(true); setError(null);
    try { const created = await createAndPlanEngineerRun(repository, task.trim()); setTask(""); await loadDashboard(); await loadRun(created.runId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create Engineer run"); }
    finally { setBusy(false); }
  };
  const decide = async (action: "approve" | "request-changes" | "reject") => {
    if (!run) return;
    setBusy(true); setError(null);
    try { await engineerHumanDecision(run.runId, action, reason.trim() || `${action} from Zintus mobile`); setReason(""); await loadRun(run.runId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Decision failed"); }
    finally { setBusy(false); }
  };

  return <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void (run ? loadRun(run.runId) : loadDashboard())} tintColor={COLORS.accent} />}>
    <Text style={styles.kicker}>ZINTUS ENGINEER</Text><Text style={styles.title}>Evidence, not promises.</Text><Text style={styles.body}>Create work on the gateway’s canonical repository, monitor durable verification, and answer only required human tasks.</Text>
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {!run ? <>
      <View style={styles.card}><Text style={styles.heading}>New engineering run</Text><Text style={styles.meta}>{repository ? `${repository.owner}/${repository.name} · ${repository.baseCommitSha.slice(0, 12)}` : "Loading canonical repository…"}</Text><TextInput style={styles.input} value={task} onChangeText={setTask} multiline placeholder="Describe a bounded feature or bug…" placeholderTextColor={COLORS.muted} /><Button label={busy ? "Planning…" : "Create evidence plan"} disabled={busy || !repository || !task.trim()} onPress={() => void create()} /></View>
      <Text style={styles.section}>RECENT DURABLE RUNS</Text>{runs.map((item) => <Pressable key={item.runId} style={styles.card} onPress={() => void loadRun(item.runId)}><State value={item.state} /><Text style={styles.heading} numberOfLines={2}>{item.requestNormalized || item.requestOriginal}</Text><Text style={styles.meta}>{item.riskTier} · {item.runId}</Text></Pressable>)}
    </> : <>
      <Pressable onPress={() => { setRun(null); setData(null); }}><Text style={styles.link}>← All runs</Text></Pressable><View style={styles.card}><State value={run.state} /><Text style={styles.heading}>{run.requestNormalized || run.requestOriginal}</Text><Text style={styles.meta}>{run.riskTier} risk · {run.runId}</Text><Text style={styles.body}>{(data?.tests.length ?? 0)} tests · {(data?.claims.length ?? 0)} claims · {(data?.failures.length ?? 0)} failures · {(data?.gitOperations.length ?? 0)} Git operations</Text></View>
      {(data?.decisions ?? []).filter((item) => item.status === "OPEN").map((decision) => <View style={styles.card} key={decision.decisionId}><Text style={styles.kicker}>HUMAN INPUT REQUIRED</Text><Text style={styles.heading}>{decision.question}</Text><Text style={styles.body}>{decision.options.find((item) => item.optionId === decision.recommendedOptionId)?.description}</Text><Button label={`Choose ${decision.options.find((item) => item.optionId === decision.recommendedOptionId)?.label ?? "recommended"}`} disabled={busy} onPress={() => void resolveEngineerDecision(run, decision).then(() => loadRun(run.runId)).catch((cause) => setError(cause instanceof Error ? cause.message : "Decision failed"))} /></View>)}
      {run.state === "HUMAN_APPROVAL_PENDING" ? <View style={styles.card}><Text style={styles.kicker}>FINAL HUMAN GATE</Text><Text style={styles.heading}>Approve the exact reviewed result</Text><TextInput style={styles.input} value={reason} onChangeText={setReason} placeholder="Decision rationale" placeholderTextColor={COLORS.muted} /><Button label="Approve and publish" disabled={busy} onPress={() => void decide("approve")} /><View style={styles.row}><Button label="Changes" disabled={busy} onPress={() => void decide("request-changes")} /><Button label="Reject" disabled={busy} onPress={() => void decide("reject")} danger /></View></View> : null}
      {run.state === "BASE_BRANCH_STALE" ? <View style={styles.card}><Text style={styles.heading}>Base branch changed</Text><Text style={styles.body}>The old approval is blocked. Start a clean run on the credentialed current base.</Text><Button label="Start controlled recovery" disabled={busy} onPress={() => void recoverEngineerStaleBase(run.runId).then((replacement) => loadRun(replacement.runId)).catch((cause) => setError(cause instanceof Error ? cause.message : "Recovery failed"))} /></View> : null}
    </>}
  </ScrollView>;
}

function Button({ label, onPress, disabled, danger = false }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) { return <Pressable onPress={onPress} disabled={disabled} style={[styles.button, danger && styles.danger, disabled && styles.disabled]}><Text style={[styles.buttonText, danger && styles.dangerText]}>{label}</Text></Pressable>; }
function State({ value }: { value: string }) { return <Text style={styles.state}>{value.replaceAll("_", " ")}</Text>; }
const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: COLORS.surface }, content: { padding: 18, gap: 14, paddingBottom: 80 }, kicker: { color: COLORS.muted, fontSize: 11, letterSpacing: 1.5, fontWeight: "700" }, title: { color: COLORS.ink, fontSize: 30, lineHeight: 34, fontWeight: "700" }, body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 }, error: { color: COLORS.error }, section: { color: COLORS.muted, fontSize: 11, letterSpacing: 1.2, marginTop: 8 }, card: { backgroundColor: COLORS.panel, borderColor: COLORS.border, borderWidth: 1, borderRadius: 14, padding: 16, gap: 10 }, heading: { color: COLORS.ink, fontSize: 18, lineHeight: 23, fontWeight: "600" }, meta: { color: COLORS.muted, fontSize: 12, fontFamily: "monospace" }, input: { minHeight: 88, borderColor: COLORS.border, borderWidth: 1, borderRadius: 10, color: COLORS.ink, padding: 12, textAlignVertical: "top" }, button: { backgroundColor: COLORS.accent, padding: 13, borderRadius: 10, alignItems: "center", flex: 1 }, buttonText: { color: COLORS.onAccent, fontWeight: "700" }, danger: { backgroundColor: "transparent", borderColor: COLORS.error, borderWidth: 1 }, dangerText: { color: COLORS.error }, disabled: { opacity: 0.45 }, row: { flexDirection: "row", gap: 10 }, link: { color: COLORS.accentBright, fontWeight: "600" }, state: { alignSelf: "flex-start", color: COLORS.good, backgroundColor: "#0f2a25", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, fontSize: 10, fontWeight: "700" } });
