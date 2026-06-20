/**
 * GatewaySession — Durable Object relay between a home gateway and mobile clients.
 *
 * Security model:
 *   - Gateway opens an OUTBOUND WebSocket here; no inbound ports on home machine
 *   - First message: { type: "register", gateway_secret } → DO verifies hash
 *   - On success: issues relay_token (1h KV TTL); replies { type: "registered", relay_token }
 *   - Subsequent reconnects: relay_token in Sec-WebSocket-Protocol header
 *   - Mobile accesses via HTTP (status, control, SSE stream) — cookie auth
 *   - Uses WebSocket Hibernation API → DO can sleep while gateway stays connected
 */

import type { Env, WsAttachment } from "./types.js";
import {
  issueRelayToken,
  verifyRelayToken,
  verifyGatewaySecret,
  sha256Hex,
} from "./auth.js";

type RegisterMsg = { type: "register"; gateway_secret: string };
type PingMsg = { type: "ping" };
type StatusMsg = { type: "status"; payload: unknown };
type EventMsg = { type: "event"; event: string; payload: unknown };
type GatewayMsg = RegisterMsg | PingMsg | StatusMsg | EventMsg;

function parseGatewayMsg(raw: string): GatewayMsg | null {
  try {
    return JSON.parse(raw) as GatewayMsg;
  } catch {
    return null;
  }
}

export class GatewaySession {
  private state: DurableObjectState;
  private env: Env;

  // In-memory SSE writers — cleared on hibernation wake (acceptable: SSE
  // keeps the DO alive, so hibernation only occurs when no SSE is active).
  private sseWriters = new Map<
    string,
    ReadableStreamDefaultController<Uint8Array>
  >();

