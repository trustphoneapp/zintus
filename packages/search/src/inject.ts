import { textOf, type ChatMessage } from "@zintus/types";
import type { SearchResult } from "./types.js";

/** The last user message is the search query. */
export function extractSearchQuery(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === "user" && textOf(message.content).trim()) {
      return textOf(message.content).trim();
    }
  }
  return "";
}

/** Render search results as a numbered, citable reference block. */
export function formatSearchContext(results: SearchResult[]): string {
  return results
    .map(
      (result, index) =>
        `[${index + 1}] ${result.title}\n${result.url}\n${result.content}`,
    )
    .join("\n\n");
}

/**
 * Inject fallback search results into the conversation as a system message
 * placed immediately before the last user message. Returns the messages
 * unchanged when there are no results. The injected block is plain text so the
 * gateway's existing Tokzen pass can compress it like any other context.
 */
export function injectSearchResults(
  messages: ChatMessage[],
  results: SearchResult[],
): ChatMessage[] {
  if (results.length === 0) {
    return messages;
  }

  const block: ChatMessage = {
    role: "system",
    content:
      "<web_search_results>\n" +
      "Real-time web search results. Use as reference and cite sources inline as [1], [2], [3].\n\n" +
      formatSearchContext(results) +
      "\n</web_search_results>",
  };

  // Insert before the last user message; if none, append at the end.
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) {
    return [...messages, block];
  }
  return [
    ...messages.slice(0, lastUserIndex),
    block,
    ...messages.slice(lastUserIndex),
  ];
}
