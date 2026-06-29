import { describe, expect, test, mock } from "bun:test";
import {
  deepResearch,
  subQueryCount,
  verificationPassCount,
  deepeningRoundCount,
  sourceCeiling,
  normalizeUrl,
  dedupeResults,
  rankSources,
  bindCitations,
  MAX_VERIFICATION_PASSES,
  MAX_DEEPENING_ROUNDS,
  MAX_SOURCES,
  type DeepResearchDeps,
  type DeepResearchEvent,
  type ResearchSource,
  type SearchResult,
} from "./index.js";

// Drive the pipeline with deterministic fakes — no live LLM or network. We
// collect every emitted event so we can assert structure (pass counts, citation
// binding, dedup/ranking) and that the /v1/research event contract is intact.
async function run(
  query: string,
  options: Parameters<typeof deepResearch>[1],
  deps: DeepResearchDeps,
): Promise<DeepResearchEvent[]> {
  const events: DeepResearchEvent[] = [];
  for await (const event of deepResearch(query, options, deps)) {
    events.push(event);
  }
  return events;
}

function doneEvent(events: DeepResearchEvent[]) {
  const done = events.find((e) => e.type === "done");
  if (!done || done.type !== "done") throw new Error("no done event");
  return done;
}

// ── bounded pass config ──────────────────────────────────────────────────────

describe("verificationPassCount", () => {
  test("per-depth defaults (not a magic 1/3/5)", () => {
    expect(verificationPassCount("quick")).toBe(0);
    expect(verificationPassCount("standard")).toBe(1);
    expect(verificationPassCount("deep")).toBe(2);
  });

  test("configurable, clamped to [0, cap]", () => {
    expect(verificationPassCount("standard", 0)).toBe(0);
    expect(verificationPassCount("standard", 2)).toBe(2);
    // Hard cap protects cost.
    expect(verificationPassCount("deep", 99)).toBe(MAX_VERIFICATION_PASSES);
    expect(verificationPassCount("deep", -5)).toBe(0);
  });
});

describe("deepeningRoundCount", () => {
  test("per-depth defaults (none for quick, lighter for standard)", () => {
    expect(deepeningRoundCount("quick")).toBe(0);
    expect(deepeningRoundCount("standard")).toBe(1);
    expect(deepeningRoundCount("deep")).toBe(2);
  });

  test("configurable, clamped to [0, cap]", () => {
    expect(deepeningRoundCount("deep", 0)).toBe(0);
    expect(deepeningRoundCount("deep", 99)).toBe(MAX_DEEPENING_ROUNDS);
    expect(deepeningRoundCount("standard", -5)).toBe(0);
  });
});

describe("sourceCeiling", () => {
  test("raises the hit ceiling per depth, bounded by MAX_SOURCES", () => {
    expect(sourceCeiling("quick")).toBe(8);
    expect(sourceCeiling("standard")).toBe(20);
    expect(sourceCeiling("deep")).toBe(30);
    expect(sourceCeiling("deep", 1000)).toBe(MAX_SOURCES);
    expect(sourceCeiling("deep", 0)).toBe(1);
  });
});

// ── dedup + ranking ──────────────────────────────────────────────────────────

describe("normalizeUrl + dedupeResults", () => {
  test("collapses protocol/www/trailing-slash variants", () => {
    expect(normalizeUrl("https://www.A.com/x/")).toBe(
      normalizeUrl("http://a.com/x"),
    );
  });

  test("dedups duplicate URLs, keeping the higher score, dropping urless", () => {
    const out = dedupeResults([
      { title: "low", url: "https://a.com/x", content: "c", score: 0.2 },
      { title: "high", url: "https://www.a.com/x/", content: "c", score: 0.9 },
      { title: "other", url: "https://b.com", content: "c" },
      { title: "no-url", url: "", content: "c" },
    ]);
    expect(out.length).toBe(2);
    const a = out.find((r) => normalizeUrl(r.url) === "a.com/x");
    expect(a?.title).toBe("high");
  });
});

