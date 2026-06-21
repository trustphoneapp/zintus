// MIT License — see LICENSE file
import { compress } from "../pipeline/pipeline.js";
import { retrieve } from "../ccr/retrieve.js";
import type { CompressContext } from "../pipeline/types.js";

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

interface MCPRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS: MCPTool[] = [
  {
    name: "compress",
    description: "Compress LLM context messages to reduce token usage",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Text content to compress" },
        provider: { type: "string", description: "LLM provider: anthropic | openai | gemini | groq" },
        model: { type: "string", description: "Model identifier" },
        tokenBudget: { type: "number", description: "Target token count" },
      },
      required: ["content"],
    },
  },
  {
    name: "retrieve",
    description: "Retrieve compressed content by CCR hash",
    inputSchema: {
      type: "object",
      properties: {
        hash: { type: "string", description: "CCR hash from a compressed content marker" },
        query: { type: "string", description: "Optional search query for relevant subset" },
      },
      required: ["hash"],
    },
  },
  {
    name: "stats",
    description: "Get compression statistics for the current session",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

let totalOriginalTokens = 0;
let totalCompressedTokens = 0;
let cacheHits = 0;
let totalRequests = 0;
const contentTypeCounts: Record<string, number> = {};

async function handleTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "compress") {
    const content = String(args["content"] ?? "");
    const ctx: CompressContext = {
      provider: (args["provider"] as CompressContext["provider"]) ?? "generic",
      model: String(args["model"] ?? "unknown"),
      tokenBudget: args["tokenBudget"] as number | undefined,
    };
    const result = await compress(
      { messages: [{ role: "assistant", content }] },
      ctx,
    );
    const r = result.totalResult;
    totalOriginalTokens += r.originalTokens;
    totalCompressedTokens += r.compressedTokens;
    if (r.cacheHit) cacheHits++;
    totalRequests++;
    return result;
  }

  if (name === "retrieve") {
    const hash = String(args["hash"] ?? "");
    const query = args["query"] !== undefined ? String(args["query"]) : undefined;
    const content = retrieve(hash, query);
    return { hash, found: Boolean(content), content };
  }

  if (name === "stats") {
    const savedTokens = Math.max(0, totalOriginalTokens - totalCompressedTokens);
    const avgRatio = totalOriginalTokens === 0 ? 1 : totalCompressedTokens / totalOriginalTokens;
    return {
      totalCompressed: totalRequests,
      tokensSaved: savedTokens,
      hitRate: totalRequests === 0 ? 0 : cacheHits / totalRequests,
      topContentTypes: Object.entries(contentTypeCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([type, count]) => ({ type, count })),
      compressionRatio: avgRatio,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function respond(id: number | string, result: unknown): MCPResponse {
  return { jsonrpc: "2.0", id, result };
}

function error(id: number | string, code: number, message: string): MCPResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Start MCP server reading JSON-RPC from stdin, writing to stdout. */
export async function startMCPServer(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const writer = Bun.stdout.writer();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);

    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let req: MCPRequest;
      try {
        req = JSON.parse(line) as MCPRequest;
      } catch {
        continue;
      }

      let resp: MCPResponse;
      try {
        if (req.method === "initialize") {
          resp = respond(req.id, {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "tokzen", version: "0.1.0" },
            capabilities: { tools: {} },
          });
        } else if (req.method === "tools/list") {
          resp = respond(req.id, { tools: TOOLS });
        } else if (req.method === "tools/call") {
          const toolName = req.params?.name ?? "";
          const toolArgs = req.params?.arguments ?? {};
          const result = await handleTool(toolName, toolArgs);
          resp = respond(req.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
        } else {
          resp = error(req.id, -32601, `Method not found: ${req.method}`);
        }
      } catch (e) {
        resp = error(req.id, -32603, String(e));
      }

      writer.write(JSON.stringify(resp) + "\n");
      writer.flush();
    }
  }
}

if (import.meta.main) {
  await startMCPServer();
}
