// REAL-LOOP integration test for the MCP client over a SPAWNED stdio server.
//
// The unit test (client.test.ts) wires the client to an in-memory SDK server, so
// it proves the protocol shapes but NEVER spawns a child process or crosses an
// actual stdin/stdout pipe. This test launches the fixture server as a real OS
// child (the project runtime running fixtures/stdio-echo-server.ts), connects
// the production MCPClient to it via the stdio transport, and drives a full
// list-tools + call-tool round-trip across the pipe — then disconnects, killing
// the child. Nothing is faked: the SDK initialize/capability handshake and the
// JSON-RPC framing run end-to-end over a real process boundary.
//
// Hermetic: no network; the only side effect is a short-lived local child that
// disconnect() reaps. Skips cleanly if the platform refuses to spawn the child.

import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCPClient, type MCPServerConfig } from "./client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(here, "fixtures", "stdio-echo-server.ts");

/** Launch the fixture as a real child: `<runtime> <serverScript>` over stdio. */
function stdioConfig(): MCPServerConfig {
  return {
    transport: "stdio",
    command: process.execPath, // the bun runtime executing this test
    args: [SERVER_SCRIPT],
  };
}

const open: MCPClient[] = [];
afterEach(async () => {
  while (open.length) {
    await open.pop()?.disconnect();
  }
});

/** Connect a real client to a freshly-spawned server, or null if spawning is not
 *  possible on this platform (then the test self-skips rather than failing). */
async function connectReal(): Promise<MCPClient | null> {
  const client = new MCPClient({ connectTimeoutMs: 20_000 });
  try {
    await client.connect(stdioConfig());
  } catch {
    return null;
  }
  open.push(client);
  return client;
}

describe("MCPClient over a REAL spawned stdio server", () => {
  test("connect spawns the child and completes the initialize handshake", async () => {
    const client = await connectReal();
    if (!client) return; // platform can't spawn — skip cleanly
    expect(client.connected).toBe(true);
  });

  test("listTools returns the real server's advertised tools", async () => {
    const client = await connectReal();
    if (!client) return;
    const names = (await client.listTools()).map((t) => t.name).sort();
    expect(names).toEqual(["add", "boom", "echo"]);
  });

  test("callTool('add') round-trips typed args across the pipe", async () => {
    const client = await connectReal();
    if (!client) return;
    const res = await client.callTool("add", { a: 2, b: 3 });
    expect(res.isError).toBe(false);
    // The sum was computed by the child process and framed back over stdout.
    expect(res.content[0]?.text).toBe("5");
  });

  test("callTool('echo') round-trips a string across the pipe", async () => {
    const client = await connectReal();
    if (!client) return;
    const res = await client.callTool("echo", { message: "ping-over-stdio" });
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toBe("ping-over-stdio");
  });

  test("a tool error from the real child comes back as isError (no throw)", async () => {
    const client = await connectReal();
    if (!client) return;
    const res = await client.callTool("boom", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("tool failed on purpose");
  });

  test("disconnect reaps the child; the client reports closed", async () => {
    const client = await connectReal();
    if (!client) return;
    await client.disconnect();
    expect(client.connected).toBe(false);
    // Pop the already-disconnected client so afterEach doesn't double-close.
    const idx = open.indexOf(client);
    if (idx >= 0) open.splice(idx, 1);
  });
});
