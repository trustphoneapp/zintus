// MIT License — see LICENSE file
import { retrieve } from "./retrieve.js";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const TOKZEN_RETRIEVE_TOOL: ToolDefinition = {
  name: "tokzen_retrieve",
  description:
    "Retrieve compressed content by hash when you need the full version of data that was compressed.",
  input_schema: {
    type: "object",
    properties: {
      hash: {
        type: "string",
        description: "The CCR hash from a compressed content marker",
      },
      query: {
        type: "string",
        description: "Optional: search query to get relevant subset only",
      },
    },
    required: ["hash"],
  },
};

/** Inject tokzen_retrieve into a tools array if not already present. */
export function injectRetrieveTool(
  tools: ToolDefinition[] | undefined,
): ToolDefinition[] {
  const existing = tools ?? [];
  if (existing.some((t) => t.name === "tokzen_retrieve")) return existing;
  return [...existing, TOKZEN_RETRIEVE_TOOL];
}

/** Handle a tokzen_retrieve tool call — returns the content or an error string. */
export function handleRetrieveCall(
  input: { hash: string; query?: string },
): string {
  const result = retrieve(input.hash, input.query);
  if (!result) return `[tokzen: no content found for hash ${input.hash}]`;
  return result;
}
