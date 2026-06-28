"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { MCPServerConfig } from "@zintus/mcp";
import { discoverMcpServer, disconnectMcpServer } from "@/lib/gateway";
import { isGatewayAvailable } from "@/lib/chat-client";
import {
  addMcpServer,
  isToolEnabled,
  loadMcpServers,
  removeMcpServer,
  toggleEnabledTool,
  updateMcpServer,
  type StoredMcpServer,
} from "@/lib/mcp-config";
import { Card, CardContent, CardHeader, CardTitle } from "../../_components/ui/card";

const VIOLET = "#7C3AED";

const mutedStyle: CSSProperties = { color: "var(--color-text-muted)", margin: 0 };

// A couple of well-known servers shown as honest examples in the empty state —
// these are NOT installed for you; they show what a config looks like.
const EXAMPLE_SERVERS: Array<{ name: string; what: string; url: string }> = [
  {
    name: "Filesystem",
    what: "Read and write files in a directory you allow.",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    name: "GitHub",
    what: "Browse repos, issues, and pull requests via the GitHub API.",
    url: "https://github.com/github/github-mcp-server",
  },
];

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

export default function McpSettingsPage() {
  const [servers, setServers] = useState<StoredMcpServer[]>([]);
  const [hydrated, setHydrated] = useState(false);
  // null = unknown (still probing); true/false = gateway reachable or not.
  const [online, setOnline] = useState<boolean | null>(null);

  // Add-server form state.
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");

  // Per-server "Test connection" status.
  const [testing, setTesting] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setServers(loadMcpServers());
    setHydrated(true);
    void isGatewayAvailable().then(setOnline);
  }, []);

  function refresh(next: StoredMcpServer[]) {
    setServers(next);
  }

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
    addMcpServer({
      name: name.trim(),
      config,
      enabled: true,
      enabledTools: "all",
    });
    refresh(loadMcpServers());
    resetForm();
  }

  async function handleTest(server: StoredMcpServer) {
    setTesting((t) => ({ ...t, [server.id]: true }));
    const result = await discoverMcpServer(server.config);
    if ("error" in result) {
      refresh(updateMcpServer(server.id, { lastError: result.error }));
    } else {
      refresh(
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
    refresh(updateMcpServer(server.id, { enabled }));
  }

  function handleToggleTool(server: StoredMcpServer, toolName: string) {
    refresh(
      updateMcpServer(server.id, {
        enabledTools: toggleEnabledTool(server, toolName),
      }),
    );
  }

  function handleRemove(server: StoredMcpServer) {
    if (
      !window.confirm(
        `Remove "${server.name}"? Its config is deleted from this machine.`,
      )
    ) {
      return;
    }
    // Best-effort: ask the gateway to drop any cached connection. Fire-and-forget.
    void disconnectMcpServer(server.config);
    refresh(removeMcpServer(server.id));
  }

  if (!hydrated) {
    return null;
  }

  const offline = online === false;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16, maxWidth: 760 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Link
          href="/settings"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 13,
            color: "var(--color-text-muted)",
            textDecoration: "none",
          }}
        >
          <ArrowLeft size={14} /> Settings
        </Link>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>MCP servers</h1>
        <p style={{ fontSize: 14, color: "var(--color-text-sub)", margin: 0 }}>
          Connect tool servers (Model Context Protocol) so models can use their
          tools in chat. Configs are stored only on this machine — never on a
          server. Your gateway connects and runs the tools; Zintus only shows the
          activity.
        </p>
      </div>

      {offline ? (
        <Card>
          <CardContent>
            <p style={mutedStyle}>
              Your gateway is offline, so servers can&apos;t be tested or run. Start
              it with <code>zintus serve</code>, then reload. You can still edit
              configs here — they live on this machine.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {servers.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>What is MCP?</CardTitle>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={mutedStyle}>
              The Model Context Protocol lets a model call tools from an external
              server — read files, search a database, query an API. The desktop app
              can&apos;t run those servers itself, so Zintus configures them and your
              local gateway connects on your behalf. Nothing is installed for you
              here; you point Zintus at a server and test the connection.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {EXAMPLE_SERVERS.map((ex) => (
                <div key={ex.name} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <a
                    href={ex.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ color: VIOLET, fontWeight: 600 }}
                  >
                    {ex.name}
                  </a>
                  <span style={mutedStyle}>{ex.what}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {servers.map((server) => {
        const isTesting = Boolean(testing[server.id]);
        const toolCount = server.tools?.length ?? 0;
        return (
          <Card key={server.id}>
            <CardContent style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 16 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{server.name}</h2>
                <label className="strategy-option" style={{ cursor: "pointer", margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    onChange={(e) => handleToggleServer(server, e.target.checked)}
                  />
                  <span>
                    <strong>{server.enabled ? "Enabled" : "Disabled"}</strong>
                  </span>
                </label>
              </div>

              <p style={mutedStyle}>
                {server.config.transport === "stdio"
                  ? `Local process · ${server.config.command}${
                      server.config.args?.length
                        ? ` ${server.config.args.join(" ")}`
                        : ""
                    }`
                  : `${server.config.transport.toUpperCase()} · ${server.config.url}`}
              </p>

              {server.lastConnectedAt ? (
                <p style={{ margin: 0, color: VIOLET }}>
                  Connected — {toolCount} {toolCount === 1 ? "tool" : "tools"} available ·{" "}
                  {formatTime(server.lastConnectedAt)}
                </p>
              ) : null}
              {server.lastError ? (
                <p style={{ margin: 0, color: "var(--color-red)" }}>{server.lastError}</p>
              ) : null}

              {toolCount > 0 ? (
                <div className="strategy-list">
                  {server.tools!.map((tool) => (
                    <label key={tool.name} className="strategy-option" style={{ cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={isToolEnabled(server, tool.name)}
                        disabled={!server.enabled}
                        onChange={() => handleToggleTool(server, tool.name)}
                      />
                      <span>
                        <strong>{tool.name}</strong>
                        {tool.description ? <small>{tool.description}</small> : null}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => handleTest(server)}
                  disabled={isTesting || offline}
                  className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-3 text-sm"
                >
                  {isTesting ? "Testing…" : "Test connection"}
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(server)}
                  className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-3 text-sm"
                  style={{ color: "var(--color-red)" }}
                >
                  Remove
                </button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader>
          <CardTitle>Add a server</CardTitle>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Filesystem"
              className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 text-sm"
            />
          </label>

          <div className="strategy-list">
            <label className="strategy-option" style={{ cursor: "pointer" }}>
              <input
                type="radio"
                name="mcp-transport"
                checked={transport === "stdio"}
                onChange={() => setTransport("stdio")}
              />
              <span>
                <strong>stdio (local process)</strong>
                <small>
                  Your gateway runs a local program on your machine and talks to it
                  over its input/output.
                </small>
              </span>
            </label>
            <label className="strategy-option" style={{ cursor: "pointer" }}>
              <input
                type="radio"
                name="mcp-transport"
                checked={transport === "http"}
                onChange={() => setTransport("http")}
              />
              <span>
                <strong>http (streamable)</strong>
                <small>Connect to a server at a URL over HTTP.</small>
              </span>
            </label>
            <label className="strategy-option" style={{ cursor: "pointer" }}>
              <input
                type="radio"
                name="mcp-transport"
                checked={transport === "sse"}
                onChange={() => setTransport("sse")}
              />
              <span>
                <strong>sse</strong>
                <small>Connect to a server at a URL over server-sent events.</small>
              </span>
            </label>
          </div>

          {transport === "stdio" ? (
            <>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Command
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="e.g. npx"
                  className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 text-sm"
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Arguments
                <input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="e.g. -y @modelcontextprotocol/server-filesystem /path"
                  className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 text-sm"
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Environment (optional)
                <textarea
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                  placeholder={"KEY=value, one per line"}
                  rows={2}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-1 text-sm"
                />
              </label>
              <p style={mutedStyle}>
                stdio runs a local process on your machine via your gateway — exactly
                as if you typed the command in a shell.
              </p>
            </>
          ) : (
            <>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                URL
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 text-sm"
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Headers (optional)
                <textarea
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                  placeholder={"Authorization=Bearer …, one per line"}
                  rows={2}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-1 text-sm"
                />
              </label>
              <p style={mutedStyle}>
                {transport.toUpperCase()} connects to a server at a URL via your
                gateway.
              </p>
            </>
          )}

          <button
            type="button"
            onClick={handleAdd}
            disabled={!canAdd}
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-3 text-sm"
            style={{ alignSelf: "flex-start", opacity: canAdd ? 1 : 0.5 }}
          >
            Add server
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
