// MIT License — see LICENSE file
import { countTokensFast } from "../tokenizer/count.js";
import { getDefaultCCRStore } from "../ccr/store.js";
import type { CompressContext, CompressResult, Message } from "../pipeline/types.js";

export interface ContextManagerOptions {
  maxTurns?: number;
}

const DEFAULT_MAX_TURNS = 8;

/** Groups messages into atomic units: tool_use + tool_result pairs stay together. */
function groupIntoTurns(
  messages: Message[],
): Array<{ messages: Message[]; isToolPair: boolean }> {
  const turns: Array<{ messages: Message[]; isToolPair: boolean }> = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    // Check if this is a tool_use that has a paired tool_result next
    if (
      msg.role === "assistant" &&
      i + 1 < messages.length &&
      (messages[i + 1]?.role === "tool")
    ) {
      turns.push({ messages: [msg, messages[i + 1]!], isToolPair: true });
      i += 2;
    } else {
      turns.push({ messages: [msg], isToolPair: false });
      i++;
    }
  }
  return turns;
}

/**
 * Applies a rolling window over conversation history:
 * - Always keeps system prompt
 * - Keeps last maxTurns user+assistant pairs
 * - Drops oldest turns first
 * - Tool use + tool result pairs are atomic (never split)
 * - Dropped messages are stored in CCR
 */
export function manageContext(
  messages: Message[],
  ctx: CompressContext,
  opts: ContextManagerOptions = {},
): { messages: Message[] } & CompressResult {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const noop = (): { messages: Message[] } & CompressResult => ({
    messages,
    content: messages.map((m) => m.content).join("\n"),
    originalTokens: countTokensFast(messages.map((m) => m.content).join(" ")),
    compressedTokens: countTokensFast(messages.map((m) => m.content).join(" ")),
    ratio: 1,
    transforms: [],
    ccrHashes: [],
    cacheHit: false,
  });

  try {
    // Separate system messages from conversation
    const systemMessages = messages.filter((m) => m.role === "system");
    const conversationMessages = messages.filter((m) => m.role !== "system");

    if (conversationMessages.length === 0) return noop();

    const turns = groupIntoTurns(conversationMessages);

    if (turns.length <= maxTurns) return noop();

    const keepTurns = turns.slice(turns.length - maxTurns);
    const dropTurns = turns.slice(0, turns.length - maxTurns);

    if (dropTurns.length === 0) return noop();

    const droppedMessages = dropTurns.flatMap((t) => t.messages);
    const droppedContent = droppedMessages.map((m) => `${m.role}: ${m.content}`).join("\n\n");

    const store = getDefaultCCRStore();
    const hash = store.store(droppedContent, "conversation", {
      sessionId: ctx.sessionId,
    });

    const keptMessages = keepTurns.flatMap((t) => t.messages);
    const summaryMessage: Message = {
      role: "system",
      content: `[${droppedMessages.length} earlier messages dropped. retrieve(${hash}) to restore]`,
    };

    const resultMessages = [...systemMessages, summaryMessage, ...keptMessages];
    const originalTokens = countTokensFast(droppedContent + keptMessages.map((m) => m.content).join(" "));
    const compressedTokens = countTokensFast(keptMessages.map((m) => m.content).join(" "));

    return {
      messages: resultMessages,
      content: keptMessages.map((m) => m.content).join("\n"),
      originalTokens,
      compressedTokens,
      ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens,
      transforms: ["rolling-window"],
      ccrHashes: [hash],
      cacheHit: false,
    };
  } catch {
    return noop();
  }
}
