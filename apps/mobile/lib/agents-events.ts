/**
 * Pure agent-event types + SSE line parser — react-native-free so it loads
 * under bun:test (agents.ts imports gateway-url → NativeModules/MMKV, which bun
 * can't parse). `agents.ts` re-exports these, so the runtime path is identical.
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
  sandbox?: boolean;
  browse?: boolean;
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
