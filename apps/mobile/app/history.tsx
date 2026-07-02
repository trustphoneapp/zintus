import { useCallback, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
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

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

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
      <FlatList
        data={threads}
        keyExtractor={(t) => t.id}
        contentContainerStyle={threads.length === 0 ? styles.emptyWrap : styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {search ? "No chats match." : "No saved chats yet. Start one in Chat."}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => continueThread(item)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.rowMeta}>
                {relativeTime(item.updatedAt)}
                {item.defaultProvider ? ` · ${item.defaultProvider}` : ""}
                {item.privacyPosture === "local-only" ? " · 🔒 local" : ""}
              </Text>
            </View>
            <Pressable
              hitSlop={8}
              onPress={() => openRename(item)}
              style={({ pressed }) => [styles.rowAction, pressed && styles.pressed]}
            >
              <Text style={styles.rowActionText}>Rename</Text>
            </Pressable>
            <Pressable
              hitSlop={8}
              onPress={() => confirmDelete(item)}
              style={({ pressed }) => [styles.rowAction, pressed && styles.pressed]}
            >
              <Text style={[styles.rowActionText, { color: COLORS.error }]}>
                Delete
              </Text>
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
    margin: 16,
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  emptyWrap: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
  empty: { color: COLORS.muted, fontSize: 14, textAlign: "center", padding: 24 },
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
  rowMeta: { color: COLORS.muted, fontSize: 12, marginTop: 2 },
  rowAction: { paddingHorizontal: 4 },
  rowActionText: { color: COLORS.accentBright, fontSize: 12, fontWeight: "700" },
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
