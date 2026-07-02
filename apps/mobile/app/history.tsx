import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";

import {
  deleteThread,
  listThreads,
  renameThread,
  searchThreads,
  type Thread,
} from "@/lib/history";
import { COLORS } from "@/lib/theme";

/**
 * History (mobile) — the routing ledger. Every thread is a record the router
 * wrote: human title in the UI face, machine annotation (age · provider ·
 * LOCAL) in mono underneath — the same human↔machine split as the Agent
 * console. Records cluster by recency because that is how you actually hunt
 * for an old chat. Storage is on-device sqlite, and the header says so.
 */

const MONO = Platform.select({ ios: "Menlo", android: "monospace" });

const DAY = 86_400_000;

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function bucketFor(ts: number, now: number): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - DAY) return "Yesterday";
  if (ts >= startOfToday - 7 * DAY) return "Previous 7 days";
  return "Earlier";
}

const BUCKET_ORDER = ["Today", "Yesterday", "Previous 7 days", "Earlier"];

export default function HistoryScreen() {
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<Thread | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const refresh = useCallback(async (query: string) => {
    const rows = query.trim()
      ? await searchThreads(query)
      : await listThreads();
    setThreads(rows);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh(search);
    }, [refresh, search]),
  );

  function onSearch(text: string) {
    setSearch(text);
    void refresh(text);
  }

  function continueThread(thread: Thread) {
    router.push({ pathname: "/", params: { thread: thread.id } });
  }

  function confirmDelete(thread: Thread) {
    Alert.alert("Delete chat", `Delete "${thread.title}"? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteThread(thread.id);
          void refresh(search);
        },
      },
    ]);
  }

  function openActions(thread: Thread) {
    Alert.alert(thread.title, undefined, [
      { text: "Rename", onPress: () => openRename(thread) },
      { text: "Delete", style: "destructive", onPress: () => confirmDelete(thread) },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  function openRename(thread: Thread) {
    setRenaming(thread);
    setRenameValue(thread.title);
  }

  async function submitRename() {
    if (renaming) {
      await renameThread(renaming.id, renameValue);
      setRenaming(null);
      void refresh(search);
    }
  }

  // Searching yields a flat result set; browsing clusters by recency.
  const sections = useMemo(() => {
    if (search.trim()) {
      return threads.length > 0 ? [{ title: "Matches", data: threads }] : [];
    }
    const now = Date.now();
    const byBucket = new Map<string, Thread[]>();
    for (const t of threads) {
      const bucket = bucketFor(t.updatedAt, now);
      const list = byBucket.get(bucket);
      if (list) list.push(t);
      else byBucket.set(bucket, [t]);
    }
    return BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => ({
      title: b,
      data: byBucket.get(b)!,
    }));
  }, [threads, search]);

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.search}
        value={search}
        onChangeText={onSearch}
        placeholder="Search chats…"
        placeholderTextColor={COLORS.muted}
        autoCapitalize="none"
      />
      <Text style={styles.ledgerLine}>
        {threads.length} {threads.length === 1 ? "chat" : "chats"} · stored on this
        phone
      </Text>
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={
          sections.length === 0 ? styles.emptyWrap : styles.list
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {search ? "No chats match." : "No saved chats yet. Start one in Chat."}
          </Text>
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => continueThread(item)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <View style={styles.rowMetaLine}>
                <Text style={styles.rowMeta}>
                  {relativeTime(item.updatedAt)}
                  {item.defaultProvider ? ` · ${item.defaultProvider}` : ""}
                </Text>
                {item.privacyPosture === "local-only" ? (
                  <Text style={styles.localBadge}>LOCAL</Text>
                ) : null}
              </View>
            </View>
            <Pressable
              hitSlop={10}
              onPress={() => openActions(item)}
              style={({ pressed }) => [styles.rowAction, pressed && styles.pressed]}
            >
              <Text style={styles.rowActionText}>⋯</Text>
            </Pressable>
          </Pressable>
        )}
      />

      <Modal visible={renaming != null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename chat</Text>
            <TextInput
              style={styles.modalInput}
              value={renameValue}
              onChangeText={setRenameValue}
              autoFocus
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setRenaming(null)} hitSlop={6}>
                <Text style={styles.modalCancel}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void submitRename()}
                style={({ pressed }) => [styles.modalSave, pressed && styles.pressed]}
              >
                <Text style={styles.modalSaveText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.surface },
  search: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 6,
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  ledgerLine: {
    color: COLORS.muted,
    fontFamily: MONO,
    fontSize: 11,
    marginHorizontal: 18,
    marginBottom: 8,
  },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  emptyWrap: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
  empty: { color: COLORS.muted, fontSize: 14, textAlign: "center", padding: 24 },
  sectionHeader: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginTop: 16,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  rowBody: { flex: 1 },
  rowTitle: { color: COLORS.ink, fontSize: 15, fontWeight: "600" },
  rowMetaLine: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 },
  rowMeta: { color: COLORS.muted, fontSize: 11, fontFamily: MONO },
  localBadge: {
    color: COLORS.good,
    borderColor: COLORS.good,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontSize: 9,
    fontFamily: MONO,
    letterSpacing: 0.5,
    overflow: "hidden",
  },
  rowAction: { paddingHorizontal: 8, paddingVertical: 4 },
  rowActionText: { color: COLORS.muted, fontSize: 18, fontWeight: "700" },
  pressed: { opacity: 0.6 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    padding: 28,
  },
  modalCard: {
    backgroundColor: COLORS.panel,
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalTitle: { color: COLORS.ink, fontSize: 16, fontWeight: "800", marginBottom: 12 },
  modalInput: {
    backgroundColor: COLORS.surface,
    color: COLORS.ink,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 18,
    marginTop: 16,
  },
  modalCancel: { color: COLORS.muted, fontWeight: "700" },
  modalSave: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  modalSaveText: { color: COLORS.onAccent, fontWeight: "800" },
});
