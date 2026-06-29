// REAL-LOOP integration test for the gateway's SERVER-SIDE MCP tool path.
//
// mcp-bridge.test.ts proves the bridge against a hand-written FakeClient — it
// never connects to anything ("no real connection"). This test drives the exact
// same production seam (executeMcpToolCall + a real MCPRegistry whose default
// clientFactory builds a real @zintus/mcp MCPClient) against a REAL MCP server
// spawned over stdio. So the round-trip exercised here is:
//
//   namespaced tool_call  ->  parseMcpToolName  ->  MCPRegistry.getOrConnect
//   (spawns + connects a real child)  ->  MCPClient.callTool over stdio  ->
//   real child computes the result  ->  mcpResultToText  ->  tool_result block
//
// No FakeClient, no injected result. The assertion ("5", "hi", isError) is the
// child process's real output framed back across the pipe and mapped by the
// bridge. Hermetic: no network; disconnectAll() reaps the child.

import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MCPServerConfig } from "@zintus/mcp";
import type { ToolCallContentBlock } from "@zintus/types";
import { executeMcpToolCall, mcpToolsToDefinitions } from "./mcp-bridge.js";
import { MCPRegistry, configId } from "./mcp-registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/gateway/src -> repo root -> packages/mcp/src/fixtures/...
const SERVER_SCRIPT = path.resolve(
  here,
  "../../../packages/mcp/src/fixtures/stdio-echo-server.ts",
);

const STDIO: MCPServerConfig = {
  transport: "stdio",
  command: process.execPath,
  args: [SERVER_SCRIPT],
};
const SERVER_ID = configId(STDIO);
const configsById = new Map<string, MCPServerConfig>([[SERVER_ID, STDIO]]);

function call(tool: string, args: Record<string, unknown>): ToolCallContentBlock {
  return {
    type: "tool_call",
    id: `c_${tool}`,
    name: `mcp__${SERVER_ID}__${tool}`,
    arguments: args,
  };
}

// A real registry (default clientFactory => real MCPClient). No sweep timer so
// the test never leaves a handle open.
let registry: MCPRegistry;
afterEach(async () => {
  await registry?.disconnectAll();
});

describe("gateway MCP bridge over a REAL spawned stdio server", () => {
  test("lists + namespaces the real server's tools end-to-end", async () => {
    registry = new MCPRegistry({ sweepIntervalMs: 0 });
    const client = await registry.getOrConnect(STDIO);
    const defs = mcpToolsToDefinitions(SERVER_ID, await client.listTools());
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual([
      `mcp__${SERVER_ID}__add`,
      `mcp__${SERVER_ID}__boom`,
      `mcp__${SERVER_ID}__echo`,
    ]);
  });

  test("executeMcpToolCall drives a real round-trip and maps the result", async () => {
    registry = new MCPRegistry({ sweepIntervalMs: 0 });
    const res = await executeMcpToolCall(registry, configsById, call("add", { a: 2, b: 3 }));
    expect(res.isError).toBe(false);
    expect(res.content).toBe("5"); // computed by the spawned child, not a fake
    expect(res.toolCallId).toBe("c_add");
  });

  test("a real string round-trip through the bridge", async () => {
    registry = new MCPRegistry({ sweepIntervalMs: 0 });
    const res = await executeMcpToolCall(registry, configsById, call("echo", { message: "hi" }));
    expect(res.isError).toBe(false);
    expect(res.content).toBe("hi");
  });

  test("a real TOOL error becomes an honest isError tool_result (no throw)", async () => {
    registry = new MCPRegistry({ sweepIntervalMs: 0 });
    const res = await executeMcpToolCall(registry, configsById, call("boom", {}));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("tool failed on purpose");
  });

  test("the registry reuses ONE real connection across calls", async () => {
    registry = new MCPRegistry({ sweepIntervalMs: 0 });
    const a = await executeMcpToolCall(registry, configsById, call("add", { a: 1, b: 1 }));
    const b = await executeMcpToolCall(registry, configsById, call("add", { a: 4, b: 5 }));
    expect(a.content).toBe("2");
    expect(b.content).toBe("9");
    // Both calls hit the same cached, live child connection.
    expect(registry.size).toBe(1);
  });
});
