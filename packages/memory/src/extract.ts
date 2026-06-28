import { textOf, type ChatMessage, type MemoryFact } from "@zintus/types";

type FactPattern = {
  keyPrefix: string;
  regex: RegExp;
  valueGroup?: number;
  /** Minimum content-word count the captured value must have to be kept. */
  minWords?: number;
};

const preferencePatterns: FactPattern[] = [
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

const decisionPatterns: FactPattern[] = [
  {
    keyPrefix: "decision",
    regex: /\b(?:we decided to|let'?s|we will|we should)\s+(.{5,140})/i,
    valueGroup: 1,
    minWords: 2,
  },
];

// Directive / constraint detector. Captures the modal *and* the clause so the
// stored fact keeps its meaning (and its negation) instead of dropping it — the
// old `/(?:must|should not|cannot|can't)\s+(.{5,140})/` captured only the tail,
// which both inverted "should not X" into "X" and let casual first-person
// chatter ("I can't believe this works") become a persistent constraint.
const CONSTRAINT_RE =
  /\b(must not|must|should not|shouldn['’]?t|cannot|can not|can['’]?t|do not|don['’]?t|never|always)\s+([^,;.!?]{2,140})/gi;

// After a can't / cannot / do-not modal, these leading phrases signal a
// conversational reaction or fixed idiom ("I can't believe…", "can't wait",
// "you can't be serious", "don't worry") — never a durable rule.
const REACTION_LEADS = [
  "believe",
  "wait",
  "be serious",
  "be bothered",
  "be for real",
  "stop",
  "help",
  "even",
  "imagine",
  "tell",
  "stand",
  "hardly",
  "get over",
  "thank",
  "worry",
  "get me wrong",
  "mention it",
  "bother",
];

// After always / never, these leads signal first-person narrative or feeling
// ("I always wanted…", "I never thought…") rather than an instruction.
const NARRATIVE_LEADS = [
  "wanted",
  "thought",
  "felt",
  "loved",
  "liked",
  "hated",
  "knew",
  "wondered",
  "dreamed",
  "used to",
  "meant to",
  "say",
  "said",
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

/** Count content words (a token must start with an alphanumeric character). */
function wordCount(value: string): number {
  return (value.match(/[a-z0-9][a-z0-9'’+#.\-]*/gi) ?? []).length;
}

/** Split free text into rough sentences so a match can't span unrelated ideas. */
function splitSentences(text: string): string[] {
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

function isQuestion(sentence: string): boolean {
  return /\?\s*$/.test(sentence);
}

function startsWithAny(clause: string, leads: string[]): boolean {
  const c = clause.toLowerCase();
  return leads.some((lead) => c === lead || c.startsWith(`${lead} `));
}

/**
 * Minimum-signal floor: a real constraint names something to act on, so it
 * needs at least a verb + object (two content words), not a bare verb or a
 * single-token fragment ("must go", "can't").
 */
function hasActionableObject(clause: string): boolean {
  return wordCount(clause) >= 2 && clause.replace(/\s+/g, "").length >= 4;
}

function parseByPatterns(
  text: string,
  patterns: FactPattern[],
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
    if (wordCount(value) < (pattern.minWords ?? 1)) {
      continue;
    }
    out.push(createFact(stableKey(pattern.keyPrefix, value), value, confidence, "heuristic"));
  }
  return out;
}

function extractConstraints(sentence: string): MemoryFact[] {
  const out: MemoryFact[] = [];
  for (const match of sentence.matchAll(CONSTRAINT_RE)) {
    const modalRaw = match[1];
    if (!modalRaw) {
      continue;
    }
    const modal = modalRaw.toLowerCase().replace(/['’]/g, "'").replace(/\s+/g, " ");
    const clause = (match[2] ?? "").trim();

    const isCant = modal === "can't" || modal === "cannot" || modal === "can not";
    const isDont = modal === "don't" || modal === "do not";
    const isAlwaysNever = modal === "always" || modal === "never";

    // Reject conversational reactions ("I can't believe…", "don't worry") and
    // first-person narrative ("I always wanted…") before they become facts.
    if ((isCant || isDont) && startsWithAny(clause, REACTION_LEADS)) {
      continue;
    }
    if (isAlwaysNever && startsWithAny(clause, NARRATIVE_LEADS)) {
      continue;
    }
    if (!hasActionableObject(clause)) {
      continue;
    }

    const value = normalizeFactValue(match[0]);
    if (!value) {
      continue;
    }
    out.push(createFact(stableKey("constraint", value), value, 0.72, "heuristic"));
  }
  return out;
}

export function extractFacts(turns: ChatMessage[]): MemoryFact[] {
  const candidates: MemoryFact[] = [];
  for (const turn of turns) {
    if (turn.role !== "user") {
      continue;
    }
    const text = textOf(turn.content);
    for (const sentence of splitSentences(text)) {
      // Questions are requests, not stated rules — never extract from them.
      if (isQuestion(sentence)) {
        continue;
      }
      candidates.push(...parseByPatterns(sentence, preferencePatterns, 0.82));
      candidates.push(...parseByPatterns(sentence, decisionPatterns, 0.72));
      candidates.push(...extractConstraints(sentence));
    }
  }

  const deduped = new Map<string, MemoryFact>();
  for (const fact of candidates) {
    const existing = deduped.get(fact.id);
    if (!existing || (fact.relevance ?? 0) > (existing.relevance ?? 0)) {
      deduped.set(fact.id, fact);
    }
  }
  return [...deduped.values()];
}
