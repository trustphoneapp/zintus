// MIT License — see LICENSE file
import { getDefaultCCRStore } from "./store.js";
import { countTokensFast } from "../tokenizer/count.js";

interface BM25Params {
  k1?: number;
  b?: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** BM25 scoring over a set of documents to find relevant sections. */
function bm25Score(
  queryTerms: string[],
  docTerms: string[],
  corpusSize: number,
  avgDocLen: number,
  docFreqs: Map<string, number>,
  params: BM25Params = {},
): number {
  const k1 = params.k1 ?? 1.5;
  const b = params.b ?? 0.75;
  const docLen = docTerms.length;
  const termFreqs = new Map<string, number>();
  for (const t of docTerms) {
    termFreqs.set(t, (termFreqs.get(t) ?? 0) + 1);
  }

  let score = 0;
  for (const term of queryTerms) {
    const tf = termFreqs.get(term) ?? 0;
    const df = docFreqs.get(term) ?? 0;
    if (df === 0) continue;
    const idf = Math.log((corpusSize - df + 0.5) / (df + 0.5) + 1);
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLen));
    score += idf * (numerator / denominator);
  }
  return score;
}

/**
 * Retrieve stored content by hash. If query is provided, returns the most
 * relevant paragraph-level sections via BM25 instead of the full content.
 * Pass a custom store for testing or isolated sessions.
 */
export function retrieve(hash: string, query?: string, store?: ReturnType<typeof getDefaultCCRStore>): string | null {
  const storeToUse = store ?? getDefaultCCRStore();
  const content = storeToUse.retrieve(hash);
  if (!content) return null;
  if (!query) return content;

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return content;

  // Split into paragraphs/sections for granular retrieval
  const sections = content
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sections.length <= 3) return content;

  const tokenizedSections = sections.map(tokenize);
  const avgDocLen =
    tokenizedSections.reduce((s, t) => s + t.length, 0) / tokenizedSections.length;

  // Build document frequency map
  const docFreqs = new Map<string, number>();
  for (const terms of tokenizedSections) {
    const unique = new Set(terms);
    for (const term of unique) {
      docFreqs.set(term, (docFreqs.get(term) ?? 0) + 1);
    }
  }

  // Score each section
  const scored = sections.map((section, i) => ({
    section,
    score: bm25Score(
      queryTerms,
      tokenizedSections[i] ?? [],
      sections.length,
      avgDocLen,
      docFreqs,
    ),
  }));

  // Keep top sections up to ~2000 tokens
  scored.sort((a, b) => b.score - a.score);
  const kept: string[] = [];
  let budget = 2000;
  for (const { section, score } of scored) {
    if (score === 0) break;
    const tokens = countTokensFast(section);
    if (tokens > budget) continue;
    kept.push(section);
    budget -= tokens;
  }

  return kept.length > 0 ? kept.join("\n\n") : content;
}
