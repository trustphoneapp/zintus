import type { ChatMessage, MemoryThreadState } from "@multipleai/types";

export function buildHandoffBlock(
  threadState: MemoryThreadState | null,
  lastModel?: string,
): ChatMessage | undefined {
  if (!threadState) {
    return undefined;
  }

  const lines: string[] = [];
  lines.push("System handoff context:");

  if (lastModel) {
    lines.push(`- Previous model: ${lastModel}`);
  }
  if (threadState.userPreferences?.length) {
    lines.push(`- User preferences: ${threadState.userPreferences.join("; ")}`);
  }
  if (threadState.constraints?.length) {
    lines.push(`- Constraints: ${threadState.constraints.join("; ")}`);
  }
  if (threadState.openLoops?.length) {
    lines.push(`- Open loops: ${threadState.openLoops.join("; ")}`);
  }

  if (lines.length === 1) {
    return undefined;
  }

  return {
    role: "system",
    content: lines.join("\n"),
  };
}