describe("rankSources", () => {
  test("orders by score desc, then recency, and assigns stable ids", () => {
    const ranked = rankSources([
      { title: "mid", url: "https://m.com", content: "c", score: 0.5 },
      { title: "top", url: "https://t.com", content: "c", score: 0.9 },
      {
        title: "newer",
        url: "https://n.com",
        content: "c",
        score: 0.5,
        publishedAt: "2026-01-01",
      },
    ]);
    expect(ranked.map((r) => r.title)).toEqual(["top", "newer", "mid"]);
    expect(ranked.map((r) => r.id)).toEqual(["s1", "s2", "s3"]);
    expect(ranked[0]?.domain).toBe("t.com");
  });
});

// ── structural citation binding ──────────────────────────────────────────────

describe("bindCitations", () => {
  const sources: ResearchSource[] = [
    { id: "s1", domain: "a.com", title: "A", url: "https://a.com", content: "c" },
    { id: "s2", domain: "b.com", title: "B", url: "https://b.com", content: "c" },
  ];

  test("binds each claim to concrete source objects, flags uncited honestly", () => {
    const citations = bindCitations(
      "Earth is round [1][2]. It is also blue [1]. This part has no source.",
      sources,
    );
    expect(citations.length).toBe(3);

    // ≥2 distinct domains → corroborated, bound to real source objects.
    expect(citations[0]?.sourceIds.sort()).toEqual(["s1", "s2"]);
    expect(citations[0]?.sources.map((s) => s.url)).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
    expect(citations[0]?.corroboration).toBe("corroborated");
    expect(citations[0]?.uncited).toBe(false);

    // One domain → single-source.
    expect(citations[1]?.corroboration).toBe("single-source");

    // No marker → uncited, never given a fake citation.
    expect(citations[2]?.uncited).toBe(true);
    expect(citations[2]?.sources).toEqual([]);
    expect(citations[2]?.corroboration).toBe("uncited");
  });

  test("out-of-range markers do not fabricate a source", () => {
    const citations = bindCitations("Claim cites a missing source [9].", sources);
    expect(citations[0]?.uncited).toBe(true);
    expect(citations[0]?.sourceIds).toEqual([]);
  });
});

// ── orchestration ────────────────────────────────────────────────────────────

