import type { SearchResult } from "./types.js";

export type ResearchDepth = "quick" | "standard" | "deep";

/** Hard ceiling on extra corroboration rounds, regardless of config. */
export const MAX_VERIFICATION_PASSES = 3;
/** Hard ceiling on the number of ranked sources kept for synthesis. */
export const MAX_SOURCES = 40;
/** Hard ceiling on how many corroboration sub-queries a verification pass fires. */
export const MAX_VERIFY_QUERIES = 4;

export interface VerificationConfig {
  /**
   * Number of corroboration rounds to run after the initial synthesis. Defaults
   * to a per-depth value (quick 0, standard 1, deep 2); always clamped to
   * [0, MAX_VERIFICATION_PASSES]. Not a magic 1/3/5 — fully configurable.
   */
  passes?: number;
}

export interface DeepResearchOptions {
  depth: ResearchDepth;
  /** Cross-verification configuration (bounded; see MAX_VERIFICATION_PASSES). */
  verification?: VerificationConfig;
  /** Override the per-depth source ceiling (bounded by MAX_SOURCES). */
  maxSources?: number;
}

/** Number of parallel sub-searches per depth. */
export function subQueryCount(depth: ResearchDepth): number {
  return depth === "quick" ? 1 : depth === "standard" ? 3 : 5;
}

/**
 * How many corroboration rounds to run for a depth, honoring an explicit
 * override but always clamped to [0, MAX_VERIFICATION_PASSES] so cost stays
 * predictable. Defaults: quick 0, standard 1, deep 2.
 */
export function verificationPassCount(
  depth: ResearchDepth,
  requested?: number,
): number {
  const base = depth === "quick" ? 0 : depth === "standard" ? 1 : 2;
  const want = requested ?? base;
  if (!Number.isFinite(want)) return base;
  return Math.max(0, Math.min(MAX_VERIFICATION_PASSES, Math.floor(want)));
}

/**
 * Maximum number of (deduped, ranked) sources retained for a depth. Raises the
 * old ~25-hit ceiling sensibly while staying bounded by MAX_SOURCES so token
 * cost remains capped.
 */
export function sourceCeiling(depth: ResearchDepth, requested?: number): number {
  const base = depth === "quick" ? 8 : depth === "standard" ? 20 : 30;
  const want = requested ?? base;
  if (!Number.isFinite(want)) return base;
  return Math.max(1, Math.min(MAX_SOURCES, Math.floor(want)));
}

/**
 * A search result promoted to a first-class source: assigned a stable `id` and
 * a normalized `domain` so citations can bind to a concrete object instead of a
 * bare prompt-instructed `[n]`.
 */
export interface ResearchSource extends SearchResult {
  /** Stable id matching the inline citation number (`s${n}` ↔ `[n]`). */
  id: string;
  /** Normalized hostname (www-stripped, lowercased). */
  domain: string;
}

/** Corroboration status of a single claim, surfaced honestly to the UI. */
export type Corroboration = "corroborated" | "single-source" | "uncited";

/**
 * A claim extracted from the synthesized answer, structurally bound to the
 * concrete sources backing it. A claim with no backing source is `uncited`
 * (never given a fabricated citation).
 */
export interface Citation {
  claim: string;
  /** Source ids this claim cites (`[n]` markers resolved to real sources). */
  sourceIds: string[];
  /** The concrete source objects the ids resolve to. */
  sources: ResearchSource[];
  /** True when no real source backs the claim. */
  uncited: boolean;
  corroboration: Corroboration;
  /**
   * True when the corroborating sources CONTRADICT each other on this claim
   * (detected conservatively, never fabricated). This is a *refinement* of a
   * `corroborated` claim — corroboration counts the backing domains, conflict
   * flags that they disagree — so it never relabels the `corroboration` field.
   * Absent/false means "no conflict detected" (also the default when unsure).
   */
  conflict?: boolean;
}

export interface VerificationSummary {
  /** Corroboration rounds actually executed (≤ requested, ≤ cap). */
  passes: number;
  corroboratedClaims: number;
  singleSourceClaims: number;
  uncitedClaims: number;
  /**
   * Corroborated claims whose backing sources were found to disagree. A subset
   * of `corroboratedClaims` (conflict refines corroboration, never relabels it).
   */
  conflictedClaims: number;
}

