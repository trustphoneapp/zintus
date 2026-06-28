// =============================================================================
// MCP (Model Context Protocol) client core for Zintus.
//
// SECURITY / TRUST MODEL — READ THIS.
//
//   * This module runs SERVER-SIDE ONLY (Bun / Node). It is hosted by the local
//     loopback gateway and is NEVER bundled into the browser. The stdio
//     transport spawns a child process (via the SDK's StdioClientTransport),
//     which the DOM cannot do.
//
//   * The `stdio` transport launches a LOCAL process described by user config
//     (`command` + `args` + `env`). That is by design: it is the user running a
//     program on their OWN machine, exactly as if they had typed it into a
//     shell. We do not sandbox it and we do not second-guess the command — the
//     gateway surfaces the config to the user; the choice is theirs. Callers
//     MUST only pass commands that originate from the user's own configuration.
//
//   * No-custody / local-first: MCP traffic flows gateway <-> server and
//     gateway <-> LLM only. Nothing here touches the Zintus relay.
//
//   * Privacy: tool arguments and tool results may contain secrets (file
//     contents, tokens, query text). We NEVER log them verbatim. There is no
//     telemetry. The only thing this module emits is what the caller explicitly
//     asks for via return values.
//
// We wrap the official reference SDK (@modelcontextprotocol/sdk) — we do not
// hand-roll JSON-RPC. The SDK owns the wire protocol and the initialize /
// capability handshake; this file owns Zintus's normalized shapes, timeouts,
// and lifecycle guards.
// =============================================================================

import type { JsonSchema } from "@zintus/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// ---------------------------------------------------------------------------
// Public, Zintus-normalized shapes. These deliberately do NOT leak SDK types so
// the rest of the codebase depends on a stable surface, not the SDK version.
// ---------------------------------------------------------------------------

/** A tool advertised by an MCP server, normalized to Zintus shapes. */
export interface MCPTool {
  name: string;
  description: string;
  /** Object JSON Schema for the tool input (re-using @zintus/types). */
  inputSchema: JsonSchema;
}

/** A resource advertised by an MCP server (a readable URI). */
export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** A prompt template advertised by an MCP server. */
export interface MCPPrompt {
  name: string;
  description?: string;
  arguments: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** A single block of tool-call output. `type` is "text" | "image" | "audio" |
 *  "resource" | "resource_link"; only the fields relevant to that type are set. */
export interface MCPContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/** The result of a tool call. `isError` is true when the TOOL reported a failure
 *  (e.g. a bad path, an API 404). This is NOT a transport failure — see callTool. */
export interface MCPResult {
  content: MCPContentBlock[];
  isError: boolean;
}

/** How to reach an MCP server. Discriminated on `transport`.
 *
 *  - `stdio`  : spawn a local process and speak MCP over its stdin/stdout.
 *  - `sse`    : connect to a remote server over the (legacy) HTTP+SSE transport.
 *  - `http`   : connect to a remote server over the Streamable HTTP transport
 *               (the newer spec); `url` points at the single MCP endpoint. */
export type MCPServerConfig =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      transport: "sse";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      transport: "http";
      url: string;
      headers?: Record<string, string>;
    };

export interface MCPClientOptions {
  /** Connection + handshake timeout, in milliseconds. Default 10_000. */
  connectTimeoutMs?: number;
  /** Identity reported to the server during initialize. */
  clientName?: string;
  clientVersion?: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Thrown only on transport / connection failure (spawn failed, server crashed,
 *  handshake timed out, network unreachable). Tool-level failures do NOT throw —
 *  they come back as `{ isError: true }`. */
export class MCPConnectionError extends Error {
  override name = "MCPConnectionError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * A connected client for a single MCP server.
 *
 * Lifecycle: construct -> connect(config) -> list/callTool -> disconnect().
 * A single instance owns one server connection; create one per server.
 */
export class MCPClient {
  private readonly opts: Required<MCPClientOptions>;
  private client: Client | null = null;
  /** Set by the transport's onclose hook; lets callTool tell a dropped
   *  connection (throw) apart from a tool that reported an error (don't throw). */
  private transportClosed = false;
  private connecting = false;

  constructor(options: MCPClientOptions = {}) {
    this.opts = {
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      clientName: options.clientName ?? "zintus",
      clientVersion: options.clientVersion ?? "0.0.1",
    };
  }

  /** True once {@link connect} has completed and the connection is still live. */
  get connected(): boolean {
    return this.client !== null && !this.transportClosed;
  }

  /**
   * Connect to `config` over the right transport and run the SDK's
   * initialize / capability handshake. Guards against double-connect and
   * against a hung transport (rejects after `connectTimeoutMs`).
   *
   * @throws {MCPConnectionError} on spawn failure, unreachable server, or timeout.
   */
  async connect(config: MCPServerConfig): Promise<void> {
    if (this.client) {
      throw new MCPConnectionError(
        "MCPClient is already connected; create a new instance per server.",
      );
    }
    if (this.connecting) {
      throw new MCPConnectionError("MCPClient is already connecting.");
    }
    this.connecting = true;

    try {
      const transport = this.createTransport(config);
      transport.onclose = () => {
        this.transportClosed = true;
      };

      const client = new Client(
        { name: this.opts.clientName, version: this.opts.clientVersion },
        // We accept tools/resources/prompts; capabilities advertised here are
        // the *client's*. The server's capabilities arrive in the handshake.
        { capabilities: {} },
      );

      // Race the SDK connect (transport.start + initialize) against a wall-clock
      // timeout so a server that never answers can't hang the gateway forever.
      // The SDK's RequestOptions.timeout only covers the initialize *request*,
      // not the transport opening, so we guard both with our own timer.
      await this.withTimeout(
        client.connect(transport, { timeout: this.opts.connectTimeoutMs }),
        `Timed out connecting to MCP server (${this.opts.connectTimeoutMs}ms)`,
        // On timeout, close the half-open transport so a spawned child can't leak.
        async () => {
          try {
            await transport.close();
          } catch {
            /* best-effort */
          }
        },
      );

      this.client = client;
      this.transportClosed = false;
    } catch (err) {
      this.client = null;
      throw asConnectionError(err, "Failed to connect to MCP server");
    } finally {
      this.connecting = false;
    }
  }

