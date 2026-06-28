import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "expo-router";
import type { MCPServerConfig } from "@zintus/mcp";
import { discoverMcpServer } from "@/lib/chat";
import {
  addMcpServer,
  loadMcpServers,
  removeMcpServer,
  updateMcpServer,
} from "@/lib/config";
import {
  isToolEnabled,
  toggleEnabledTool,
  type StoredMcpServer,
} from "@/lib/mcp-config";
import { COLORS } from "@/lib/theme";

type Transport = "stdio" | "sse" | "http";

/** Parse a textarea of `KEY=value` lines into a record. Blank lines ignored. */
function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "recently";
  }
}

function describeConfig(config: MCPServerConfig): string {
  if (config.transport === "stdio") {
    const args = config.args?.length ? ` ${config.args.join(" ")}` : "";
    return `Local process · ${config.command}${args}`;
  }
  return `${config.transport.toUpperCase()} · ${config.url}`;
}

export default function McpScreen() {
  const [servers, setServers] = useState<StoredMcpServer[]>([]);
  const [testing, setTesting] = useState<Record<string, boolean>>({});

  // Add-server form state.
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");

  useFocusEffect(
    useCallback(() => {
      setServers(loadMcpServers());
    }, []),
  );

  function resetForm() {
    setName("");
    setTransport("stdio");
    setCommand("");
    setArgs("");
    setEnv("");
    setUrl("");
    setHeaders("");
  }

  function buildConfig(): MCPServerConfig | null {
    if (transport === "stdio") {
      if (!command.trim()) return null;
      const envPairs = parsePairs(env);
      return {
        transport: "stdio",
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/).filter(Boolean) : undefined,
        env: Object.keys(envPairs).length > 0 ? envPairs : undefined,
      };
    }
    if (!url.trim()) return null;
    const headerPairs = parsePairs(headers);
    return {
      transport,
      url: url.trim(),
      headers: Object.keys(headerPairs).length > 0 ? headerPairs : undefined,
    };
  }

  const canAdd =
    name.trim().length > 0 &&
    (transport === "stdio" ? command.trim().length > 0 : url.trim().length > 0);

  function handleAdd() {
    const config = buildConfig();
    if (!config || !name.trim()) return;
    addMcpServer({ name: name.trim(), config, enabled: true, enabledTools: "all" });
    setServers(loadMcpServers());
    resetForm();
  }

  async function handleTest(server: StoredMcpServer) {
    setTesting((t) => ({ ...t, [server.id]: true }));
    const result = await discoverMcpServer(server.config);
    if ("error" in result) {
      setServers(updateMcpServer(server.id, { lastError: result.error }));
    } else {
      setServers(
        updateMcpServer(server.id, {
          tools: result.tools,
          lastConnectedAt: result.connectedAt,
          lastError: undefined,
        }),
      );
    }
    setTesting((t) => ({ ...t, [server.id]: false }));
  }

  function handleToggleServer(server: StoredMcpServer, enabled: boolean) {
    setServers(updateMcpServer(server.id, { enabled }));
  }

  function handleToggleTool(server: StoredMcpServer, toolName: string) {
    setServers(
      updateMcpServer(server.id, {
        enabledTools: toggleEnabledTool(server, toolName),
      }),
    );
  }

  function handleRemove(server: StoredMcpServer) {
    setServers(removeMcpServer(server.id));
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.intro}>
        Connect tool servers (Model Context Protocol) so models can use their
        tools in chat. Configs are stored only on this device — never on a
        server. Your phone can&apos;t run MCP itself: it points your local gateway
        at a server and the gateway connects on your behalf.
      </Text>

      <Text style={styles.sectionTitle}>YOUR SERVERS</Text>
      {servers.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>No servers yet</Text>
          <Text style={styles.muted}>
            Add one below. Nothing is installed for you — you point Zintus at a
            server and test the connection. Examples: the filesystem server
            (read/write files you allow) or the GitHub server (browse repos via
            the API).
          </Text>
        </View>
      ) : null}

      {servers.map((server) => {
        const isTesting = Boolean(testing[server.id]);
        const toolCount = server.tools?.length ?? 0;
        return (
          <View style={styles.card} key={server.id}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>{server.name}</Text>
              <Switch
                value={server.enabled}
                onValueChange={(v) => handleToggleServer(server, v)}
                trackColor={{ true: COLORS.accent, false: COLORS.border }}
                thumbColor={COLORS.ink}
              />
            </View>

            <Text style={styles.muted}>{describeConfig(server.config)}</Text>

            {server.lastConnectedAt ? (
              <Text style={styles.connected}>
                Connected — {toolCount} {toolCount === 1 ? "tool" : "tools"}{" "}
                available · {formatTime(server.lastConnectedAt)}
              </Text>
            ) : null}
            {server.lastError ? (
              <Text style={styles.errorText}>{server.lastError}</Text>
            ) : null}

            {toolCount > 0 ? (
              <View style={styles.toolList}>
                {server.tools!.map((tool) => (
                  <Pressable
                    key={tool.name}
                    style={styles.toolRow}
                    disabled={!server.enabled}
                    onPress={() => handleToggleTool(server, tool.name)}
                  >
                    <Switch
                      value={isToolEnabled(server, tool.name)}
                      disabled={!server.enabled}
                      onValueChange={() => handleToggleTool(server, tool.name)}
                      trackColor={{ true: COLORS.accent, false: COLORS.border }}
                      thumbColor={COLORS.ink}
                    />
                    <View style={styles.toolTextWrap}>
                      <Text style={styles.toolName}>{tool.name}</Text>
                      {tool.description ? (
                        <Text style={styles.muted} numberOfLines={2}>
                          {tool.description}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <View style={styles.actionRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.button,
                  pressed && styles.pressed,
                  isTesting && styles.buttonDisabled,
                ]}
                disabled={isTesting}
                onPress={() => void handleTest(server)}
              >
                {isTesting ? (
                  <ActivityIndicator size="small" color={COLORS.accentBright} />
                ) : (
                  <Text style={styles.buttonText}>Test connection</Text>
                )}
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
                onPress={() => handleRemove(server)}
              >
                <Text style={styles.removeText}>Remove</Text>
              </Pressable>
            </View>
          </View>
        );
      })}

      <Text style={styles.sectionTitle}>ADD A SERVER</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Filesystem"
          placeholderTextColor={COLORS.muted}
          autoCapitalize="none"
        />

        <View style={styles.transportRow}>
          {(["stdio", "http", "sse"] as Transport[]).map((t) => (
            <Pressable
              key={t}
              style={({ pressed }) => [
                styles.chip,
                transport === t && styles.chipActive,
                pressed && styles.pressed,
              ]}
              onPress={() => setTransport(t)}
            >
              <Text
                style={[
                  styles.chipText,
                  transport === t && styles.chipTextActive,
                ]}
              >
                {t}
              </Text>
            </Pressable>
          ))}
        </View>

        {transport === "stdio" ? (
          <>
            <Text style={styles.label}>Command</Text>
            <TextInput
              style={styles.input}
              value={command}
              onChangeText={setCommand}
              placeholder="e.g. npx"
              placeholderTextColor={COLORS.muted}
              autoCapitalize="none"
            />
            <Text style={styles.label}>Arguments</Text>
            <TextInput
              style={styles.input}
              value={args}
              onChangeText={setArgs}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
              placeholderTextColor={COLORS.muted}
              autoCapitalize="none"
            />
            <Text style={styles.label}>Environment (optional)</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={env}
              onChangeText={setEnv}
              placeholder={"KEY=value, one per line"}
              placeholderTextColor={COLORS.muted}
              autoCapitalize="none"
              multiline
            />
            <Text style={styles.helper}>
              stdio runs a local process on YOUR computer via your gateway —
              exactly as if you typed the command in a shell there. The phone
              never runs it.
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.label}>URL</Text>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={setUrl}
              placeholder="https://example.com/mcp"
              placeholderTextColor={COLORS.muted}
              autoCapitalize="none"
              keyboardType="url"
            />
            <Text style={styles.label}>Headers (optional)</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={headers}
              onChangeText={setHeaders}
              placeholder={"Authorization=Bearer …, one per line"}
              placeholderTextColor={COLORS.muted}
              autoCapitalize="none"
              multiline
            />
            <Text style={styles.helper}>
              {transport.toUpperCase()} connects to a server at a URL via your
              gateway.
            </Text>
          </>
        )}

        <Pressable
          style={({ pressed }) => [
            styles.addButton,
            !canAdd && styles.buttonDisabled,
            pressed && canAdd && styles.pressed,
          ]}
          disabled={!canAdd}
          onPress={handleAdd}
        >
          <Text style={styles.addButtonText}>Add server</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.surface },
  content: { padding: 16, gap: 12 },
  intro: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  sectionTitle: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginTop: 8,
  },
  card: {
    backgroundColor: COLORS.panel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 14,
    gap: 8,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTitle: { color: COLORS.ink, fontSize: 16, fontWeight: "700" },
  muted: { color: COLORS.muted, fontSize: 12, lineHeight: 17 },
  connected: { color: COLORS.accentBright, fontSize: 12, fontWeight: "600" },
  errorText: { color: COLORS.error, fontSize: 12 },
  toolList: { gap: 4, marginTop: 4 },
  toolRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  toolTextWrap: { flex: 1 },
  toolName: { color: COLORS.ink, fontSize: 13, fontWeight: "600" },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  button: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 110,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: COLORS.accentBright, fontWeight: "600", fontSize: 13 },
  removeText: { color: COLORS.error, fontWeight: "600", fontSize: 13 },
  pressed: { opacity: 0.7 },
  label: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 4,
  },
  input: {
    backgroundColor: COLORS.surface,
    color: COLORS.ink,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  multiline: { minHeight: 60, textAlignVertical: "top" },
  transportRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  chip: {
    backgroundColor: COLORS.surface,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  chipActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  chipText: { color: COLORS.accentBright, fontSize: 13 },
  chipTextActive: { color: COLORS.onAccent, fontWeight: "700" },
  helper: { color: COLORS.muted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  addButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 8,
  },
  addButtonText: { color: COLORS.onAccent, fontWeight: "700", fontSize: 15 },
});
