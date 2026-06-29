// =============================================================================
// TEST-ONLY fixture: a minimal, REAL MCP server that speaks the protocol over
// stdio (stdin/stdout), launched as a child process by the stdio integration
// tests. It is NOT part of the shipped surface — nothing imports it at runtime;
// the tests spawn it with the project runtime (`bun <thisFile>`) and connect the
// real @zintus/mcp client to it, exercising the actual SDK handshake +
// JSON-RPC round-trip (no FakeClient, no in-memory shortcut).
//
// It exposes two trivial, deterministic tools:
//   * `add`  — returns a+b as text (proves typed args round-trip both ways).
//   * `echo` — returns the message back (proves a string round-trip).
//   * `boom` — always reports a TOOL error (proves isError flows, not a throw).
//
// Stdout is reserved for the MCP wire protocol (the SDK owns it); this file must
// never console.log to stdout or it would corrupt the framing.
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "zintus-test-stdio", version: "1.0.0" });

server.registerTool(
  "add",
  {
    description: "Add two numbers and return the sum",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

server.registerTool(
  "echo",
  {
    description: "Echo the message back",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({ content: [{ type: "text", text: message }] }),
);

server.registerTool(
  "boom",
  {
    description: "Always reports a tool error",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: "tool failed on purpose" }],
    isError: true,
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