/**
 * Dependencies injected by the caller (the gateway wires these to the engine
 * and the configured search provider). Keeping them out of this package avoids
 * a dependency on the engine and keeps the orchestration unit-testable.
 */
export interface DeepResearchDeps {
  /** Break a question into N focused sub-queries. */
  decompose: (query: string, count: number) => Promise<string[]>;
  /** Run one web search. */
  search: (query: string) => Promise<SearchResult[]>;
  /** Stream a synthesized answer from the gathered context. */
  synthesize: (query: string, context: string) => AsyncIterable<string>;
  /**
   * Optional: extract the key factual claims from a draft answer, used to drive
   * corroboration queries. When absent, claims are derived structurally from the
   * answer text — so verification works with only the three core deps above
   * (the existing gateway contract is unchanged).
   */
  extractClaims?: (answer: string) => Promise<string[]>;
  /**
   * Optional: judge whether the supplied sources CONTRADICT each other on the
   * given claim. Returns true ONLY on a clear contradiction; absent, throwing,
   * or any uncertain verdict means "no conflict" — a conflict is never
   * fabricated. Calls are bounded by the orchestrator (see MAX_VERIFY_QUERIES).
   */
  detectConflict?: (
    claim: string,
    sources: ResearchSource[],
  ) => Promise<boolean>;
}

export type DeepResearchEvent =
  | { type: "queries"; queries: string[] }
  | { type: "search_start"; index: number; query: string }
  | { type: "search_complete"; index: number; results: SearchResult[] }
  | { type: "synthesizing"; sourceCount: number }
  | { type: "answer_chunk"; text: string }
  // New: a corroboration round and its outcome (additive — existing clients
  // ignore unknown SSE event types).
  | { type: "verifying"; pass: number; claims: string[] }
  | {
      type: "verification_complete";
      pass: number;
      newSources: number;
      corroborated: number;
      uncorroborated: number;
    }
  // New: a single claim whose corroborating sources were found to CONTRADICT
  // each other. Additive — existing clients ignore unknown SSE event types.
  | { type: "conflict"; claim: string; sources: ResearchSource[] }
  // `done` is enriched with structurally-bound citations + a verification
  // summary. The original `sources` field is preserved (ResearchSource extends
  // SearchResult), so existing consumers keep working.
  | {
      type: "done";
      sources: ResearchSource[];
      citations: Citation[];
      verification: VerificationSummary;
    }
  | { type: "error"; message: string };

// ── source dedup + ranking ───────────────────────────────────────────────────

/** Normalize a URL for dedup: drop protocol, leading www, trailing slash. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return url
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return normalizeUrl(url).split("/")[0] ?? "";
  }
}

/**
 * Collapse duplicate URLs (by normalized form), keeping the highest-scored copy.
 * Results with no URL are dropped (a source must be verifiable).
 */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const byKey = new Map<string, SearchResult>();
  for (const r of results) {
    if (!r.url) continue;
    const key = normalizeUrl(r.url);
    const existing = byKey.get(key);
    if (!existing || (r.score ?? 0) > (existing.score ?? 0)) {
      byKey.set(key, r);
    }
  }
  return [...byKey.values()];
}

/**
 * Rank sources by relevance (score desc) then recency (publishedAt desc),
 * stable on insertion order, and assign each a stable `id`/`domain`. Citation
 * `[n]` binds to the source at rank n (id `s${n}`).
 */
export function rankSources(results: SearchResult[]): ResearchSource[] {
  return results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const byScore = (b.r.score ?? 0) - (a.r.score ?? 0);
      if (byScore !== 0) return byScore;
      // Recency tiebreak: a known publish date ranks above an unknown one, and
      // newer above older. Undated sources keep their stable insertion order.
      const ad = a.r.publishedAt ? Date.parse(a.r.publishedAt) : NaN;
      const bd = b.r.publishedAt ? Date.parse(b.r.publishedAt) : NaN;
      const av = Number.isNaN(ad) ? -Infinity : ad;
      const bv = Number.isNaN(bd) ? -Infinity : bd;
      if (av !== bv) return bv - av;
      return a.i - b.i;
    })
    .map(({ r }, idx) => ({
      ...r,
      id: `s${idx + 1}`,
      domain: domainOf(r.url),
    }));
}

