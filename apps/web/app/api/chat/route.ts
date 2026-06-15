import type { ProviderId } from "@multipleai/types";
import { streamChat } from "@/lib/chat.server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
      provider?: ProviderId;
      apiKeys?: Partial<Record<ProviderId, string>>;
      settings?: {
        routingStrategy?: "fastest" | "capability" | "economy";
        defaultProvider?: ProviderId;
        providerPriority?: ProviderId[];
      };
    };

    const result = await streamChat(body);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of result.stream) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Provider-Id": result.providerId,
        "X-Model": result.model,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat request failed";
    return new Response(message, { status: 500 });
  }
}
