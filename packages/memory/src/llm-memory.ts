import { getKey } from "@zintus/keychain";
import { createRouter, type Router } from "@zintus/router";
import type { ChatMessage, MemoryFact, ProviderId } from "@zintus/types";
import { extractFacts } from "./extract.js";
import { summarizeTurns } from "./summarize.js";

type StreamTextFn = (input: {
  messages: ChatMessage[];
  provider?: ProviderId;
  model?: string;
}) => Promise<string>;

export interface LlmMemoryOptions {
  streamText?: StreamTextFn;
  router?: Router;
  getApiKey?: (providerId: ProviderId) => Promise<string | null>;
}

interface LlmFactPayload {
  facts?: Array<{
    id?: unknown;
    content?: unknown;
    relevance?: unknown;
    source?: unknown;
  }>;
}

const CHEAP_ATTEMPTS: Array<{ provider?: ProviderId; model?: string }> = [
  { provider: "groq", model: "llama-3.1-8b-instant" },
  { provider: "ollama" },
  {},
];

function normalizeJsonPayload(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? raw).trim();
}

function toFactId(content: string): string {
  const key = content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return key ? `llm.${key}` : "llm.fact";
}

function toStructuredFacts(payload: LlmFactPayload): MemoryFact[] {
  if (!Array.isArray(payload.facts)) {
    return [];
  }

  const out: MemoryFact[] = [];
  for (const candidate of payload.facts) {
    if (typeof candidate?.content !== "string") {
      continue;
    }
    const content = candidate.content.trim();
    if (!content) {
      continue;
    }

    const relevance =
      typeof candidate.relevance === "number"
        ? Math.max(0, Math.min(1, candidate.relevance))
        : undefined;
    const source = typeof candidate.source === "string" ? candidate.source : "llm";
    const id =
      typeof candidate.id === "string" && candidate.id.trim()
        ? candidate.id.trim()
        : toFactId(content);

    out.push({ id, content, relevance, source });
  }

  const deduped = new Map<string, MemoryFact>();
  for (const fact of out) {
    const existing = deduped.get(fact.id);
    if (!existing || (fact.relevance ?? 0) > (existing.relevance ?? 0)) {
      deduped.set(fact.id, fact);
    }
  }
  return [...deduped.values()];
}

async function defaultStreamText(
  input: { messages: ChatMessage[]; provider?: ProviderId; model?: string },
  options?: LlmMemoryOptions,
): Promise<string> {
  const router =
    options?.router ??
    createRouter({
      getApiKey: options?.getApiKey ?? getKey,
    });
  const result = await router.routeAndStream({
    messages: input.messages,
    provider: input.provider,
    model: input.model,
    mode: "fast",
  });

  let text = "";
  for await (const chunk of result.stream) {
    text += chunk;
  }
  return text.trim();
}

async function runLlm(
  messages: ChatMessage[],
  options?: LlmMemoryOptions,
): Promise<string> {
  const streamText = options?.streamText
    ? options.streamText
    : async (input: { messages: ChatMessage[]; provider?: ProviderId; model?: string }) =>
        defaultStreamText(input, options);

  let lastError: unknown;
  for (const attempt of CHEAP_ATTEMPTS) {
    try {
      const text = await streamText({
        messages,
        provider: attempt.provider,
        model: attempt.model,
      });
      if (text.trim()) {
        return text;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("No LLM providers available");
}

export async function summarizeWithLlm(
  previousSummary: string,
  turns: ChatMessage[],
  options?: LlmMemoryOptions,
): Promise<string> {
  try {
    const prompt: ChatMessage[] = [
      {
        role: "system",
        content:
          "You produce compact conversation memory. Return plain text summary only, max 8 bullet lines, no markdown code fences.",
      },
      {
        role: "user",
        content: [
          "Previous summary:",
          previousSummary.trim() || "(none)",
          "",
          "New turns:",
          ...turns.map((turn) => `${turn.role}: ${turn.content}`),
          "",
          "Task: update working summary preserving stable preferences, decisions, and active goals.",
        ].join("\n"),
      },
    ];

    const generated = await runLlm(prompt, options);
    return generated.trim() ? generated.trim().slice(-4000) : summarizeTurns(previousSummary, turns);
  } catch {
    return summarizeTurns(previousSummary, turns);
  }
}

export async function extractFactsWithLlm(
  turns: ChatMessage[],
  options?: LlmMemoryOptions,
): Promise<MemoryFact[]> {
  try {
    const prompt: ChatMessage[] = [
      {
        role: "system",
        content:
          'Extract durable user-specific facts and decisions. Return strict JSON object: {"facts":[{"id":"string","content":"string","relevance":0..1,"source":"llm"}]}.',
      },
      {
        role: "user",
        content: turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
      },
    ];

    const generated = await runLlm(prompt, options);
    const payload = JSON.parse(normalizeJsonPayload(generated)) as LlmFactPayload;
    const facts = toStructuredFacts(payload);
    return facts.length > 0 ? facts : extractFacts(turns);
  } catch {
    return extractFacts(turns);
  }
}

export async function consolidateFactsWithLlm(
  existingFacts: MemoryFact[],
  turns: ChatMessage[],
  options?: LlmMemoryOptions,
): Promise<{
  deletions: string[];
  additions: string[];
  updates: Array<{ id: string; content: string }>;
}> {
  try {
    const prompt: ChatMessage[] = [
      {
        role: "system",
        content: `You are a memory consolidation engine. Compare new conversation turns with existing facts.
Identify conflicts, corrections, updates, or brand new facts.
Output strict JSON format ONLY:
{
  "deletions": ["fact_id_to_delete", ...],
  "additions": ["new fact content string", ...],
  "updates": [{"id": "fact_id_to_update", "content": "updated fact content string"}]
}
Do not return conversational text, only return the JSON block.`
      },
      {
        role: "user",
        content: JSON.stringify({
          existingFacts: existingFacts.map(f => ({ id: f.id, content: f.content })),
          newTurns: turns.map(t => `${t.role}: ${t.content}`)
        }, null, 2)
      }
    ];

    const generated = await runLlm(prompt, options);
    const payload = JSON.parse(normalizeJsonPayload(generated)) as {
      deletions?: string[];
      additions?: string[];
      updates?: Array<{ id: string; content: string }>;
    };

    return {
      deletions: Array.isArray(payload.deletions) ? payload.deletions : [],
      additions: Array.isArray(payload.additions) ? payload.additions : [],
      updates: Array.isArray(payload.updates) ? payload.updates.filter(u => u && typeof u.id === "string" && typeof u.content === "string") : [],
    };
  } catch {
    return { deletions: [], additions: [], updates: [] };
  }
}
