import type { ChatMessage } from "@multipleai/types";

export function summarizeTurns(previousSummary: string, newTurns: ChatMessage[]): string {
  const userTurns = newTurns.filter((turn) => turn.role === "user").slice(-2);
  const assistantTurns = newTurns.filter((turn) => turn.role === "assistant").slice(-2);

  const userSnippet = userTurns
    .map((turn) => turn.content.trim())
    .filter(Boolean)
    .map((text) => text.slice(0, 160))
    .join(" | ");
  const assistantSnippet = assistantTurns
    .map((turn) => turn.content.trim())
    .filter(Boolean)
    .map((text) => text.slice(0, 160))
    .join(" | ");

  const additions: string[] = [];
  if (userSnippet) {
    additions.push(`User asked: ${userSnippet}`);
  }
  if (assistantSnippet) {
    additions.push(`Assistant replied: ${assistantSnippet}`);
  }

  if (!additions.length) {
    return previousSummary;
  }

  const next = previousSummary
    ? `${previousSummary}\n- ${additions.join("\n- ")}`
    : additions.map((line) => `- ${line}`).join("\n");

  return next.slice(-4000);
}