  /** List the server's tools, normalized. Empty array if the server advertises
   *  no `tools` capability (never throws for a missing capability). */
  async listTools(): Promise<MCPTool[]> {
    const client = this.requireClient();
    if (!client.getServerCapabilities()?.tools) return [];
    const res = await this.guarded(
      () => client.listTools(),
      "list tools",
    );
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? { type: "object" }) as JsonSchema,
    }));
  }

  /** List the server's resources, normalized. Empty array if unsupported. */
  async listResources(): Promise<MCPResource[]> {
    const client = this.requireClient();
    if (!client.getServerCapabilities()?.resources) return [];
    const res = await this.guarded(
      () => client.listResources(),
      "list resources",
    );
    return res.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  /** List the server's prompts, normalized. Empty array if unsupported. */
  async listPrompts(): Promise<MCPPrompt[]> {
    const client = this.requireClient();
    if (!client.getServerCapabilities()?.prompts) return [];
    const res = await this.guarded(
      () => client.listPrompts(),
      "list prompts",
    );
    return res.prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: (p.arguments ?? []).map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required,
      })),
    }));
  }

  /**
   * Call a tool by name. Returns its result normalized to {@link MCPResult}.
   *
   * Error policy (important): a TOOL that fails — bad input, a 404, a thrown
   * exception inside the server's handler — comes back as
   * `{ isError: true, content: [...] }`. This method does NOT throw for that.
   * It throws (MCPConnectionError) ONLY when the transport / connection itself
   * has failed (server crashed, pipe closed). That distinction lets the caller
   * feed a tool error straight back to the model while still treating a dead
   * server as fatal.
   *
   * NB: `args` may contain secrets. They are passed straight to the server and
   * are never logged by this module.
   */
  async callTool(name: string, args: unknown): Promise<MCPResult> {
    const client = this.requireClient();
    try {
      const res = await client.callTool({
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      });
      // The legacy `{ toolResult }` shape has no `content` — normalize it.
      const content = Array.isArray(res.content)
        ? (res.content as MCPContentBlock[])
        : [];
      return { content, isError: res.isError === true };
    } catch (err) {
      // If the transport dropped, this is fatal — surface it as a connection
      // error. Otherwise it's a protocol/tool-level error (e.g. unknown tool):
      // honor "never throw on a tool error" and return isError instead.
      if (this.transportClosed || isConnectionLevelError(err)) {
        throw asConnectionError(
          err,
          `MCP server connection lost while calling tool "${name}"`,
        );
      }
      return {
        content: [{ type: "text", text: errorMessage(err) }],
        isError: true,
      };
    }
  }

  /** Close the transport (and kill the stdio child, if any). Idempotent. */
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.close();
    } catch {
      // Already-dead transports throw on close; disconnect must stay clean.
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private createTransport(config: MCPServerConfig): Transport {
    switch (config.transport) {
      case "stdio":
        // Spawns a LOCAL child process from user config — see header.
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          // Surface the child's stderr to the host's stderr so a misconfigured
          // command is debuggable, without us capturing/logging tool I/O.
          stderr: "inherit",
        });
      case "sse": {
        const url = new URL(config.url);
        return new SSEClientTransport(url, {
          requestInit: config.headers ? { headers: config.headers } : undefined,
          // SSE's opening GET is an EventSource, not a fetch, so headers set on
          // requestInit (which covers POSTs) won't reach it. Inject them via a
          // custom fetch on the EventSource init.
          eventSourceInit: config.headers
            ? {
                fetch: (input: string | URL, init?: RequestInit) =>
                  fetch(input, {
                    ...init,
                    headers: { ...init?.headers, ...config.headers },
                  }),
              }
            : undefined,
        });
      }
      case "http": {
        const url = new URL(config.url);
        return new StreamableHTTPClientTransport(url, {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        });
      }
    }
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new MCPConnectionError("MCPClient is not connected; call connect() first.");
    }
    if (this.transportClosed) {
      throw new MCPConnectionError("MCP server connection is closed.");
    }
    return this.client;
  }

  /** Run a list call, translating any failure into a clear connection error. */
  private async guarded<T>(fn: () => Promise<T>, what: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw asConnectionError(err, `Failed to ${what} from MCP server`);
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    message: string,
    onTimeout?: () => void | Promise<void>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void onTimeout?.();
        reject(new MCPConnectionError(message));
      }, this.opts.connectTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// error helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "Unknown error";
}

/** Heuristic: does this error mean the connection itself is gone (vs a normal
 *  protocol/tool error we should fold into isError)? */
function isConnectionLevelError(err: unknown): boolean {
  // SDK ConnectionClosed JSON-RPC code.
  const code = (err as { code?: unknown })?.code;
  if (code === -32000) return true;
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes("connection closed") ||
    msg.includes("not connected") ||
    msg.includes("transport closed") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up")
  );
}

function asConnectionError(err: unknown, context: string): MCPConnectionError {
  if (err instanceof MCPConnectionError) return err;
  return new MCPConnectionError(`${context}: ${errorMessage(err)}`, {
    cause: err,
  });
}
