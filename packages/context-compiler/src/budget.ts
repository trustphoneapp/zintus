import type { BudgetBreakdown, CompileMode } from "./types.js";

export function allocateTokenBudget(
  mode: CompileMode,
  contextWindow: number,
): BudgetBreakdown {
  const reserveForResponse = Math.floor(contextWindow * 0.25);
  const availableForPrompt = Math.max(0, contextWindow - reserveForResponse);

  if (mode === "fast") {
    const system = Math.floor(availableForPrompt * 0.08);
    const user = availableForPrompt - system;
    return {
      contextWindow,
      system,
      summary: 0,
      recentTurns: 0,
      facts: 0,
      handoff: 0,
      user,
      reserveForResponse,
      availableForPrompt,
    };
  }

  if (mode === "smart") {
    const system = Math.floor(availableForPrompt * 0.08);
    const summary = Math.floor(availableForPrompt * 0.22);
    const recentTurns = Math.floor(availableForPrompt * 0.30);
    const facts = Math.floor(availableForPrompt * 0.18);
    const handoff = Math.floor(availableForPrompt * 0.10);
    const user = Math.max(
      0,
      availableForPrompt - (system + summary + recentTurns + facts + handoff),
    );
    return {
      contextWindow,
      system,
      summary,
      recentTurns,
      facts,
      handoff,
      user,
      reserveForResponse,
      availableForPrompt,
    };
  }

  const system = Math.floor(availableForPrompt * 0.07);
  const summary = Math.floor(availableForPrompt * 0.18);
  const recentTurns = Math.floor(availableForPrompt * 0.43);
  const facts = Math.floor(availableForPrompt * 0.15);
  const handoff = Math.floor(availableForPrompt * 0.08);
  const user = Math.max(
    0,
    availableForPrompt - (system + summary + recentTurns + facts + handoff),
  );
  return {
    contextWindow,
    system,
    summary,
    recentTurns,
    facts,
    handoff,
    user,
    reserveForResponse,
    availableForPrompt,
  };
}
