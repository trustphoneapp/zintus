import type { MCPServerConfig, MCPTool } from "@zintus/mcp";

// Storage key for the persisted server list (MMKV in the app; an injected fake in
// tests — see lib/config.ts for the MMKV-bound wrappers).
export const MCP_STORAGE_KEY = "zintus:mcp-servers";

/**
 * The slice of MMKV's API the MCP CRUD needs. Abstracted so the pure logic is
 * unit-testable under bun (which can't load react-native-mmkv): tests pass an
 * in-memory map, the app passes the real MMKV instance from lib/config.ts. This
 * is why the CRUD lives here (RN-free) and the MMKV binding lives in config.ts.
 */
export interface McpStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
}

/**
 * One MCP server as the user configured it, persisted on THIS device only
 * (MMKV, no custody — mirrors the web's localStorage record).
 *
 * The phone CANNOT host MCP: it stores the config and asks the user's local
 * gateway to test/discover/run the server. `tools` caches what the last
 * successful Test connection discovered, so the tool list survives relaunches.
 */
export interface StoredMcpServer {
  id: string;
  name: string;
  config: MCPServerConfig;
  /** Whether this server's tools are offered to the model at all. */
  enabled: boolean;
  /** Which tools are active: `"all"` (the default) or an explicit allow-list of
   *  tool names. A name not present in the server's discovered tools is ignored. */
  enabledTools: string[] | "all";
  /** Tools discovered by the last successful Test connection (display + filter). */
  tools?: MCPTool[];
  /** Epoch ms of the last successful connection. */
  lastConnectedAt?: number;
  /** Honest message from the last failed connection (cleared on success). */
  lastError?: string;
}

/** Generate a stable id for a new server. Uses crypto.randomUUID when present
 *  (RN has it via react-native-get-random-values), else a time+random token so
 *  it also works in bun tests. */
export function newServerId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the manual token
  }
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Load all stored servers. Never throws: bad/absent JSON yields `[]`. */
export function loadMcpServers(storage: McpStorage): StoredMcpServer[] {
  try {
    const raw = storage.getString(MCP_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    // Drop entries that aren't shaped like a server so a corrupt write can't
    // crash the screen; we keep only the well-formed ones.
    return parsed.filter(
      (entry): entry is StoredMcpServer =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof (entry as StoredMcpServer).id === "string" &&
        typeof (entry as StoredMcpServer).name === "string" &&
        Boolean((entry as StoredMcpServer).config),
    );
  } catch {
    return [];
  }
}

/** Persist the full list. Swallows serialization/quota failures (local cache). */
export function saveMcpServers(
  storage: McpStorage,
  servers: StoredMcpServer[],
): void {
  try {
    storage.set(MCP_STORAGE_KEY, JSON.stringify(servers));
  } catch {
    // Drop silently; this is a local cache, not custody.
  }
}

/** Append a new server (assigning an id when absent) and persist. Returns the
 *  stored record so the caller can reference its id. */
export function addMcpServer(
  storage: McpStorage,
  draft: Omit<StoredMcpServer, "id"> & { id?: string },
): StoredMcpServer {
  const server: StoredMcpServer = { ...draft, id: draft.id ?? newServerId() };
  saveMcpServers(storage, [...loadMcpServers(storage), server]);
  return server;
}

/** Merge `patch` into the server with `id` and persist. Returns the updated list. */
export function updateMcpServer(
  storage: McpStorage,
  id: string,
  patch: Partial<Omit<StoredMcpServer, "id">>,
): StoredMcpServer[] {
  const next = loadMcpServers(storage).map((server) =>
    server.id === id ? { ...server, ...patch } : server,
  );
  saveMcpServers(storage, next);
  return next;
}

/** Remove the server with `id` and persist. Returns the updated list. */
export function removeMcpServer(
  storage: McpStorage,
  id: string,
): StoredMcpServer[] {
  const next = loadMcpServers(storage).filter((server) => server.id !== id);
  saveMcpServers(storage, next);
  return next;
}

/** True when a server's tool is active given its enabledTools setting. */
export function isToolEnabled(server: StoredMcpServer, toolName: string): boolean {
  if (!server.enabled) {
    return false;
  }
  return server.enabledTools === "all" || server.enabledTools.includes(toolName);
}

/**
 * Toggle one tool on/off in a server's `enabledTools`, normalizing the `"all"`
 * sentinel into a concrete list when the user first deselects something. Pure —
 * returns the next `enabledTools` value (the caller persists it).
 */
export function toggleEnabledTool(
  server: StoredMcpServer,
  toolName: string,
): string[] | "all" {
  const allNames = (server.tools ?? []).map((t) => t.name);
  // Expand "all" into the concrete set so we can remove a single tool from it.
  const current = server.enabledTools === "all" ? allNames : server.enabledTools;
  const next = current.includes(toolName)
    ? current.filter((n) => n !== toolName)
    : [...current, toolName];
  // Collapse back to "all" when every discovered tool is selected again.
  if (allNames.length > 0 && next.length === allNames.length) {
    return "all";
  }
  return next;
}

/** The `mcp` field a chat request attaches: only enabled servers, each with the
 *  concrete list of tools the model may call. Mirrors web's `ActiveMcpServer`. */
export interface ActiveMcpServer {
  id: string;
  name: string;
  config: MCPServerConfig;
  /** Concrete tool names allowed for this server (never the `"all"` sentinel). */
  enabledTools: string[];
}

/**
 * Build the active-server payload for the chat request from stored servers.
 * Only `enabled` servers are included; `enabledTools` is resolved against the
 * server's discovered tools so `"all"` becomes the concrete list (and an enabled
 * server with no discovered tools yet contributes an empty list). Pure +
 * exported so the chat screen and tests share one source of truth.
 */
export function activeMcpServersForChat(stored: StoredMcpServer[]): {
  servers: ActiveMcpServer[];
} {
  const servers = stored
    .filter((server) => server.enabled)
    .map((server) => {
      const allNames = (server.tools ?? []).map((t) => t.name);
      const enabledTools =
        server.enabledTools === "all"
          ? allNames
          : server.enabledTools.filter((name) => allNames.includes(name));
      return {
        id: server.id,
        name: server.name,
        config: server.config,
        enabledTools,
      };
    });
  return { servers };
}
