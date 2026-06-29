import { useEffect, useMemo, useState } from "react";
import {
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
import { COLORS } from "@/lib/theme";
import {
  artifactAtVersion,
  artifactExtension,
  upsertArtifactVersion,
  type VersionedArtifact,
} from "@/lib/artifacts";

interface Props {
  visible: boolean;
  /** Conversation-wide versioned artifacts (already folded by the caller). */
  artifacts: VersionedArtifact[];
  onClose: () => void;
}

const KIND_LABEL: Record<string, string> = {
  code: "Code",
  html: "HTML",
  svg: "SVG",
  markdown: "Markdown",
};

/**
 * Full-screen artifacts viewer for mobile. Lists the conversation's artifacts
 * with a version switcher (prev/next + "vN of M" + model/your-edit source) and
 * renders the selected version as MONOSPACE SOURCE — there is no iframe on
 * React Native, so HTML/SVG are shown as code and never executed. Copy/Share go
 * through the native share sheet; an in-memory "Save as new version" appends a
 * `user-edit` snapshot (matching web/desktop), kept local to this open session.
 */
export function ArtifactsModal({ visible, artifacts, onClose }: Props) {
  // Local working copy so user edits append versions while the modal is open.
  const [items, setItems] = useState<VersionedArtifact[]>(artifacts);
  const [selected, setSelected] = useState(0);
  const [versionIdx, setVersionIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Reseed from props whenever the modal (re)opens with a fresh set.
  useEffect(() => {
    if (visible) {
      setItems(artifacts);
      setSelected(0);
      setEditing(false);
    }
  }, [visible, artifacts]);

  const current = items.length > 0 ? items[Math.min(selected, items.length - 1)] : undefined;

  // Default each artifact to its latest version when selection changes.
  useEffect(() => {
    if (current) setVersionIdx(current.versions.length - 1);
  }, [selected, current?.id, current?.versions.length]);

  const versionCount = current?.versions.length ?? 0;
  const safeVersionIdx = Math.max(0, Math.min(versionIdx, versionCount - 1));
  const version = current?.versions[safeVersionIdx];
  const view = useMemo(
    () => (current ? artifactAtVersion(current, safeVersionIdx) : null),
    [current, safeVersionIdx],
  );

  async function shareContent() {
    if (!view?.content.trim()) return;
    try {
      await Share.share({ message: view.content });
    } catch {
      // Share sheet dismissed/unavailable — ignore.
    }
  }

  function startEdit() {
    if (!view) return;
    setDraft(view.content);
    setEditing(true);
  }

  function saveAsNewVersion() {
    if (!current) return;
    const next = upsertArtifactVersion(
      current,
      {
        content: draft,
        kind: current.kind,
        language: current.language,
        title: current.title,
      },
      { source: "user-edit" },
    );
    setItems((prev) => prev.map((it) => (it.id === current.id ? next : it)));
    setEditing(false);
    // Jump to the freshly-saved version (latest).
    setVersionIdx(next.versions.length - 1);
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            Artifacts {items.length > 0 ? `(${items.length})` : ""}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            onPress={onClose}
            accessibilityRole="button"
          >
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>

        {items.length === 0 || !current || !view ? (
          <View style={styles.empty}>
            <Text style={styles.emptySub}>No artifacts in this conversation.</Text>
          </View>
        ) : (
          <>
            {/* Artifact picker when there is more than one distinct artifact. */}
            {items.length > 1 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tabBar}
                contentContainerStyle={styles.tabBarContent}
              >
                {items.map((it, i) => (
                  <Pressable
                    key={it.id}
                    style={({ pressed }) => [
                      styles.tab,
                      i === selected && styles.tabActive,
                      pressed && styles.pressed,
                    ]}
                    onPress={() => setSelected(i)}
                  >
                    <Text
                      style={[styles.tabText, i === selected && styles.tabTextActive]}
                      numberOfLines={1}
                    >
                      {it.title}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}

            <View style={styles.metaRow}>
              <Text style={styles.kindBadge}>
                {KIND_LABEL[current.kind] ?? current.kind}
                {view.language && view.language !== current.kind
                  ? ` · ${view.language}`
                  : ""}
                {` · .${artifactExtension(view)}`}
              </Text>
            </View>
            <Text style={styles.title} numberOfLines={2}>
              {current.title}
            </Text>

            {/* Version switcher: prev / "vN of M · source" / next. */}
            <View style={styles.versionRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.stepButton,
                  safeVersionIdx === 0 && styles.stepDisabled,
                  pressed && safeVersionIdx > 0 && styles.pressed,
                ]}
                disabled={safeVersionIdx === 0}
                onPress={() => setVersionIdx(Math.max(0, safeVersionIdx - 1))}
              >
                <Text style={styles.stepText}>‹ Prev</Text>
              </Pressable>
              <View style={styles.versionLabelWrap}>
                <Text style={styles.versionLabel}>
                  {version?.label ?? "v1"} of {versionCount}
                </Text>
                <Text style={styles.versionSource}>
                  {version?.source === "user-edit" ? "your edit" : "model"}
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [
                  styles.stepButton,
                  safeVersionIdx >= versionCount - 1 && styles.stepDisabled,
                  pressed && safeVersionIdx < versionCount - 1 && styles.pressed,
                ]}
                disabled={safeVersionIdx >= versionCount - 1}
                onPress={() =>
                  setVersionIdx(Math.min(versionCount - 1, safeVersionIdx + 1))
                }
              >
                <Text style={styles.stepText}>Next ›</Text>
              </Pressable>
            </View>

            {/* Body: monospace source, or the editor. Never executed. */}
            {editing ? (
              <TextInput
                style={styles.editor}
                value={draft}
                onChangeText={setDraft}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                textAlignVertical="top"
              />
            ) : (
              <ScrollView style={styles.bodyScroll}>
                <ScrollView horizontal showsHorizontalScrollIndicator>
                  <Text style={styles.bodyText} selectable>
                    {view.content}
                  </Text>
                </ScrollView>
              </ScrollView>
            )}

            {/* Actions. */}
            <View style={styles.actions}>
              {editing ? (
                <>
                  <Pressable
                    style={({ pressed }) => [
                      styles.actionButton,
                      pressed && styles.pressed,
                    ]}
                    onPress={() => setEditing(false)}
                  >
                    <Text style={styles.actionText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [
                      styles.actionButton,
                      styles.actionPrimary,
                      pressed && styles.pressed,
                    ]}
                    onPress={saveAsNewVersion}
                  >
                    <Text style={[styles.actionText, styles.actionPrimaryText]}>
                      Save as new version
                    </Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Pressable
                    style={({ pressed }) => [
                      styles.actionButton,
                      pressed && styles.pressed,
                    ]}
                    onPress={() => void shareContent()}
                  >
                    <Text style={styles.actionText}>Copy / Share</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [
                      styles.actionButton,
                      pressed && styles.pressed,
                    ]}
                    onPress={startEdit}
                  >
                    <Text style={styles.actionText}>Edit</Text>
                  </Pressable>
                </>
              )}
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const MONO = Platform.select({ ios: "Menlo", android: "monospace" });

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.surface },
  header: {
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: { color: COLORS.ink, fontSize: 18, fontWeight: "700", flex: 1 },
  closeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  closeText: { color: COLORS.accentBright, fontWeight: "600" },
  pressed: { opacity: 0.7 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptySub: { color: COLORS.muted, fontSize: 14, textAlign: "center" },
  tabBar: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  tabBarContent: { gap: 8, padding: 12, alignItems: "center" },
  tab: {
    backgroundColor: COLORS.panel,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    maxWidth: 180,
  },
  tabActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  tabText: { color: COLORS.accentBright, fontSize: 12 },
  tabTextActive: { color: COLORS.onAccent, fontWeight: "700" },
  metaRow: { paddingHorizontal: 16, paddingTop: 14 },
  kindBadge: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  title: {
    color: COLORS.ink,
    fontSize: 18,
    fontWeight: "700",
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  versionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  stepButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  stepDisabled: { opacity: 0.4 },
  stepText: { color: COLORS.accentBright, fontSize: 13, fontWeight: "600" },
  versionLabelWrap: { alignItems: "center" },
  versionLabel: { color: COLORS.ink, fontSize: 13, fontWeight: "700" },
  versionSource: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
  bodyScroll: {
    flex: 1,
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  bodyText: {
    color: COLORS.ink,
    fontSize: 12,
    lineHeight: 18,
    fontFamily: MONO,
    padding: 12,
  },
  editor: {
    flex: 1,
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.accent,
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    fontSize: 12,
    lineHeight: 18,
    fontFamily: MONO,
    padding: 12,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  actionButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
  },
  actionPrimary: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  actionText: { color: COLORS.accentBright, fontWeight: "600" },
  actionPrimaryText: { color: COLORS.onAccent, fontWeight: "700" },
});
