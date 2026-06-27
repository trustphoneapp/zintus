import { textOf, type ChatMessage, type MemoryFact } from "@zintus/types";

const preferencePatterns: Array<{
  keyPrefix: string;
  regex: RegExp;
  valueGroup?: number;
}> = [
  {
    keyPrefix: "preference.language",
    regex: /\b(?:i prefer|use|write in)\s+([a-z][a-z0-9+#\-. ]{1,30})\b/i,
    valueGroup: 1,
  },
  {
    keyPrefix: "preference.tone",
    regex: /\b(?:answer|respond|write)\s+(?:in a|with a)\s+([a-z ]{3,30})\s+tone\b/i,
    valueGroup: 1,
  },
  {
    keyPrefix: "preference.framework",
    regex: /\b(?:i use|i work with|our stack is)\s+([a-z0-9@./ -]{2,40})\b/i,
    valueGroup: 1,
  },
];

const decisionPatterns: Array<{
  keyPrefix: string;
  regex: RegExp;
  valueGroup?: number;
}> = [
  {
    keyPrefix: "decision",
    regex: /\b(?:we decided to|let'?s|we will|we should)\s+(.{5,140})/i,
    valueGroup: 1,
  },
  {
    keyPrefix: "constraint",
    regex: /\b(?:must|should not|cannot|can't)\s+(.{5,140})/i,
    valueGroup: 1,
  },
];

function normalizeFactValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[.!,;:]+$/, "");
}

function stableKey(prefix: string, value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned ? `${prefix}.${cleaned}` : prefix;
}

function createFact(
  id: string,
  content: string,
  relevance: number,
  source: string,
): MemoryFact {
  return { id, content, relevance, source };
}

function parseByPatterns(
  text: string,
  patterns: Array<{ keyPrefix: string; regex: RegExp; valueGroup?: number }>,
  confidence: number,
): MemoryFact[] {
  const out: MemoryFact[] = [];
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (!match) {
      continue;
    }
    const rawValue =
      pattern.valueGroup !== undefined ? (match[pattern.valueGroup] ?? "") : match[0];
    const value = normalizeFactValue(rawValue);
    if (!value) {
      continue;
    }
    out.push(createFact(stableKey(pattern.keyPrefix, value), value, confidence, "heuristic"));
  }
  return out;
}

export function extractFacts(turns: ChatMessage[]): MemoryFact[] {
  const candidates = turns
    .filter((turn) => turn.role === "user")
    .flatMap((turn) => {
      const text = textOf(turn.content);
      return [
        ...parseByPatterns(text, preferencePatterns, 0.82),
        ...parseByPatterns(text, decisionPatterns, 0.72),
      ];
    });

  const deduped = new Map<string, MemoryFact>();
  for (const fact of candidates) {
    const existing = deduped.get(fact.id);
    if (!existing || (fact.relevance ?? 0) > (existing.relevance ?? 0)) {
      deduped.set(fact.id, fact);
    }
  }
  return [...deduped.values()];
}