/** Dedup → rank → assign ids → cap at the depth ceiling. */
function consolidate(
  results: SearchResult[],
  ceiling: number,
): ResearchSource[] {
  return rankSources(dedupeResults(results)).slice(0, ceiling);
}

function formatContext(sources: ResearchSource[]): string {
  return sources
    .map(
      (source, index) =>
        `[${index + 1}] ${source.title}\n${source.url}\n${source.content}`,
    )
    .join("\n\n");
}

// ── citation binding ─────────────────────────────────────────────────────────

function splitClaims(answer: string): string[] {
  return answer
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stripMarkers(text: string): string {
  return text
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the synthesized answer into claims and bind each to the concrete
 * source(s) its inline `[n]` markers reference. A claim whose markers resolve to
 * ≥2 distinct domains is "corroborated", exactly one is "single-source", and a
 * claim with no resolvable marker is `uncited` — never assigned a fake source.
 */
export function bindCitations(
  answer: string,
  sources: ResearchSource[],
): Citation[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return splitClaims(answer).map((claim) => {
    const ids = new Set<string>();
    for (const match of claim.matchAll(/\[(\d+)\]/g)) {
      const id = `s${match[1]}`;
      if (byId.has(id)) ids.add(id);
    }
    const bound = [...ids].map((id) => byId.get(id)!);
    const domains = new Set(bound.map((s) => s.domain));
    const uncited = bound.length === 0;
    const corroboration: Corroboration = uncited
      ? "uncited"
      : domains.size >= 2
        ? "corroborated"
        : "single-source";
    return { claim, sourceIds: [...ids], sources: bound, uncited, corroboration };
  });
}

function summarize(citations: Citation[], passes: number): VerificationSummary {
  let corroboratedClaims = 0;
  let singleSourceClaims = 0;
  let uncitedClaims = 0;
  let conflictedClaims = 0;
  for (const c of citations) {
    if (c.corroboration === "corroborated") corroboratedClaims++;
    else if (c.corroboration === "single-source") singleSourceClaims++;
    else uncitedClaims++;
    if (c.conflict) conflictedClaims++;
  }
  return {
    passes,
    corroboratedClaims,
    singleSourceClaims,
    uncitedClaims,
    conflictedClaims,
  };
}

/**
 * Derive the corroboration queries for a verification round: the weakly-backed
 * claims (uncited or single-source) of the current answer. Uses the optional
 * `extractClaims` dep when provided, else the answer's own claim sentences.
 * Bounded by MAX_VERIFY_QUERIES so cost stays capped.
 */
async function deriveVerifyQueries(
  answer: string,
  citations: Citation[],
  deps: DeepResearchDeps,
): Promise<string[]> {
  // Prefer the sharper LLM-based claim extraction when provided, but stay
  // fail-soft: if it throws or yields nothing usable, fall back to the
  // structural weakly-backed-claim path so verification never crashes research.
  let candidates: string[] | null = null;
  if (deps.extractClaims) {
    try {
      const extracted = (await deps.extractClaims(answer))
        .map(stripMarkers)
        .filter((s) => s.length > 0);
      if (extracted.length > 0) candidates = extracted;
    } catch {
      candidates = null;
    }
  }
  if (candidates === null) {
    candidates = citations
      .filter((c) => c.corroboration !== "corroborated")
      .map((c) => stripMarkers(c.claim));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of candidates) {
    if (q.length < 8 || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
    if (out.length >= MAX_VERIFY_QUERIES) break;
  }
  return out;
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

// ── orchestration ────────────────────────────────────────────────────────────

/**
 * Run multi-step research: decompose → parallel search → cited synthesis →
 * bounded cross-verification. Yields progress events as an async generator so
 * the gateway can relay them over SSE.
 */
export async function* deepResearch(
  query: string,
  options: DeepResearchOptions,
  deps: DeepResearchDeps,
): AsyncGenerator<DeepResearchEvent> {
  try {
    const { depth } = options;
    const count = subQueryCount(depth);
    const passes = verificationPassCount(depth, options.verification?.passes);
    const ceiling = sourceCeiling(depth, options.maxSources);

    const subQueries =
      count === 1 ? [query] : await deps.decompose(query, count);
    yield { type: "queries", queries: subQueries };

    const settled = await Promise.all(
      subQueries.map(async (subQuery, index) => {
        try {
          return { index, results: await deps.search(subQuery) };
        } catch {
          return { index, results: [] as SearchResult[] };
        }
      }),
    );

    const collected: SearchResult[] = [];
    for (const { index, results } of settled.sort((a, b) => a.index - b.index)) {
      yield { type: "search_complete", index, results };
      collected.push(...results);
    }
    let sources = consolidate(collected, ceiling);

    // Stream a synthesis and capture its full text. The final synthesis is the
    // one shown to the user (streamed as answer_chunk); intermediate refinements
    // during verification are buffered (no answer_chunk) so the UI sees the
    // answer exactly once.
    const synthesizeStreamed = async function* (): AsyncGenerator<
      DeepResearchEvent,
      string
    > {
      yield { type: "synthesizing", sourceCount: sources.length };
      let answer = "";
      for await (const chunk of deps.synthesize(query, formatContext(sources))) {
        answer += chunk;
        yield { type: "answer_chunk", text: chunk };
      }
      return answer;
    };

    let answer: string;
    let passesRun = 0;

    if (passes === 0) {
      answer = yield* synthesizeStreamed();
    } else {
      // Initial draft, buffered: used only to find weakly-backed claims.
      answer = await collect(deps.synthesize(query, formatContext(sources)));
      let streamed = false;

      for (let pass = 1; pass <= passes; pass++) {
        const citations = bindCitations(answer, sources);
        const verifyQueries = await deriveVerifyQueries(answer, citations, deps);
        // Nothing weak left to corroborate → stop early (bounded, honest).
        if (verifyQueries.length === 0) break;
        passesRun = pass;
        yield { type: "verifying", pass, claims: verifyQueries };

        const found = await Promise.all(
          verifyQueries.map(async (q) => {
            try {
              return await deps.search(q);
            } catch {
              return [] as SearchResult[];
            }
          }),
        );
        const before = sources.length;
        sources = consolidate([...sources, ...found.flat()], ceiling);
        const newSources = Math.max(0, sources.length - before);

        // Stream the final planned pass directly to the user; buffer earlier
        // refinements so the answer is shown exactly once.
        if (pass === passes) {
          answer = yield* synthesizeStreamed();
          streamed = true;
        } else {
          answer = await collect(
            deps.synthesize(query, formatContext(sources)),
          );
        }

        const refined = summarize(bindCitations(answer, sources), pass);
        yield {
          type: "verification_complete",
          pass,
          newSources,
          corroborated: refined.corroboratedClaims,
          uncorroborated: refined.uncitedClaims,
        };
      }

      // If verification bailed before the streaming pass (no weak claims left),
      // the user has not seen a streamed answer yet — present it now.
      if (!streamed) {
        answer = yield* synthesizeStreamed();
      }
    }

    const citations = bindCitations(answer, sources);

    // Conflict detection (depth refinement): for claims that ARE corroborated
    // (≥2 distinct domains back them), check whether those sources actually
    // AGREE. A claim whose backing sources contradict is flagged `conflict`
    // (and a `conflict` event is emitted) so the UI can show "sources disagree".
    // Conservative + bounded: only corroborated claims are checked, the number
    // of checks is capped by MAX_VERIFY_QUERIES, and any error/uncertain verdict
    // defaults to NO conflict — a conflict is never fabricated.
    if (deps.detectConflict) {
      let checks = 0;
      for (const c of citations) {
        if (checks >= MAX_VERIFY_QUERIES) break;
        if (c.corroboration !== "corroborated") continue;
        checks++;
        let conflicted = false;
        try {
          conflicted = await deps.detectConflict(stripMarkers(c.claim), c.sources);
        } catch {
          conflicted = false;
        }
        if (conflicted) {
          c.conflict = true;
          yield { type: "conflict", claim: c.claim, sources: c.sources };
        }
      }
    }

    yield {
      type: "done",
      sources,
      citations,
      verification: summarize(citations, passesRun),
    };
  } catch (error) {
    yield {
      type: "error",
      message: error instanceof Error ? error.message : "Research failed",
    };
  }
}
