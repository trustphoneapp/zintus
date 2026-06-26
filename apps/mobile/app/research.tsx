import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Markdown } from "@/components/Markdown";
import { appendMessage, createThread } from "@/lib/history";
import {
  streamResearch,
  type ResearchDepth,
  type ResearchSource,
} from "@/lib/research";
import { COLORS } from "@/lib/theme";

type Stage =
  | "idle"
  | "planning"
  | "searching"
  | "reading"
  | "synthesizing"
  | "answering"
  | "done"
  | "error";

const STAGE_LABEL: Record<Stage, string> = {
  idle: "Ready",
  planning: "Planning",
  searching: "Searching",
  reading: "Reading sources",
  synthesizing: "Synthesizing",
  answering: "Writing answer",
  done: "Done",
  error: "Error",
};

const FLOW: Stage[] = [
  "planning",
  "searching",
  "reading",
  "synthesizing",
  "answering",
  "done",
];

const DEPTHS: ResearchDepth[] = ["quick", "standard", "deep"];

function reportMarkdown(
  query: string,
  answer: string,
  sources: ResearchSource[],
): string {
  const cites = sources
    .map((s, i) => `${i + 1}. [${s.title || s.url}](${s.url})`)
    .join("\n");
  return `# ${query}\n\n${answer}\n\n## Sources\n${cites}\n`;
}

