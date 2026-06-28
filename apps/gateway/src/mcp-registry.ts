// =============================================================================
// MCP connection registry — a bounded, reuse-first cache of MCPClient instances.
//
// The gateway HOSTS the MCP clients (the browser can't: no stdio). A single
// physical MCP server (stdio child / SSE / HTTP endpoint) is connected ONCE and
// the live connection is reused across requests, keyed by a stable hash of its
// `MCPServerConfig`. Idle connections are swept after a TTL and `disconnectAll`
// drains them on shutdown.
//
// SECURITY / NO-CUSTODY:
//   * Lives server-side on the loopback gateway only.
//   * A `stdio` config spawns the USER'S OWN local process (their config) — by
//     design, exactly as if they typed it into a shell (see @zintus/mcp's
//     header). We do not sandbox it.
//   * MCP traffic never touches the Zintus relay. This module logs NOTHING about
//     tool args/results — it only manages connection lifecycle.
// =============================================================================

import { createHash } from "node:crypto";
import { MCPClient, type MCPServerConfig } from "@zintus/mcp";

/** Stable, order-insensitive serialization so two equivalent configs hash the
 *  same regardless of object key / env ordering. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * A short, stable id for a server config — used both as the registry cache key
 * AND as the `serverId` namespace segment in tool names (`mcp__<id>__<tool>`).
 * 12 hex chars of a sha-256 over the canonicalized config: collision-safe in
 * practice, contains only `[0-9a-f]` (so it never collides with the `__`
 * separator the tool-name parser splits on), and short enough to leave room
 * under the provider 64-char tool-name limit.
 */
export function configId(config: MCPServerConfig): string {
  return createHash("sha256")
    .update(stableStringify(config))
    .digest("hex")
    .slice(0, 12);
}

interface RegistryEntry {
  client: MCPClient;
  connectedAt: number;
  lastUsed: number;
}

export interface MCPRegistryOptions {
  /** Hard cap on simultaneously-held connections. When reached, the
   *  least-recently-used idle connection is evicted to make room. Default 16. */
  maxServers?: number;
  /** Idle connections older than this (since last use) are swept + disconnected.
   *  Default 5 minutes. */
  idleTtlMs?: number;
  /** How often the idle sweep runs. Default 60s. */
  sweepIntervalMs?: number;
  /** Injectable client factory (tests pass a fake MCPClient). */
  clientFactory?: () => MCPClient;
  /** Injectable clock (tests). */
  now?: () => number;
}

const DEFAULT_MAX_SERVERS = 16;
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Connect-once / reuse cache of MCP clients. `getOrConnect` returns a live,
 * connected client for a config — connecting on first use, sharing an in-flight
 * connect across concurrent callers, and reconnecting transparently if a cached
 * connection has dropped. Connection failures are surfaced (thrown) and never
 * cached; the underlying MCPClient.connect already bounds the handshake with a
 * timeout so this never hangs.
 */
export class MCPRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  /** In-flight connects, so concurrent getOrConnect for the same id share one. */
  private readonly connecting = new Map<string, Promise<MCPClient>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private readonly maxServers: number;
  private readonly idleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly clientFactory: () => MCPClient;
  private readonly now: () => number;

  constructor(options: MCPRegistryOptions = {}) {
    this.maxServers = options.maxServers ?? DEFAULT_MAX_SERVERS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.clientFactory = options.clientFactory ?? (() => new MCPClient());
    this.now = options.now ?? Date.now;
  }

  /** Number of live cached connections (excludes in-flight connects). */
  get size(): number {
    return this.entries.size;
  }

  /** Connection metadata for a config, when currently connected. */
  info(config: MCPServerConfig): { connectedAt: number } | undefined {
    const entry = this.entries.get(configId(config));
    return entry ? { connectedAt: entry.connectedAt } : undefined;
  }

  /**
   * Return a live, connected client for `config`, connecting (and caching) on
   * first use and reusing the live connection thereafter. Concurrent callers for
   * the same config share a single connect. A connect failure is thrown to the
   * caller and is NOT cached (the next call retries cleanly).
   */
  async getOrConnect(config: MCPServerConfig): Promise<MCPClient> {
    const id = configId(config);

    const existing = this.entries.get(id);
    if (existing) {
      if (existing.client.connected) {
        existing.lastUsed = this.now();
        return existing.client;
      }
      // Cached but dead (server crashed / pipe closed): drop and reconnect.
      this.entries.delete(id);
      void existing.client.disconnect().catch(() => {});
    }

    const inflight = this.connecting.get(id);
    if (inflight) {
      return inflight;
    }

    const promise = (async () => {
      // Make room under the cap before holding a new connection.
      if (this.entries.size >= this.maxServers) {
        this.evictLru();
      }
      const client = this.clientFactory();
      await client.connect(config);
      const ts = this.now();
      this.entries.set(id, { client, connectedAt: ts, lastUsed: ts });
      this.ensureSweep();
      return client;
    })();

    this.connecting.set(id, promise);
    try {
      return await promise;
    } finally {
      // Whether it resolved or threw, the in-flight slot is released. A failure
      // leaves no entry cached (we only set on success above).
      this.connecting.delete(id);
    }
  }

  /** Disconnect + evict a single server's connection (idempotent). */
  async disconnect(config: MCPServerConfig): Promise<void> {
    const id = configId(config);
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    this.entries.delete(id);
    await entry.client.disconnect().catch(() => {});
  }

  /** Drain: stop the sweep timer and disconnect every cached connection. Called
   *  on graceful shutdown. */
  async disconnectAll(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const clients = [...this.entries.values()].map((e) => e.client);
    this.entries.clear();
    await Promise.allSettled(clients.map((c) => c.disconnect()));
  }

  // ───────────────────────── internals ─────────────────────────

  /** Disconnect the least-recently-used entry to free a slot under the cap. */
  private evictLru(): void {
    let oldestId: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [id, entry] of this.entries) {
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId) {
      const entry = this.entries.get(oldestId);
      this.entries.delete(oldestId);
      void entry?.client.disconnect().catch(() => {});
    }
  }

  /** Lazily start the idle sweep once there is at least one connection. */
  private ensureSweep(): void {
    if (this.sweepTimer || this.idleTtlMs <= 0 || this.sweepIntervalMs <= 0) {
      return;
    }
    this.sweepTimer = setInterval(() => this.sweepIdle(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Disconnect connections idle longer than the TTL; stop the timer when empty. */
  private sweepIdle(): void {
    const cutoff = this.now() - this.idleTtlMs;
    for (const [id, entry] of [...this.entries]) {
      if (entry.lastUsed <= cutoff) {
        this.entries.delete(id);
        void entry.client.disconnect().catch(() => {});
      }
    }
    if (this.entries.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
