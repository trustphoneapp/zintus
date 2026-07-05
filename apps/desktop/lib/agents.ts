import { getGatewayUrl, gatewayAuthHeaders } from "@/lib/gateway";

/**
 * Web client for the gateway-hosted agent runtime (P2): POST a task, stream
 * its SSE events, resolve write/run approvals, stop. Pure fetch/SSE plumbing —
 * exported separately from the page so the parsing is unit-testable.
 */

export interface AgentEvent {
  seq: number;
  ts: number;
  type:
    | "started"
    | "routed"
    | "text"
    | "turn_end"
    | "tool_call"
    | "tool_result"
    | "approval_required"
    | "approval_resolved"
    | "done"
    | "error"
    | "stopped";
  [key: string]: unknown;
}

export interface CreateAgentTask {
  task: string;
  root?: string;
  maxRounds?: number;
  autoApprove?: boolean;
  allowRun?: boolean;
  /** Run allowlisted commands in a hardened Docker container (needs allowRun +
   *  Docker on the gateway host). */
  sandbox?: boolean;
  /** Offer the read-only browser tool (needs Playwright on the gateway host). */
  browse?: boolean;
  /** Explicit provider pin from the model picker; undefined = Auto (router
   *  picks among tool-capable providers). */
  provider?: string;
}

export async function createAgentTask(body: CreateAgentTask): Promise<string> {
  const res = await fetch(`${getGatewayUrl()}/v1/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as
    | { id?: string; error?: { message?: string } }
    | null;
  if (!res.ok || !parsed?.id) {
    throw new Error(parsed?.error?.message ?? `Gateway error ${res.status}`);
  }
  return parsed.id;
}

export interface AgentSummary {
  id: string;
  task: string;
  root: string;
  status: string;
  created_at: number;
  rounds: number;
}

/** P6 — list agent sessions (the gateway recovers non-terminal runs from disk
 *  on startup as status "interrupted"). */
export async function listAgents(): Promise<AgentSummary[]> {
  const res = await fetch(`${getGatewayUrl()}/v1/agents`, {
    headers: gatewayAuthHeaders(),
  });
  const parsed = (await res.json().catch(() => null)) as
    | { agents?: AgentSummary[] }
    | null;
  if (!res.ok || !Array.isArray(parsed?.agents)) return [];
  return parsed.agents;
}

/** P6 — resume an interrupted session from its last round-boundary checkpoint. */
export async function resumeAgent(agentId: string): Promise<void> {
  const res = await fetch(`${getGatewayUrl()}/v1/agents/${agentId}/resume`, {
    method: "POST",
    headers: gatewayAuthHeaders(),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(parsed?.error?.message ?? `Gateway error ${res.status}`);
  }
}

/** P2 — continue a completed session conversationally: same sandbox root, full
 *  prior context; the new exchange's events append to the same SSE backlog. */
export async function followUpAgent(agentId: string, message: string): Promise<void> {
  const res = await fetch(`${getGatewayUrl()}/v1/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(parsed?.error?.message ?? `Gateway error ${res.status}`);
  }
}

export async function resolveApproval(
  agentId: string,
  approvalId: string,
  approved: boolean,
): Promise<void> {
  await fetch(`${getGatewayUrl()}/v1/agents/${agentId}/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify({ approval_id: approvalId, approved }),
  });
}

export async function stopAgent(agentId: string): Promise<void> {
  await fetch(`${getGatewayUrl()}/v1/agents/${agentId}/stop`, {
    method: "POST",
    headers: gatewayAuthHeaders(),
  });
}

/** Parse one SSE line into an AgentEvent (null for non-data / [DONE]). */
export function parseAgentEventLine(line: string): AgentEvent | null {
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice(6).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload) as AgentEvent;
    return typeof parsed.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Stream a task's events (backlog replay + live). Uses fetch-streaming rather
 * than EventSource so the bearer auth header can ride along.
 */
export async function streamAgentEvents(
  agentId: string,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${getGatewayUrl()}/v1/agents/${agentId}/events`, {
    headers: gatewayAuthHeaders(),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Gateway error ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseAgentEventLine(line);
      if (event) onEvent(event);
    }
  }
}
