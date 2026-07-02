import { useCallback, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { PROVIDER_IDS, type ProviderId } from "@zintus/types";
import { PROVIDER_METADATA } from "@zintus/providers";

import { listThreads, type Thread } from "@/lib/history";
import {
  createProject,
  deleteProject,
  listProjects,
  updateProject,
  type Project,
} from "@/lib/projects";
import { COLORS } from "@/lib/theme";

interface FormState {
  id: string | null;
  name: string;
  instructions: string;
  defaultProvider: ProviderId | null;
  privateDefault: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: "",
  instructions: "",
  defaultProvider: null,
  privateDefault: false,
};

export default function ProjectsScreen() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);

  const refresh = useCallback(() => setProjects(listProjects()), []);
  useFocusEffect(useCallback(() => refresh(), [refresh]));

  async function toggleExpand(project: Project) {
    if (expandedId === project.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(project.id);
    setThreads(await listThreads(project.id));
  }

  function save() {
    if (!form) return;
    if (form.id) {
      updateProject(form.id, {
        name: form.name,
        instructions: form.instructions,
        defaultProvider: form.defaultProvider,
        privateDefault: form.privateDefault,
      });
    } else {
      createProject({
        name: form.name,
        instructions: form.instructions,
        defaultProvider: form.defaultProvider,
        privateDefault: form.privateDefault,
      });
    }
    setForm(null);
    refresh();
  }

  function confirmDelete(project: Project) {
    Alert.alert("Delete project", `Delete "${project.name}"? Chats are kept.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteProject(project.id);
          refresh();
        },
      },
    ]);
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.subtitle}>
          Workspaces with shared instructions and routing defaults. A project&apos;s
          instructions are sent as a system message for every chat in it.
        </Text>
        <Pressable
          onPress={() => setForm({ ...EMPTY_FORM })}
          style={({ pressed }) => [styles.newBtn, pressed && styles.pressed]}
        >
          <Text style={styles.newBtnText}>＋ New project</Text>
        </Pressable>

        {projects.length === 0 ? (
          <Text style={styles.empty}>No projects yet.</Text>
        ) : (
          projects.map((project) => (
            <View key={project.id} style={styles.card}>
              <Text style={styles.cardTitle}>{project.name}</Text>
              {project.instructions ? (
                <Text style={styles.cardInstructions} numberOfLines={2}>
                  {project.instructions}
                </Text>
              ) : null}
              <View style={styles.cardMetaRow}>
                {project.defaultProvider ? (
                  <Text style={styles.cardMeta}>{project.defaultProvider}</Text>
                ) : (
                  <Text style={styles.cardMeta}>Auto routing</Text>
                )}
                {project.privateDefault ? (
                  <Text style={[styles.cardMeta, { color: COLORS.good }]}>
                    🛡 Private
                  </Text>
                ) : null}
              </View>
              <View style={styles.cardActions}>
                <Pressable
                  onPress={() =>
                    router.push({ pathname: "/", params: { project: project.id } })
                  }
                  style={({ pressed }) => [styles.primaryAction, pressed && styles.pressed]}
                >
                  <Text style={styles.primaryActionText}>New chat</Text>
                </Pressable>
                <Pressable onPress={() => void toggleExpand(project)} hitSlop={6}>
                  <Text style={styles.action}>Chats</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    setForm({
                      id: project.id,
                      name: project.name,
                      instructions: project.instructions,
                      defaultProvider: project.defaultProvider,
                      privateDefault: project.privateDefault,
                    })
                  }
                  hitSlop={6}
                >
                  <Text style={styles.action}>Edit</Text>
                </Pressable>
                <Pressable onPress={() => confirmDelete(project)} hitSlop={6}>
                  <Text style={[styles.action, { color: COLORS.error }]}>Delete</Text>
                </Pressable>
              </View>

              {expandedId === project.id ? (
                <View style={styles.threadList}>
                  {threads.length === 0 ? (
                    <Text style={styles.empty}>No chats in this project yet.</Text>
                  ) : (
                    threads.map((t) => (
                      <Pressable
                        key={t.id}
                        onPress={() =>
                          router.push({
                            pathname: "/",
                            params: { thread: t.id, project: project.id },
                          })
                        }
                        style={({ pressed }) => [
                          styles.threadRow,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={styles.threadTitle} numberOfLines={1}>
                          {t.title}
                        </Text>
                      </Pressable>
                    ))
                  )}
                </View>
              ) : null}
            </View>
          ))
        )}
      </ScrollView>

      <Modal visible={form != null} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>
                {form?.id ? "Edit project" : "New project"}
              </Text>
              <Text style={styles.label}>Name</Text>
              <TextInput
                style={styles.input}
                value={form?.name}
                onChangeText={(t) => setForm((f) => (f ? { ...f, name: t } : f))}
                placeholder="e.g. Mobile app"
                placeholderTextColor={COLORS.muted}
              />
              <Text style={styles.label}>Instructions (system prompt)</Text>
              <TextInput
                style={[styles.input, styles.multiline]}
                value={form?.instructions}
                onChangeText={(t) =>
                  setForm((f) => (f ? { ...f, instructions: t } : f))
                }
                placeholder="Shared context for every chat in this project…"
                placeholderTextColor={COLORS.muted}
                multiline
              />
              <Text style={styles.label}>Default provider</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.providerRow}>
                  <Pressable
                    onPress={() =>
                      setForm((f) => (f ? { ...f, defaultProvider: null } : f))
                    }
                    style={[
                      styles.providerChip,
                      form?.defaultProvider == null && styles.providerChipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.providerChipText,
                        form?.defaultProvider == null && styles.providerChipTextActive,
                      ]}
                    >
                      Auto
                    </Text>
                  </Pressable>
                  {PROVIDER_IDS.map((id) => (
                    <Pressable
                      key={id}
                      onPress={() =>
                        setForm((f) => (f ? { ...f, defaultProvider: id } : f))
                      }
                      style={[
                        styles.providerChip,
                        form?.defaultProvider === id && styles.providerChipActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.providerChipText,
                          form?.defaultProvider === id && styles.providerChipTextActive,
                        ]}
                      >
                        {PROVIDER_METADATA[id]?.name ?? id}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
              <View style={styles.switchRow}>
                <Text style={styles.label}>Private Mode (block training)</Text>
                <Switch
                  value={form?.privateDefault ?? false}
                  onValueChange={(v) =>
                    setForm((f) => (f ? { ...f, privateDefault: v } : f))
                  }
                />
              </View>
              <View style={styles.modalActions}>
                <Pressable onPress={() => setForm(null)} hitSlop={6}>
                  <Text style={styles.modalCancel}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={save}
                  disabled={!form?.name.trim()}
                  style={({ pressed }) => [
                    styles.modalSave,
                    !form?.name.trim() && styles.pressed,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.modalSaveText}>Save</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.surface },
  content: { padding: 16, gap: 12 },
  subtitle: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  newBtn: {
    borderWidth: 1,
    borderColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
  },
  newBtnText: { color: COLORS.accentBright, fontWeight: "700" },
  empty: { color: COLORS.muted, fontSize: 13, paddingVertical: 8 },
  card: {
    backgroundColor: COLORS.panel,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardTitle: { color: COLORS.ink, fontSize: 16, fontWeight: "700" },
  cardInstructions: { color: COLORS.muted, fontSize: 13, marginTop: 4, lineHeight: 18 },
  cardMetaRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  cardMeta: { color: COLORS.muted, fontSize: 11, textTransform: "capitalize" },
  cardActions: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 12 },
  primaryAction: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  primaryActionText: { color: COLORS.onAccent, fontWeight: "800", fontSize: 13 },
  action: { color: COLORS.accentBright, fontSize: 13, fontWeight: "700" },
  threadList: {
    marginTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    paddingTop: 8,
  },
  threadRow: { paddingVertical: 9 },
  threadTitle: { color: COLORS.ink, fontSize: 14 },
  pressed: { opacity: 0.6 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 18,
    maxHeight: "88%",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalTitle: { color: COLORS.ink, fontSize: 18, fontWeight: "800", marginBottom: 12 },
  label: { color: COLORS.muted, fontSize: 12, fontWeight: "600", marginTop: 12, marginBottom: 6 },
  input: {
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  providerRow: { flexDirection: "row", gap: 8, paddingVertical: 2 },
  providerChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  providerChipActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  providerChipText: { color: COLORS.accentBright, fontSize: 12 },
  providerChipTextActive: { color: COLORS.onAccent, fontWeight: "800" },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 18,
    marginTop: 20,
  },
  modalCancel: { color: COLORS.muted, fontWeight: "700" },
  modalSave: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },
  modalSaveText: { color: COLORS.onAccent, fontWeight: "800" },
});
