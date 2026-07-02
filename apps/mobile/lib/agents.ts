import { getGatewayUrl } from "./gateway-url";
import {
  parseAgentEventLine,
  type AgentEvent,
  type CreateAgentTask,
} from "./agents-events";

/**
 * Mobile client for the gateway-hosted agent runtime (`/v1/agents`). Mirrors
 * apps/web/lib/agents.ts. On a phone the gateway is the user's home machine
 * (directly on LAN, or via the relay), so this is the "kick off a coding task
 * from your phone, it runs on your Mac" surface. The pure event types + SSE
 * parser live in ./agents-events (react-native-free, unit-tested).
 */

export {
  parseAgentEventLine,
  type AgentEvent,
  type CreateAgentTask,
} from "./agents-events";

const GATEWAY_TOKEN = process.env.EXPO_PUBLIC_GATEWAY_TOKEN?.trim() || "";

function authHeaders(): Record<string, string> {
  return GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {};
}

export async function createAgentTask(body: CreateAgentTask): Promise<string> {
  const res = await fetch(`${getGatewayUrl()}/v1/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
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

export async function resolveApproval(
  agentId: string,
  approvalId: string,
  approved: boolean,
): Promise<void> {
  await fetch(`${getGatewayUrl()}/v1/agents/${agentId}/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ approval_id: approvalId, approved }),
  });
}

export async function stopAgent(agentId: string): Promise<void> {
  await fetch(`${getGatewayUrl()}/v1/agents/${agentId}/stop`, {
    method: "POST",
    headers: authHeaders(),
  });
}

/** Stream a task's events (backlog replay + live) via fetch-streaming. */
export async function streamAgentEvents(
  agentId: string,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${getGatewayUrl()}/v1/agents/${agentId}/events`, {
    headers: authHeaders(),
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
