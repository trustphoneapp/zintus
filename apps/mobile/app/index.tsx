import { useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ProviderId } from "@multipleai/types";
import { deleteProviderKey, getProviderKey, setProviderKey } from "@/lib/secure-keys";

const PROVIDERS: Array<{ id: ProviderId; name: string }> = [
  { id: "cerebras", name: "Cerebras" },
  { id: "groq", name: "Groq" },
  { id: "gemini", name: "Gemini" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "cohere", name: "Cohere" },
  { id: "mistral", name: "Mistral" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "ollama", name: "Ollama" },
];

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export default function ChatScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>("groq");
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<string | null>(null);

  async function saveProviderKey() {
    await setProviderKey(selectedProvider, apiKey);
    setApiKey("");
    setKeyStatus(`Saved ${selectedProvider} key to SecureStore.`);
    setSheetOpen(false);
  }

  async function checkProviderKey() {
    const value = await getProviderKey(selectedProvider);
    setKeyStatus(
      value
        ? `${selectedProvider} key is stored securely.`
        : `No key stored for ${selectedProvider}.`,
    );
  }

  async function removeProviderKey() {
    await deleteProviderKey(selectedProvider);
    setKeyStatus(`Removed ${selectedProvider} key.`);
  }

  function send() {
    if (!input.trim()) {
      return;
    }

    const userMessage: Message = {
      id: `${Date.now()}-user`,
      role: "user",
      content: input.trim(),
    };

    setMessages((current) => [
      ...current,
      userMessage,
      {
        id: `${Date.now()}-assistant`,
        role: "assistant",
        content: `[${selectedProvider}] Mobile chat scaffold — wire to web /api/chat or a backend next.`,
      },
    ]);
    setInput("");
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>MultipleAI</Text>
        <Pressable style={styles.chip} onPress={() => setSheetOpen(true)}>
          <Text style={styles.chipText}>{selectedProvider}</Text>
        </Pressable>
      </View>

      <FlatList
        style={styles.list}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View
            style={[
              styles.bubble,
              item.role === "user" ? styles.userBubble : styles.assistantBubble,
            ]}
          >
            <Text style={styles.bubbleText}>{item.content}</Text>
          </View>
        )}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message..."
          placeholderTextColor="#6b7280"
        />
        <Pressable style={styles.sendButton} onPress={send}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>

      <Modal visible={sheetOpen} animationType="slide" transparent>
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Provider</Text>
            {PROVIDERS.map((provider) => (
              <Pressable
                key={provider.id}
                style={styles.sheetRow}
                onPress={() => setSelectedProvider(provider.id)}
              >
                <Text
                  style={[
                    styles.sheetRowText,
                    selectedProvider === provider.id && styles.sheetRowActive,
                  ]}
                >
                  {provider.name}
                </Text>
              </Pressable>
            ))}
            <TextInput
              style={styles.input}
              value={apiKey}
              onChangeText={setApiKey}
              placeholder="API key"
              placeholderTextColor="#6b7280"
              secureTextEntry
            />
            <Pressable style={styles.sendButton} onPress={saveProviderKey}>
              <Text style={styles.sendText}>Save key</Text>
            </Pressable>
            <Pressable style={styles.secondaryButton} onPress={checkProviderKey}>
              <Text style={styles.secondaryText}>Check key</Text>
            </Pressable>
            <Pressable style={styles.secondaryButton} onPress={removeProviderKey}>
              <Text style={styles.secondaryText}>Remove key</Text>
            </Pressable>
            {keyStatus && <Text style={styles.keyStatus}>{keyStatus}</Text>}
            <Pressable onPress={() => setSheetOpen(false)}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0f14" },
  header: {
    paddingTop: 56,
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: { color: "#e8eef5", fontSize: 22, fontWeight: "700" },
  chip: {
    backgroundColor: "#111827",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: { color: "#67e8f9", textTransform: "capitalize" },
  list: { flex: 1, paddingHorizontal: 16 },
  bubble: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    maxWidth: "85%",
  },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#0ea5e9" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: "#111827" },
  bubbleText: { color: "#e8eef5" },
  composer: {
    flexDirection: "row",
    gap: 8,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: "#1f2937",
  },
  input: {
    flex: 1,
    backgroundColor: "#111827",
    color: "#e8eef5",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sendButton: {
    backgroundColor: "#0ea5e9",
    borderRadius: 10,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  secondaryButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#374151",
    paddingVertical: 10,
    alignItems: "center",
  },
  sendText: { color: "#041018", fontWeight: "700" },
  secondaryText: { color: "#e8eef5" },
  keyStatus: { color: "#9ca3af", fontSize: 13 },
  sheetBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheet: {
    backgroundColor: "#111827",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
  },
  sheetTitle: { color: "#e8eef5", fontSize: 18, fontWeight: "700" },
  sheetRow: { paddingVertical: 10 },
  sheetRowText: { color: "#9ca3af" },
  sheetRowActive: { color: "#67e8f9", fontWeight: "600" },
  closeText: { color: "#67e8f9", textAlign: "center", paddingVertical: 12 },
});