export default function ResearchScreen() {
  const [query, setQuery] = useState("");
  const [depth, setDepth] = useState<ResearchDepth>("standard");
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [queries, setQueries] = useState<string[]>([]);
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    const q = query.trim();
    if (!q || running) return;
    setRunning(true);
    setStage("planning");
    setQueries([]);
    setSources([]);
    setAnswer("");
    setError(null);
    setSaved(false);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamResearch({
        query: q,
        depth,
        signal: controller.signal,
        events: {
          onQueries: (qs) => {
            setQueries(qs);
            setStage("searching");
          },
          onSearchComplete: (_i, results) => {
            setSources((prev) => [...prev, ...results]);
            setStage("reading");
          },
          onSynthesizing: () => setStage("synthesizing"),
          onAnswerChunk: (text) => {
            setAnswer(text);
            setStage("answering");
          },
          onDone: (finalSources) => {
            if (finalSources.length) setSources(finalSources);
            setStage("done");
          },
          onError: (message) => {
            setError(message);
            setStage("error");
          },
        },
      });
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "Research failed");
        setStage("error");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [query, depth, running]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const exportReport = useCallback(() => {
    if (!answer) return;
    void Share.share({ message: reportMarkdown(query, answer, sources) });
  }, [query, answer, sources]);

  const saveToHistory = useCallback(async () => {
    if (!answer || saved) return;
    const thread = await createThread({ title: `Research: ${query.slice(0, 40)}` });
    await appendMessage({ threadId: thread.id, role: "user", content: query });
    await appendMessage({
      threadId: thread.id,
      role: "assistant",
      content: reportMarkdown(query, answer, sources),
    });
    setSaved(true);
  }, [answer, query, sources, saved]);

  const activeIdx = FLOW.indexOf(stage);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Deep Research</Text>
      <Text style={styles.subtitle}>
        Multi-step web research with cited sources, routed through your gateway.
        Requires a search key (Tavily/Serper) configured on the gateway.
      </Text>

      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="Ask a research question…"
        placeholderTextColor={COLORS.muted}
        multiline
        editable={!running}
      />

      <View style={styles.depthRow}>
        {DEPTHS.map((d) => (
          <Pressable
            key={d}
            onPress={() => setDepth(d)}
            disabled={running}
            style={({ pressed }) => [
              styles.depthChip,
              depth === d && styles.depthChipActive,
              pressed && styles.pressed,
            ]}
          >
            <Text
              style={[styles.depthText, depth === d && styles.depthTextActive]}
            >
              {d}
            </Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        {running ? (
          <Pressable
            onPress={stop}
            style={({ pressed }) => [styles.stopBtn, pressed && styles.pressed]}
          >
            <Text style={styles.stopText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => void run()}
            disabled={!query.trim()}
            style={({ pressed }) => [
              styles.runBtn,
              !query.trim() && styles.runBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.runText}>Research</Text>
          </Pressable>
        )}
      </View>

      {stage !== "idle" && (
        <View style={styles.stageBar}>
          {FLOW.map((s, i) => (
            <View key={s} style={styles.stageItem}>
              <View
                style={[
                  styles.stageDot,
                  i < activeIdx && styles.stageDotDone,
                  i === activeIdx && styles.stageDotActive,
                  stage === "error" && i === activeIdx && styles.stageDotError,
                ]}
              />
              <Text
                style={[
                  styles.stageLabel,
                  i === activeIdx && styles.stageLabelActive,
                ]}
              >
                {STAGE_LABEL[s]}
              </Text>
            </View>
          ))}
          {running ? (
            <ActivityIndicator size="small" color={COLORS.accentBright} />
          ) : null}
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {queries.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>Search plan</Text>
          {queries.map((q, i) => (
            <Text key={i} style={styles.queryLine}>
              • {q}
            </Text>
          ))}
        </View>
      )}

      {answer.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>Answer</Text>
          <Markdown content={answer} onCopyCode={(c) => void Share.share({ message: c })} />
        </View>
      )}

      {sources.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>Sources ({sources.length})</Text>
          {sources.map((s, i) => (
            <Pressable
              key={`${s.url}-${i}`}
              onPress={() => s.url && void Linking.openURL(s.url)}
              style={({ pressed }) => [styles.sourceCard, pressed && styles.pressed]}
            >
              <Text style={styles.sourceIndex}>{i + 1}</Text>
              <View style={styles.sourceBody}>
                <Text style={styles.sourceTitle} numberOfLines={2}>
                  {s.title || s.url}
                </Text>
                <Text style={styles.sourceUrl} numberOfLines={1}>
                  {s.url}
                </Text>
                {s.content ? (
                  <Text style={styles.sourceSnippet} numberOfLines={3}>
                    {s.content}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
      )}

      {answer.length > 0 && !running && (
        <View style={styles.reportActions}>
          <Pressable
            onPress={exportReport}
            style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
          >
            <Text style={styles.actionText}>Export / Share</Text>
          </Pressable>
          <Pressable
            onPress={() => void saveToHistory()}
            style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
          >
            <Text style={styles.actionText}>{saved ? "Saved ✓" : "Save to history"}</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.surface },
  content: { padding: 16, paddingBottom: 40 },
  title: { color: COLORS.ink, fontSize: 22, fontWeight: "800", marginBottom: 4 },
  subtitle: { color: COLORS.muted, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  input: {
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    minHeight: 60,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  depthRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  depthChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  depthChipActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  depthText: { color: COLORS.accentBright, fontSize: 12, textTransform: "capitalize" },
  depthTextActive: { color: COLORS.onAccent, fontWeight: "800" },
  runBtn: {
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },
  runBtnDisabled: { opacity: 0.4 },
  runText: { color: COLORS.onAccent, fontWeight: "800" },
  stopBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.error,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },
  stopText: { color: COLORS.error, fontWeight: "800" },
  stageBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
    marginTop: 16,
    marginBottom: 4,
  },
  stageItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  stageDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.border,
  },
  stageDotDone: { backgroundColor: COLORS.good },
  stageDotActive: { backgroundColor: COLORS.accentBright },
  stageDotError: { backgroundColor: COLORS.error },
  stageLabel: { color: COLORS.muted, fontSize: 11 },
  stageLabelActive: { color: COLORS.ink, fontWeight: "700" },
  error: { color: COLORS.error, fontSize: 13, marginTop: 12 },
  block: { marginTop: 18 },
  blockTitle: {
    color: COLORS.ink,
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 8,
  },
  queryLine: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  sourceCard: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: COLORS.panel,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sourceIndex: { color: COLORS.accentBright, fontWeight: "800", fontSize: 13 },
  sourceBody: { flex: 1 },
  sourceTitle: { color: COLORS.ink, fontSize: 14, fontWeight: "700" },
  sourceUrl: { color: COLORS.accentBright, fontSize: 11, marginTop: 2 },
  sourceSnippet: { color: COLORS.muted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  reportActions: { flexDirection: "row", gap: 10, marginTop: 20 },
  actionBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.accent,
  },
  actionText: { color: COLORS.accentBright, fontWeight: "700" },
  pressed: { opacity: 0.7 },
});