describe("deepResearch verification pipeline", () => {
  test("quick depth runs zero verification passes and streams once", async () => {
    const synthesize = mock(async function* () {
      yield "Quick answer [1].";
    });
    const events = await run(
      "q",
      { depth: "quick" },
      {
        decompose: async () => ["x"],
        search: async () => [
          { title: "T", url: "https://t.com", content: "c", score: 0.5 },
        ],
        synthesize,
      },
    );
    expect(events.some((e) => e.type === "verifying")).toBe(false);
    // Streamed exactly once.
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(doneEvent(events).verification.passes).toBe(0);
    expect(events.filter((e) => e.type === "answer_chunk").length).toBe(1);
  });

  test("standard depth runs a bounded verification pass with verifying events", async () => {
    const searched: string[] = [];
    let synthCalls = 0;
    const events = await run(
      "main question about topic",
      { depth: "standard" },
      {
        decompose: async (_q, n) =>
          Array.from({ length: n }, (_, i) => `sub query number ${i}`),
        search: async (q) => {
          searched.push(q);
          // Distinct URL per query so we accumulate real, deduped sources.
          return [
            {
              title: `Title ${q}`,
              url: `https://site-${searched.length}.com/page`,
              content: "evidence",
              score: 0.5,
            },
          ];
        },
        synthesize: async function* () {
          synthCalls++;
          yield "A specific factual claim that needs corroboration here.";
        },
      },
    );

    // Verification ran: a verifying + verification_complete event for pass 1.
    const verifying = events.filter((e) => e.type === "verifying");
    expect(verifying.length).toBe(1);
    expect(verifying[0]).toMatchObject({ type: "verifying", pass: 1 });
    expect(events.some((e) => e.type === "verification_complete")).toBe(true);

    // The verification pass fired additional corroboration searches beyond the
    // initial 3 sub-queries.
    expect(searched.length).toBeGreaterThan(3);
    // Initial buffered draft + streamed final synthesis = 2 synthesis turns.
    expect(synthCalls).toBe(2);

    const done = doneEvent(events);
    expect(done.verification.passes).toBe(1);
    // The user still sees a single streamed answer.
    expect(events.filter((e) => e.type === "answer_chunk").length).toBe(1);
  });

  test("pass count is honored and hard-capped", async () => {
    let passSeen = 0;
    const events = await run(
      "deep dive question",
      { depth: "deep", verification: { passes: 99 } },
      {
        decompose: async (_q, n) =>
          Array.from({ length: n }, (_, i) => `q${i}`),
        search: async (q) => [
          {
            title: q,
            // Unique URL each call → new weak claims keep being found so the
            // loop would run forever if not capped.
            url: `https://u-${Math.random()}.com`,
            content: "c",
            score: 0.5,
          },
        ],
        synthesize: async function* () {
          yield "An unsupported assertion with no inline marker at all.";
        },
      },
    );
    passSeen = events.filter((e) => e.type === "verifying").length;
    // Requested 99 but capped at MAX_VERIFICATION_PASSES.
    expect(passSeen).toBeLessThanOrEqual(MAX_VERIFICATION_PASSES);
    expect(doneEvent(events).verification.passes).toBeLessThanOrEqual(
      MAX_VERIFICATION_PASSES,
    );
  });

  test("done event carries structurally-bound citations; uncited claims flagged", async () => {
    const events = await run(
      "q",
      { depth: "quick" },
      {
        decompose: async () => ["x"],
        search: async () => [
          { title: "Src", url: "https://src.com", content: "c", score: 0.9 },
        ],
        synthesize: async function* () {
          yield "Backed claim [1]. Unbacked claim with no source.";
        },
      },
    );
    const done = doneEvent(events);
    expect(done.citations.length).toBe(2);
    expect(done.citations[0]?.sources[0]?.url).toBe("https://src.com");
    expect(done.citations[0]?.uncited).toBe(false);
    expect(done.citations[1]?.uncited).toBe(true);
    expect(done.verification.uncitedClaims).toBe(1);
    // Sources are promoted to ResearchSource with ids.
    expect(done.sources[0]?.id).toBe("s1");
  });

  test("dedup collapses duplicate URLs across sub-queries", async () => {
    const events = await run(
      "topic",
      { depth: "standard", verification: { passes: 0 } },
      {
        decompose: async (_q, n) => Array.from({ length: n }, (_, i) => `s${i}`),
        // Every sub-query returns the same URL → deduped to one source.
        search: async () => [
          { title: "dup", url: "https://same.com/x", content: "c" },
        ],
        synthesize: async function* () {
          yield "answer";
        },
      },
    );
    expect(doneEvent(events).sources.length).toBe(1);
  });

  test("event contract: types/order preserved for the gateway SSE relay", async () => {
    const events = await run(
      "q",
      { depth: "quick" },
      {
        decompose: async () => ["x"],
        search: async () => [
          { title: "T", url: "https://t.com", content: "c" },
        ],
        synthesize: async function* () {
          yield "ans [1].";
        },
      },
    );
    const types = events.map((e) => e.type);
    // The original event vocabulary the gateway/clients depend on.
    expect(types[0]).toBe("queries");
    expect(types).toContain("search_complete");
    expect(types).toContain("synthesizing");
    expect(types).toContain("answer_chunk");
    expect(types[types.length - 1]).toBe("done");
    expect(types).not.toContain("error");
  });

  test("respects the source ceiling (bounded hit count)", async () => {
    const big: SearchResult[] = Array.from({ length: 50 }, (_, i) => ({
      title: `t${i}`,
      url: `https://d${i}.com`,
      content: "c",
      score: Math.random(),
    }));
    const events = await run(
      "q",
      { depth: "quick", maxSources: 5 },
      {
        decompose: async () => ["x"],
        search: async () => big,
        synthesize: async function* () {
          yield "a";
        },
      },
    );
    expect(doneEvent(events).sources.length).toBe(5);
    expect(5).toBeLessThanOrEqual(MAX_SOURCES);
  });

  test("falls back to structural extraction when extractClaims throws (fail-soft)", async () => {
    const searched: string[] = [];
    const events = await run(
      "main question about a topic",
      { depth: "standard" },
      {
        decompose: async (_q, n) => Array.from({ length: n }, (_, i) => `s${i}`),
        search: async (q) => {
          searched.push(q);
          return [
            { title: q, url: `https://u${searched.length}.com`, content: "c" },
          ];
        },
        synthesize: async function* () {
          yield "A specific factual claim that needs corroboration here.";
        },
        // Throws → must not crash research; verification still runs structurally.
        extractClaims: async () => {
          throw new Error("extractor unavailable");
        },
      },
    );
    // Research completed (no error event) and a verification pass still ran.
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "verifying")).toBe(true);
    expect(searched.length).toBeGreaterThan(3);
  });

  // ── conflict detection ──────────────────────────────────────────────────────

  const conflictDeps = (
    detectConflict: DeepResearchDeps["detectConflict"],
  ): DeepResearchDeps => ({
    decompose: async () => ["x"],
    // Two distinct domains so a [1][2] claim is structurally "corroborated".
    search: async () => [
      { title: "A says 10", url: "https://a.com", content: "X is 10", score: 0.9 },
      { title: "B says 50", url: "https://b.com", content: "X is 50", score: 0.8 },
    ],
    synthesize: async function* () {
      yield "The value of X is disputed [1][2].";
    },
    detectConflict,
  });

  test("contradicting sources → claim flagged conflicted + conflict event", async () => {
    const detectConflict = mock(async () => true);
    const events = await run("q", { depth: "quick" }, conflictDeps(detectConflict));

    expect(detectConflict).toHaveBeenCalled();
    // A conflict progress event was emitted for the disputed claim.
    const conflict = events.find((e) => e.type === "conflict");
    expect(conflict?.type).toBe("conflict");
    if (conflict?.type === "conflict") {
      expect(conflict.claim).toContain("disputed");
      expect(conflict.sources.length).toBe(2);
    }

    const done = doneEvent(events);
    const claim = done.citations[0];
    // Conflict refines corroboration — it does NOT relabel it.
    expect(claim?.corroboration).toBe("corroborated");
    expect(claim?.conflict).toBe(true);
    expect(done.verification.conflictedClaims).toBe(1);
    expect(done.verification.corroboratedClaims).toBe(1);
  });

  test("agreeing sources → still corroborated, never conflicted", async () => {
    const detectConflict = mock(async () => false);
    const events = await run("q", { depth: "quick" }, conflictDeps(detectConflict));

    expect(detectConflict).toHaveBeenCalled();
    expect(events.some((e) => e.type === "conflict")).toBe(false);
    const done = doneEvent(events);
    expect(done.citations[0]?.corroboration).toBe("corroborated");
    expect(done.citations[0]?.conflict).toBeFalsy();
    expect(done.verification.conflictedClaims).toBe(0);
  });

  test("detector that throws defaults to no conflict (never fabricated)", async () => {
    const events = await run(
      "q",
      { depth: "quick" },
      conflictDeps(async () => {
        throw new Error("judge unavailable");
      }),
    );
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "conflict")).toBe(false);
    expect(doneEvent(events).verification.conflictedClaims).toBe(0);
  });

  test("no detectConflict dep → conflict detection is skipped entirely", async () => {
    const events = await run("q", { depth: "quick" }, conflictDeps(undefined));
    expect(events.some((e) => e.type === "conflict")).toBe(false);
    expect(doneEvent(events).verification.conflictedClaims).toBe(0);
  });

  test("single-source claims are not checked for conflict", async () => {
    const detectConflict = mock(async () => true);
    const events = await run(
      "q",
      { depth: "quick" },
      {
        decompose: async () => ["x"],
        search: async () => [
          { title: "Only", url: "https://only.com", content: "c", score: 0.9 },
        ],
        synthesize: async function* () {
          yield "A single-sourced claim [1].";
        },
        detectConflict,
      },
    );
    // Only corroborated (≥2 distinct domains) claims are candidates.
    expect(detectConflict).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "conflict")).toBe(false);
    expect(doneEvent(events).verification.conflictedClaims).toBe(0);
  });

  test("uses extractClaims dep to drive corroboration when provided", async () => {
    const extractClaims = mock(async () => ["targeted corroboration query here"]);
    const searched: string[] = [];
    await run(
      "q",
      { depth: "standard" },
      {
        decompose: async (_q, n) => Array.from({ length: n }, (_, i) => `s${i}`),
        search: async (q) => {
          searched.push(q);
          return [
            { title: q, url: `https://u${searched.length}.com`, content: "c" },
          ];
        },
        synthesize: async function* () {
          yield "Some drafted answer text.";
        },
        extractClaims,
      },
    );
    expect(extractClaims).toHaveBeenCalled();
    expect(searched).toContain("targeted corroboration query here");
  });
});

