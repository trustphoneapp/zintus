import { createEngine } from "@multipleai/engine";
import { listProviders } from "@multipleai/providers";
import type { ChatMessage, ProviderId } from "@multipleai/types";
import { DEFAULT_CONFIG } from "@multipleai/types";

const PORT = Number(process.env.GATEWAY_PORT ?? 8788);
const HOST = process.env.GATEWAY_HOST ?? "0.0.0.0";

const engine = createEngine({
  strategy: DEFAULT_CONFIG.routingStrategy,
  providerPriority: DEFAULT_CONFIG.providerPriority,
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function parseMessages(body: {
  messages?: Array<{ role: string; content: string }>;
}): ChatMessage[] {
  if (!body.messages?.length) {
    throw new Error("messages array is required");
  }
  return body.messages.map((message) => {
    if (
      message.role !== "system" &&
      message.role !== "user" &&
      message.role !== "assistant"
    ) {
      throw new Error(`Invalid role: ${message.role}`);
    }
    return {
      role: message.role,
      content: message.content,
    };
  });
}

async function handleChatCompletions(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    messages?: Array<{ role: string; content: string }>;
    model?: string;
    stream?: boolean;
    provider?: ProviderId;
    thread_id?: string;
  };

  const messages = parseMessages(body);
  const result = await engine.routeAndStream({
    messages,
    model: body.model,
    provider: body.provider,
    threadId: body.thread_id,
    stream: body.stream !== false,
  });

  if (body.stream === false) {
    let content = "";
    for await (const chunk of result.stream) {
      content += chunk;
    }
    return json({
      id: result.traceId,
      object: "chat.completion",
      model: result.model,
      provider: result.providerId,
      thread_id: result.threadId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const chunk of result.stream) {
          const payload = {
            id: result.traceId,
            object: "chat.completion.chunk",
            model: result.model,
            provider: result.providerId,
            thread_id: result.threadId,
            choices: [{ index: 0, delta: { content: chunk } }],
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Stream failed";
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: { message } })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (url.pathname === "/health") {
      const statuses = await engine.getProviderStatus();
      return json({
        ok: true,
        providers: statuses.map((status) => ({
          id: status.id,
          available: status.available,
          hasKey: status.hasKey,
        })),
      });
    }

    if (url.pathname === "/v1/models" && request.method === "GET") {
      return json({
        object: "list",
        data: listProviders().map((provider) => ({
          id: provider.id,
          object: "model",
          owned_by: provider.name,
        })),
      });
    }

    if (url.pathname === "/v1/traces/last" && request.method === "GET") {
      return json({ trace: engine.getLastTrace() });
    }

    if (url.pathname.startsWith("/v1/traces/") && request.method === "GET") {
      const traceId = url.pathname.split("/").pop();
      if (!traceId) {
        return json({ error: "trace id required" }, 400);
      }
      const trace = engine.getTrace(traceId);
      if (!trace) {
        return json({ error: "trace not found" }, 404);
      }
      return json({ trace });
    }

    if (url.pathname === "/v1/threads" && request.method === "GET") {
      return json({ threads: engine.listThreads() });
    }

    if (
      url.pathname.startsWith("/v1/threads/") &&
      url.pathname.endsWith("/messages") &&
      request.method === "GET"
    ) {
      const parts = url.pathname.split("/");
      const threadId = parts[3];
      if (!threadId) {
        return json({ error: "thread id required" }, 400);
      }
      return json({ messages: engine.getThreadMessages(threadId) });
    }

    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      try {
        return await handleChatCompletions(request);
      } catch (error) {
        return json(
          {
            error: {
              message:
                error instanceof Error ? error.message : "Request failed",
            },
          },
          400,
        );
      }
    }

    return json({ error: "Not found" }, 404);
  },
});

console.log(
  `MultipleAI gateway listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${server.port}`,
);
