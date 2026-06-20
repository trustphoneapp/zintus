/**
 * Zintus Cloud — outbound gateway-to-relay WebSocket connection.
 *
 * Security model:
 *   - Home machine initiates ALL connections outward (outbound-only)
 *   - No inbound ports open on the home machine
 *   - Keys, API secrets, and routing decisions never leave the home machine
 *   - Only status JSON, control commands, and SSE events flow through relay
 *   - relay_token is kept in memory only — never written to disk
 */

const HEARTBEAT_INTERVAL_MS = 30_000;
const STATUS_PUSH_INTERVAL_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export interface CloudOptions {
  sessionId: string;
  gatewaySecret: string;
  relayUrl: string;
  /** Called to get current gateway status JSON to push to relay. */
  getStatus?: () => Promise<unknown>;
  /** Called when a control message arrives from mobile. */
  onControl?: (action: string, value?: unknown) => Promise<void>;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

export interface CloudConnection {
  /** Stop the cloud connection and clear all timers. */
  close(): void;
}

export function startCloudConnection(opts: CloudOptions): CloudConnection {
  const log = opts.log ?? (() => {});
  let stopped = false;
  let ws: WebSocket | null = null;
  let relayToken: string | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let backoffMs = BACKOFF_BASE_MS;

  function clearTimers(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  async function pushStatus(): Promise<void> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const payload = opts.getStatus ? await opts.getStatus() : {};
      ws.send(JSON.stringify({ type: "status", payload }));
    } catch {
      // non-fatal
    }
  }

  function connect(): void {
    if (stopped) return;

    const baseWsUrl = opts.relayUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");

    const wsUrl = relayToken
      ? `${baseWsUrl}/relay/${opts.sessionId}`
      : `${baseWsUrl}/relay/${opts.sessionId}`;

    const protocols = relayToken ? [`relay_token.${relayToken}`] : [];

    ws = new WebSocket(wsUrl, protocols);

    ws.addEventListener("open", () => {
      backoffMs = BACKOFF_BASE_MS;
      log("info", `cloud: WebSocket open → ${wsUrl}`);

      if (!relayToken) {
        // First connection: authenticate with gateway_secret.
        ws!.send(
          JSON.stringify({
            type: "register",
            gateway_secret: opts.gatewaySecret,
          }),
        );
      } else {
        // Reconnect with existing relay_token — start heartbeat immediately.
        startHeartbeat();
        pushStatus().catch(() => {});
      }
    });

    ws.addEventListener("message", (event) => {
      let msg: { type: string; relay_token?: string; action?: string; value?: unknown; error?: string };
      try {
        msg = JSON.parse(event.data as string) as typeof msg;
      } catch {
        return;
      }

      if (msg.type === "registered" && msg.relay_token) {
        relayToken = msg.relay_token;
        log("info", "cloud: registered ✓ — relay_token received (in memory only)");
        log("info", `cloud: connected to Zintus Cloud — manage at ${opts.relayUrl.replace(/^ws/, "http")}/dashboard`);
        startHeartbeat();
        pushStatus().catch(() => {});
      }

      if (msg.type === "pong") {
        // heartbeat acknowledged
      }

      if (msg.type === "control" && msg.action) {
        opts.onControl?.(msg.action, msg.value)?.catch((error: unknown) => {
          log("warn", `cloud: control handler error: ${String(error)}`);
        });
      }

      if (msg.type === "error") {
        log("error", `cloud: relay error: ${msg.error ?? "unknown"}`);
      }
    });

    ws.addEventListener("close", (event) => {
      clearTimers();
      ws = null;
      if (stopped) return;
      log("warn", `cloud: disconnected (${event.code}) — reconnecting in ${backoffMs}ms`);
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    });

    ws.addEventListener("error", () => {
      log("error", "cloud: WebSocket error");
    });
  }

  function startHeartbeat(): void {
    clearTimers();
    heartbeatTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, HEARTBEAT_INTERVAL_MS);

    statusTimer = setInterval(() => {
      pushStatus().catch(() => {});
    }, STATUS_PUSH_INTERVAL_MS);
  }

  connect();

  return {
    close() {
      stopped = true;
      clearTimers();
      ws?.close(1000, "Gateway shutting down");
      ws = null;
    },
  };
}
