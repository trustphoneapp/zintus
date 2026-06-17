import type { ChatMessage, ThreadMessage } from "@multipleai/types";
import { allocateTokenBudget } from "./budget.js";
import {
  FactSummaryBlock,
  mergeBlocks,
  StaticProfileBlock,
  VectorRecallBlock,
} from "./blocks/index.js";
import { buildHandoffBlock } from "./handoff.js";
import { compressTerminalOutput } from "./util/terminal-compress.js";
import { formatDiffContext } from "./util/diff-context.js";
import type { CompileRequest, CompileResult } from "./types.js";

const TOKENS_PER_CHAR = 1 / 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

function trimToBudget(messages: ThreadMessage[], maxTokens: number): ThreadMessage[] {
  if (maxTokens <= 0) {
    return [];
  }
  const kept: ThreadMessage[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const messageTokens = estimateTokens(message.content);
    if (used + messageTokens > maxTokens) {
      continue;
    }
    kept.unshift(message);
    used += messageTokens;
  }
  return kept;
}

function toTurns(messages: ThreadMessage[]): ThreadMessage[] {
  const reversed = [...messages].reverse();
  const selected: ThreadMessage[] = [];
  let userTurnCount = 0;

  for (const message of reversed) {
    selected.unshift(message);
    if (message.role === "user") {
      userTurnCount += 1;
      if (userTurnCount >= 1) {
        break;
      }
    }
  }
  return selected;
}

function selectLastTurns(
  messages: ThreadMessage[],
  turnCount: number,
  maxTokens: number,
): ThreadMessage[] {
  if (turnCount <= 0) {
    return [];
  }
  const selected: ThreadMessage[] = [];
  let remainingTurns = turnCount;
  let index = messages.length - 1;
  let used = 0;

  while (index >= 0 && remainingTurns > 0) {
    const chunk: ThreadMessage[] = [];
    let sawUser = false;
    while (index >= 0) {
      const message = messages[index];
      if (!message) {
        break;
      }
      chunk.unshift(message);
      index -= 1;
      if (message.role === "user") {
        sawUser = true;
        break;
      }
    }
    if (!sawUser) {
      break;
    }
    const chunkTokens = chunk.reduce(
      (sum, message) => sum + estimateTokens(message.content),
      0,
    );
    if (used + chunkTokens > maxTokens) {
      continue;
    }
    selected.unshift(...chunk);
    used += chunkTokens;
    remainingTurns -= 1;
  }

  return selected;
}

