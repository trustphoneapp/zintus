import type { ProviderId } from "@zintus/types";

import { getGatewayUrl } from "@/lib/gateway-url";

// Same EXPO_PUBLIC_GATEWAY_TOKEN bearer auth as chat.ts / gateway.ts.
const GATEWAY_TOKEN = process.env.EXPO_PUBLIC_GATEWAY_TOKEN?.trim() || "";

function gatewayAuthHeaders(): Record<string, string> {
  return GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {};
}

export interface ResearchSource {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export type ResearchDepth = "quick" | "standard" | "deep";

export interface ResearchEvents {
  /** Planning: the sub-queries the agent will search. */
  onQueries?: (queries: string[]) => void;
  /** Searching/reading: results for one sub-query. */
  onSearchComplete?: (index: number, results: ResearchSource[]) => void;
  /** Synthesizing the final report from N sources. */
  onSynthesizing?: (sourceCount: number) => void;
  /** Streamed final answer (cumulative text). */
  onAnswerChunk?: (cumulativeText: string) => void;
  /** Terminal success: the cited sources. */
  onDone?: (sources: ResearchSource[]) => void;
  onError?: (message: string) => void;
}

interface ResearchFrame {
  type?: string;
  queries?: string[];
  index?: number;
  results?: ResearchSource[];
  sourceCount?: number;
  text?: string;
  sources?: ResearchSource[];
  message?: string;
}

export interface StreamResearchParams {
  query: string;
  depth?: ResearchDepth;
  provider?: ProviderId;
  threadId?: string;
  signal?: AbortSignal;
  events: ResearchEvents;
}

/**
 * Consume the gateway's `POST /v1/research` SSE stream. The gateway frames each
 * stage as `event: <type>\n data: <JSON>\n\n` and ends with `data: [DONE]`; we
 * switch on the JSON payload's own `type`, so the `event:` line is ignored.
 * Requires a Tavily/Serper key configured on the gateway (else it 400s).
 */
export async function streamResearch({
  query,
  depth = "standard",
  provider,
  threadId,
  signal,
  events,
}: StreamResearchParams): Promise<void> {
  const response = await fetch(`${getGatewayUrl()}/v1/research`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify({ query, depth, provider, thread_id: threadId }),
    signal,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      body?.error?.message ?? `Research failed (${response.status})`,
    );
  }
  if (!response.body) {
    throw new Error("Gateway returned no research stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "" || payload === "[DONE]") continue;

      let frame: ResearchFrame;
      try {
        frame = JSON.parse(payload) as ResearchFrame;
      } catch {
        continue;
      }

      switch (frame.type) {
        case "queries":
          events.onQueries?.(frame.queries ?? []);
          break;
        case "search_complete":
          events.onSearchComplete?.(frame.index ?? 0, frame.results ?? []);
          break;
        case "synthesizing":
          events.onSynthesizing?.(frame.sourceCount ?? 0);
          break;
        case "answer_chunk":
          answer += frame.text ?? "";
          events.onAnswerChunk?.(answer);
          break;
        case "done":
          events.onDone?.(frame.sources ?? []);
          break;
        case "error":
          events.onError?.(frame.message ?? "Research error");
          break;
      }
    }
  }
}