// ── iterative deepening ──────────────────────────────────────────────────────

describe("deepResearch iterative deepening", () => {
  // Synthesis that reports how many sources it was given (one [n] marker per
  // source in the formatted context), plus an uncited gap claim so every round
  // still finds something to deepen on.
  const countingSynth = async function* (
    _q: string,
    context: string,
  ): AsyncGenerator<string> {
    const n = (context.match(/\[\d+\]/g) ?? []).length;
    yield `Synthesis drawn from ${n} sources, with an uncited gap claim that needs more support here.`;
  };

  function doneDeepening(events: DeepResearchEvent[]) {
    return doneEvent(events).deepening;
  }

  test("deep depth deepens: a gap triggers a follow-up search + re-synthesis with a new source", async () => {
    let searchCount = 0;
    const events = await run(
      "a deep question about a complex topic",
      { depth: "deep", verification: { passes: 0 }, deepening: { rounds: 1 } },
      {
        decompose: async (_q, n) =>
          Array.from({ length: n }, (_, i) => `distinct subquestion ${i}`),
        // Unique URL per call so follow-ups add genuinely new sources.
        search: async () => {
          searchCount++;
          return [
            {
              title: `Source ${searchCount}`,
              url: `https://src-${searchCount}.com/p`,
              content: "evidence",
              score: 0.5,
            },
          ];
        },
        synthesize: countingSynth,
      },
    );

    // A deepening round was announced with follow-up queries.
    const deepening = events.filter((e) => e.type === "deepening");
    expect(deepening.length).toBeGreaterThanOrEqual(1);
    if (deepening[0]?.type === "deepening") {
      expect(deepening[0].round).toBe(1);
      expect(deepening[0].followups.length).toBeGreaterThan(0);
    }

    // It fired follow-up searches beyond the initial 5 sub-queries…
    expect(searchCount).toBeGreaterThan(subQueryCount("deep"));
    // …and the final answer incorporated the new sources (more than the initial set).
    const done = doneEvent(events);
    expect(done.sources.length).toBeGreaterThan(subQueryCount("deep"));
    const finalAnswer = events
      .filter((e) => e.type === "answer_chunk")
      .map((e) => (e.type === "answer_chunk" ? e.text : ""))
      .join("");
    expect(finalAnswer).toContain(`from ${done.sources.length} sources`);

    // Deepening summary surfaced on done (additive).
    expect(done.deepening.rounds).toBe(1);
    expect(done.deepening.newSources).toBeGreaterThan(0);
    // Verification was disabled, so deepening ran independently of it.
    expect(events.some((e) => e.type === "verifying")).toBe(false);
  });

  test("deepening round count respects the depth cap", async () => {
    const events = await run(
      "deep question with persistent gaps",
      { depth: "deep", deepening: { rounds: 99 } },
      {
        decompose: async (_q, n) =>
          Array.from({ length: n }, (_, i) => `subquestion topic ${i}`),
        // Unique URL each call → new weak claims keep appearing, so without a
        // cap the loop would deepen forever.
        search: async (q) => [
          {
            title: q,
            url: `https://u-${Math.random()}.com`,
            content: "c",
            score: 0.5,
          },
        ],
        synthesize: async function* () {
          yield "An unsupported assertion that clearly needs more corroboration here.";
        },
      },
    );
    const deepening = events.filter((e) => e.type === "deepening");
    expect(deepening.length).toBeLessThanOrEqual(MAX_DEEPENING_ROUNDS);
    expect(doneDeepening(events).rounds).toBeLessThanOrEqual(
      MAX_DEEPENING_ROUNDS,
    );
  });

  test("quick depth does zero deepening (unchanged single pass)", async () => {
    let synthCalls = 0;
    const events = await run(
      "q",
      { depth: "quick" },
      {
        decompose: async () => ["x"],
        search: async () => [
          { title: "T", url: "https://t.com", content: "c", score: 0.5 },
        ],
        synthesize: async function* () {
          synthCalls++;
          yield "Quick answer with an uncited gap claim that needs more support here.";
        },
      },
    );
    expect(events.some((e) => e.type === "deepening")).toBe(false);
    expect(doneDeepening(events).rounds).toBe(0);
    expect(doneDeepening(events).newSources).toBe(0);
    expect(synthCalls).toBe(1);
  });

  test("a thrown follow-up search falls back to the first answer (fail-soft)", async () => {
    let calls = 0;
    const events = await run(
      "q",
      { depth: "deep", verification: { passes: 0 }, deepening: { rounds: 1 } },
      {
        decompose: async (_q, n) =>
          Array.from({ length: n }, (_, i) => `initial sub ${i}`),
        search: async () => {
          calls++;
          // The 5 initial sub-query searches succeed; the deepening follow-up
          // search (call 6+) explodes.
          if (calls <= subQueryCount("deep")) {
            return [
              {
                title: `S${calls}`,
                url: `https://s${calls}.com`,
                content: "c",
                score: 0.5,
              },
            ];
          }
          throw new Error("follow-up search exploded");
        },
        synthesize: countingSynth,
      },
    );

    // Never crashed.
    expect(events.some((e) => e.type === "error")).toBe(false);
    // A deepening attempt was announced before it failed.
    expect(events.some((e) => e.type === "deepening")).toBe(true);
    // Fell back to the FIRST answer (the 5 initial sources), not a re-synthesis
    // with merged follow-up sources.
    const finalAnswer = events
      .filter((e) => e.type === "answer_chunk")
      .map((e) => (e.type === "answer_chunk" ? e.text : ""))
      .join("");
    expect(finalAnswer).toContain(`from ${subQueryCount("deep")} sources`);
    // The failed round did not count or add sources.
    expect(doneDeepening(events).rounds).toBe(0);
    expect(doneDeepening(events).newSources).toBe(0);
  });
});

describe("subQueryCount (unchanged)", () => {
  test("quick/standard/deep", () => {
    expect(subQueryCount("quick")).toBe(1);
    expect(subQueryCount("standard")).toBe(3);
    expect(subQueryCount("deep")).toBe(5);
  });
});