export async function compileContext(request: CompileRequest): Promise<CompileResult> {
  const contextWindow = request.contextWindow ?? 128_000;
  const budget = allocateTokenBudget(request.mode, contextWindow);
  const sections: ChatMessage[] = [];
  const includedSections: CompileResult["compileTrace"]["includedSections"] = [];
  const droppedSections: string[] = [];
  const staticProfileBlock = new StaticProfileBlock();
  const recallBlocks = [new FactSummaryBlock(), new VectorRecallBlock()];

  const minimalSystem: ChatMessage = {
    role: "system",
    content:
      "You are a helpful assistant. Respect prior constraints and continue the conversation consistently.",
  };
  sections.push(minimalSystem);
  includedSections.push("minimal-system");

  const threadState = await request.memory.getThreadState(request.threadId);
  const topFacts = await request.memory.getTopFacts(
    request.threadId,
    request.newUserMessage,
    request.mode === "deep" ? 12 : 6,
  );
  const retrievedChunks =
    request.mode !== "fast" && request.memory.searchChunks
      ? await request.memory.searchChunks(
          request.threadId,
          request.newUserMessage,
          request.mode === "deep" ? 8 : 5,
        )
      : [];

  let selectedHistory: ThreadMessage[] = [];
  let handoffBlock: ChatMessage | undefined;

  if (request.mode !== "fast") {
    const mergedProfile = mergeBlocks({
      blocks: [staticProfileBlock],
      data: { threadState, topFacts, retrievedChunks },
      budget,
      estimateTokens,
    });
    if (mergedProfile.messages.length) {
      sections.push(...mergedProfile.messages);
      includedSections.push(...mergedProfile.includedSections);
    }
    if (mergedProfile.droppedSections.length) {
      droppedSections.push(...mergedProfile.droppedSections);
    }

    const desiredTurns = request.mode === "deep" ? 12 : 3;
    selectedHistory = selectLastTurns(
      request.episodicMessages,
      desiredTurns,
      budget.recentTurns,
    );
    if (selectedHistory.length) {
      sections.push(
        ...selectedHistory.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      );
      includedSections.push("recent-turns");
    } else {
      droppedSections.push("recent-turns empty");
    }

    const mergedRecall = mergeBlocks({
      blocks: recallBlocks,
      data: { threadState, topFacts, retrievedChunks },
      budget,
      estimateTokens,
    });
    if (mergedRecall.messages.length) {
      sections.push(...mergedRecall.messages);
      includedSections.push(...mergedRecall.includedSections);
    }
    if (mergedRecall.droppedSections.length) {
      droppedSections.push(...mergedRecall.droppedSections);
    }

    handoffBlock = buildHandoffBlock(threadState, request.lastModel);
    if (handoffBlock) {
      if (estimateTokens(handoffBlock.content) <= budget.handoff) {
        sections.push(handoffBlock);
        includedSections.push("handoff");
      } else {
        droppedSections.push("handoff over budget");
      }
    }
  } else {
    const minimalRecent = trimToBudget(
      toTurns(request.episodicMessages),
      Math.floor(budget.user * 0.35),
    );
    if (minimalRecent.length) {
      sections.push(
        ...minimalRecent.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      );
    }
    selectedHistory = minimalRecent;
  }

  // --- Smart Context Engine blocks (coding) -----------------------------
  // These are gated on the request providing the source. Each is capped as a
  // fraction of availableForPrompt, so when the engine passes a smaller
  // contextWindow (the cheapest free model that currently has quota), these
  // budgets shrink automatically — context auto-fits the chosen model.
  const avail = budget.availableForPrompt;

  // Codebase recall: the most relevant source chunks for this message.
  if (request.codeSearch && request.mode !== "fast") {
    const codeCap = Math.floor(avail * 0.2);
    try {
      const hits = await request.codeSearch(
        request.newUserMessage,
        request.mode === "deep" ? 8 : 5,
      );
      const chosen: string[] = [];
      let used = 0;
      for (const hit of hits) {
        const snippet = `// ${hit.path}:${hit.startLine}-${hit.endLine}\n${hit.content}`;
        const cost = estimateTokens(snippet);
        if (used + cost > codeCap) {
          break;
        }
        chosen.push(snippet);
        used += cost;
      }
      if (chosen.length) {
        sections.push({
          role: "system",
          content: `Relevant code from the workspace:\n\n${chosen.join("\n\n")}`,
        });
        includedSections.push("code-recall");
      } else if (hits.length) {
        droppedSections.push("code-recall over budget");
      }
    } catch {
      droppedSections.push("code-recall error");
    }
  }

  // Git diff for this turn (changed lines, not whole files).
  if (request.diffText && request.diffText.trim()) {
    const diffCap = Math.floor(avail * 0.2);
    const formatted = formatDiffContext(request.diffText, {
      maxTotalLines: Math.max(40, Math.floor(diffCap / 10)),
    });
    if (formatted && estimateTokens(formatted) <= diffCap) {
      sections.push({
        role: "system",
        content: `Working changes (git diff) for this turn:\n\n${formatted}`,
      });
      includedSections.push("diff");
    } else if (formatted) {
      droppedSections.push("diff over budget");
    }
  }

  // Terminal/build/log output for this turn (compressed).
  if (request.terminalText && request.terminalText.trim()) {
    const terminalCap = Math.floor(avail * 0.1);
    const { text } = compressTerminalOutput(request.terminalText, {
      maxLines: Math.max(20, Math.floor(terminalCap / 12)),
    });
    if (text && estimateTokens(text) <= terminalCap) {
      sections.push({
        role: "system",
        content: `Recent terminal output (compressed):\n\n${text}`,
      });
      includedSections.push("terminal");
    } else if (text) {
      droppedSections.push("terminal over budget");
    }
  }

  sections.push({ role: "user", content: request.newUserMessage });

  const tokenEstimate = sections.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0,
  );

  return {
    messages: sections,
    tokenEstimate,
    compileTrace: {
      mode: request.mode,
      selectedTurnCount: selectedHistory.filter((message) => message.role === "user")
        .length,
      factCount: topFacts.length,
      retrievedChunkCount: retrievedChunks.length,
      includedSections,
      droppedSections,
    },
    bundle: {
      threadId: request.threadId,
      mode: request.mode,
      targetModel: request.targetModel,
      contextWindow,
      budget,
      threadState,
      topFacts,
      retrievedChunks,
      selectedHistory,
      handoffBlock,
    },
  };
}
