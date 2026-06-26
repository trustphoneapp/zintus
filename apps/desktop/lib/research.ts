import { resolveGatewayUrl } from "./gateway";

// Mirrors NEXT_PUBLIC_GATEWAY_TOKEN bearer auth used by gateway.ts.
const GATEWAY_TOKEN = process.env.NEXT_PUBLIC_GATEWAY_TOKEN?.trim() || "";

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
  onQueries?: (queries: string[]) => void;
  onSearchComplete?: (index: number, results: ResearchSource[]) => void;
  onSynthesizing?: (sourceCount: number) => void;
  onAnswerChunk?: (cumulativeText: string) => void;
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

/**
 * Consume the gateway's `POST /v1/research` SSE stream (named stages framed as
 * `event:<type>\ndata:<JSON>\n\n`, terminated by `[DONE]`). The React-DOM sibling
 * of the mobile research client so both surfaces speak the same contract.
 * Requires a Tavily/Serper key on the gateway (else it 400s).
 */
export async function streamResearch(params: {
  query: string;
  depth?: ResearchDepth;
  signal?: AbortSignal;
  events: ResearchEvents;
}): Promise<void> {
  const gatewayUrl = await resolveGatewayUrl();
  if (!gatewayUrl) {
    throw new Error(
      "Gateway is unavailable. Start it with `zintus serve` (or set NEXT_PUBLIC_GATEWAY_URL).",
    );
  }

  const response = await fetch(`${gatewayUrl}/v1/research`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify({ query: params.query, depth: params.depth ?? "standard" }),
    signal: params.signal,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `Research failed (${response.status})`);
  }
  if (!response.body) {
    throw new Error("Gateway returned no research stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  for (;;) {
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
          params.events.onQueries?.(frame.queries ?? []);
          break;
        case "search_complete":
          params.events.onSearchComplete?.(frame.index ?? 0, frame.results ?? []);
          break;
        case "synthesizing":
          params.events.onSynthesizing?.(frame.sourceCount ?? 0);
          break;
        case "answer_chunk":
          answer += frame.text ?? "";
          params.events.onAnswerChunk?.(answer);
          break;
        case "done":
          params.events.onDone?.(frame.sources ?? []);
          break;
        case "error":
          params.events.onError?.(frame.message ?? "Research error");
          break;
      }
    }
  }
}
