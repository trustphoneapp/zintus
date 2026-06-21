// MIT License — see LICENSE file
import { countTokensFast, estimateSavings } from "../tokenizer/count.js";
import { getDefaultCCRStore } from "../ccr/store.js";
import type { CompressContext, CompressResult } from "../pipeline/types.js";

// Protect code blocks and quoted strings from sentence splitting
const CODE_BLOCK_RE = /```[\s\S]*?```|`[^`]+`/g;
const QUOTE_RE = /"[^"]{10,}"/g;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Rough sentence boundary splitter that handles abbreviations. */
function splitSentences(text: string): string[] {
  // Protect placeholders
  const placeholders: string[] = [];
  let protected_ = text
    .replace(CODE_BLOCK_RE, (m) => { const idx = placeholders.length; placeholders.push(m); return `\x00CODE${idx}\x00`; })
    .replace(QUOTE_RE, (m) => { const idx = placeholders.length; placeholders.push(m); return `\x00QUOTE${idx}\x00`; });

  // Handle common abbreviations
  const abbrevs = ["Mr", "Mrs", "Dr", "Prof", "Sr", "Jr", "vs", "etc", "e.g", "i.e", "Ph.D", "U.S", "U.K"];
  for (const a of abbrevs) {
    protected_ = protected_.replace(new RegExp(`\\b${a}\\.`, "g"), `${a}\x01`);
  }

  const sentences = protected_
    .split(/(?<=[.!?])\s+(?=[A-Z\x00])/)
    .map((s) => s.trim())
    .filter(Boolean);

  return sentences.map((s) => {
    let restored = s;
    for (const a of abbrevs) {
      restored = restored.replace(new RegExp(`${a}\x01`, "g"), `${a}.`);
    }
    restored = restored.replace(/\x00CODE(\d+)\x00/g, (_, i) => placeholders[parseInt(i)] ?? "");
    restored = restored.replace(/\x00QUOTE(\d+)\x00/g, (_, i) => placeholders[parseInt(i)] ?? "");
    return restored;
  });
}

/** TF-IDF scoring over sentences in a document. */
function tfidf(sentences: string[][]): number[] {
  const docCount = sentences.length;
  const df = new Map<string, number>();
  for (const s of sentences) {
    for (const term of new Set(s)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  return sentences.map((tokens) => {
    if (tokens.length === 0) return 0;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const [term, freq] of tf) {
      const idf = Math.log((docCount + 1) / ((df.get(term) ?? 0) + 1)) + 1;
      score += (freq / tokens.length) * idf;
    }
    return score / Math.sqrt(tokens.length); // length normalization
  });
}

/** Cosine similarity of two bag-of-words vectors. */
function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, v] of a) {
    dot += v * (b.get(term) ?? 0);
    normA += v * v;
  }
  for (const v of b.values()) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function bagOfWords(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** 10-iteration PageRank with damping=0.85 over a similarity graph. */
function textRank(bows: Map<string, number>[], n: number): number[] {
  const edges: number[][] = Array.from({ length: n }, () => new Array(n).fill(0) as number[]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSim(bows[i]!, bows[j]!);
      edges[i]![j] = sim;
      edges[j]![i] = sim;
    }
  }
  const scores = new Array<number>(n).fill(1 / n);
  const damping = 0.85;
  for (let iter = 0; iter < 10; iter++) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let inflow = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const rowSum = edges[j]!.reduce((s, v) => s + v, 0);
        if (rowSum > 0) inflow += (edges[j]![i]! / rowSum) * (scores[j] ?? 0);
      }
      next[i] = (1 - damping) / n + damping * inflow;
    }
    for (let i = 0; i < n; i++) scores[i] = next[i] ?? scores[i] ?? 0;
  }
  return scores;
}

/** 3-gram Jaccard similarity between two token arrays. */
function jaccard3gram(a: string[], b: string[]): number {
  function ngrams(tokens: string[]): Set<string> {
    const s = new Set<string>();
    for (let i = 0; i <= tokens.length - 3; i++) {
      s.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
    return s;
  }
  const sa = ngrams(a);
  const sb = ngrams(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Deterministic extractive prose compressor using TF-IDF + TextRank.
 * No ML dependencies — falls back gracefully on any error.
 */
export function compressProse(
  content: string,
  ctx?: Partial<CompressContext>,
): CompressResult {
  const originalTokens = countTokensFast(content);
  const noop = (): CompressResult => ({
    content,
    originalTokens,
    compressedTokens: originalTokens,
    ratio: 1,
    transforms: [],
    ccrHashes: [],
    cacheHit: false,
  });

  try {
    const sentences = splitSentences(content).filter((s) => s.trim().length > 0);
    if (sentences.length <= 3) return noop();

    const tokenizedSentences = sentences.map(tokenize);
    const bows = tokenizedSentences.map(bagOfWords);
    const n = sentences.length;

    const tfidfScores = tfidf(tokenizedSentences);
    const textRankScores = textRank(bows, n);

    // Position bonus: first and last sentences
    const positionScores = sentences.map((_, i) =>
      i === 0 || i === n - 1 ? 0.2 : 0,
    );

    // Query boost
    const queryTerms = ctx?.query ? tokenize(ctx.query) : [];

    const finalScores = sentences.map((sentence, i) => {
      const tfidfS = tfidfScores[i] ?? 0;
      const trS = textRankScores[i] ?? 0;
      const posS = positionScores[i] ?? 0;
      let score = tfidfS * 0.4 + trS * 0.4 + posS;
      if (queryTerms.length > 0) {
        const sentTokens = tokenizedSentences[i] ?? [];
        const hasQuery = queryTerms.some((qt) => sentTokens.includes(qt));
        if (hasQuery) score *= 1.5;
      }
      return { sentence, score, originalIndex: i, tokens: tokenizedSentences[i] ?? [] };
    });

    // Target ~40% of original tokens
    const targetTokens = ctx?.tokenBudget
      ? Math.min(ctx.tokenBudget, Math.ceil(originalTokens * 0.4))
      : Math.ceil(originalTokens * 0.4);

    // Sort by score and select
    const sorted = [...finalScores].sort((a, b) => b.score - a.score);
    const selected: typeof sorted = [];
    let tokenCount = 0;

    for (const candidate of sorted) {
      if (tokenCount >= targetTokens) break;
      // Near-duplicate deduplication
      const isDuplicate = selected.some(
        (kept) => jaccard3gram(candidate.tokens, kept.tokens) > 0.7,
      );
      if (isDuplicate) continue;
      selected.push(candidate);
      tokenCount += countTokensFast(candidate.sentence);
    }

    // Re-sort by original position to preserve document order
    selected.sort((a, b) => a.originalIndex - b.originalIndex);

    if (selected.length === sentences.length) return noop();

    const store = getDefaultCCRStore();
    const dropped = finalScores.filter(
      (s) => !selected.some((k) => k.originalIndex === s.originalIndex),
    );
    const droppedContent = dropped.map((d) => d.sentence).join(" ");
    const hash = store.store(droppedContent, "prose", { sessionId: ctx?.sessionId });

    const result =
      selected.map((s) => s.sentence).join(" ") +
      `\n\n[Prose compressed: ${originalTokens}→${tokenCount} tokens. retrieve(${hash}) for full]`;

    const { compressedTokens } = estimateSavings(content, result);

    return {
      content: result,
      originalTokens,
      compressedTokens,
      ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens,
      transforms: ["tfidf", "textrank", "extractive"],
      ccrHashes: [hash],
      cacheHit: false,
    };
  } catch {
    return noop();
  }
}