  // Latest status snapshot forwarded from the gateway WebSocket.
  private latestStatus: unknown = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // ── HTTP fetch handler ────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleGatewayWebSocket(request, url);
    }

    const method = request.method;
    const path = url.pathname;

    if (method === "GET" && path === "/status") {
      return this.handleStatus();
    }
    if (method === "POST" && path === "/control") {
      return this.handleControl(request);
    }
    if (method === "GET" && path === "/stream") {
      return this.handleStream(request);
    }
    if (method === "POST" && path === "/offline") {
      return this.markOffline(url.searchParams.get("session_id") ?? "");
    }

    return new Response("Not found", { status: 404 });
  }

  // ── Gateway WebSocket ─────────────────────────────────────────────────────

  private async handleGatewayWebSocket(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const sessionId = url.searchParams.get("session_id");
    if (!sessionId) {
      return new Response("Missing session_id", { status: 400 });
    }

    // Check if a relay_token is presented in the protocol header (reconnect).
    const protocol = request.headers.get("Sec-WebSocket-Protocol") ?? "";
    const relayToken = protocol.startsWith("relay_token.")
      ? protocol.slice("relay_token.".length)
      : null;

    if (relayToken) {
      const verified = await verifyRelayToken(this.env.KV, relayToken);
      if (!verified || verified !== sessionId) {
        return new Response("Invalid or expired relay_token", { status: 403 });
      }
    }
    // If no relay_token, the first message must be { type: "register", gateway_secret }.
    // Authentication is completed in webSocketMessage.

    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];

    const attachment: WsAttachment = {
      session_id: sessionId,
      user_id: "",
      last_seen: Date.now(),
      relay_token_hash: relayToken ? await sha256Hex(relayToken) : null,
    };
    server.serializeAttachment(attachment);

    this.state.acceptWebSocket(server, ["gateway"]);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: relayToken
        ? { "Sec-WebSocket-Protocol": "relay_token." + relayToken }
        : {},
    });
  }

  // ── WebSocket Hibernation callbacks ───────────────────────────────────────

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;
    const attachment = ws.deserializeAttachment() as WsAttachment;
    const msg = parseGatewayMsg(message);
    if (!msg) return;

    if (msg.type === "register") {
      await this.handleRegister(ws, attachment, msg.gateway_secret);
      return;
    }

    // All other messages require prior authentication.
    if (!attachment.relay_token_hash) {
      ws.send(JSON.stringify({ type: "error", error: "Not authenticated" }));
      ws.close(4001, "Unauthenticated");
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      await this.updateLastSeen(attachment.session_id);
      return;
    }

    if (msg.type === "status") {
      this.latestStatus = msg.payload;
      await this.updateLastSeen(attachment.session_id);
      this.broadcastSse(
        "status",
        msg.payload as Record<string, unknown>,
      );
      return;
    }

    if (msg.type === "event") {
      this.broadcastSse(msg.event, msg.payload as Record<string, unknown>);
      return;
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const attachment = ws.deserializeAttachment() as WsAttachment;
    if (attachment?.session_id) {
      await this.markOffline(attachment.session_id);
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const attachment = ws.deserializeAttachment() as WsAttachment | null;
    if (attachment?.session_id) {
      await this.markOffline(attachment.session_id);
    }
    ws.close(1011, "Internal error");
  }

  // ── Register (first-message auth) ────────────────────────────────────────

  private async handleRegister(
    ws: WebSocket,
    attachment: WsAttachment,
    rawSecret: string,
  ): Promise<void> {
    const sessionId = attachment.session_id;

    // Look up stored hash in D1.
    const row = await this.env.DB.prepare(
      "SELECT gateway_secret_hash, user_id FROM gateway_sessions WHERE id = ?",
    )
      .bind(sessionId)
      .first<{ gateway_secret_hash: string; user_id: string }>();

    if (!row) {
      ws.send(JSON.stringify({ type: "error", error: "Session not found" }));
      ws.close(4004, "Session not found");
      return;
    }

    const ok = await verifyGatewaySecret(rawSecret, row.gateway_secret_hash);
    if (!ok) {
      ws.send(JSON.stringify({ type: "error", error: "Invalid gateway_secret" }));
      ws.close(4003, "Unauthorized");
      return;
    }

    const relayToken = await issueRelayToken(this.env.KV, sessionId);
    const tokenHash = await sha256Hex(relayToken);

    const next: WsAttachment = {
      session_id: sessionId,
      user_id: row.user_id,
      last_seen: Date.now(),
      relay_token_hash: tokenHash,
    };
    ws.serializeAttachment(next);

    await this.env.DB.prepare(
      "UPDATE gateway_sessions SET online = 1, last_seen = ? WHERE id = ?",
    )
      .bind(Date.now(), sessionId)
      .run();

    ws.send(JSON.stringify({ type: "registered", relay_token: relayToken }));
    this.broadcastSse("gateway_online", { session_id: sessionId });
  }

  // ── Mobile HTTP handlers ──────────────────────────────────────────────────

  private handleStatus(): Response {
    return new Response(JSON.stringify(this.latestStatus ?? { ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleControl(request: Request): Promise<Response> {
    let body: { action: string; value?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    const gws = this.state.getWebSockets("gateway");
    if (gws.length === 0) {
      return new Response(JSON.stringify({ error: "Gateway offline" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    gws[0]!.send(JSON.stringify({ type: "control", ...body }));
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private handleStream(_request: Request): Response {
    const streamId = crypto.randomUUID();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.sseWriters.set(streamId, controller);
        controller.enqueue(
          encoder.encode(": connected\n\n"),
        );
      },
      cancel: () => {
        this.sseWriters.delete(streamId);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  private broadcastSse(
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const encoder = new TextEncoder();
    const data =
      `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    const chunk = encoder.encode(data);

    for (const [id, ctrl] of this.sseWriters) {
      try {
        ctrl.enqueue(chunk);
      } catch {
        this.sseWriters.delete(id);
      }
    }
  }

  private async markOffline(sessionId: string): Promise<void> {
    if (!sessionId) return;
    await this.env.DB.prepare(
      "UPDATE gateway_sessions SET online = 0 WHERE id = ?",
    )
      .bind(sessionId)
      .run();
    this.broadcastSse("gateway_offline", { session_id: sessionId });
  }

  private async updateLastSeen(sessionId: string): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE gateway_sessions SET last_seen = ? WHERE id = ?",
    )
      .bind(Date.now(), sessionId)
      .run();
  }
}
