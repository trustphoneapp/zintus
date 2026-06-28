# Zintus 10/10 Competitor-Benchmark Verdict (2026-06-28)

*Capstone of the 10/10 initiative. 4 agents benchmarked the BUILT state of
`feat/zintus-10-10` (features + UI) against the top competitors, per platform, with
web research + code verification. This synthesis reconciles their scores against the
code (correcting two stale reads), and states the honest verdict + the path to 10/10.
Per-axis detail: `01-vs-openrouter.md`, `02-vs-assistants.md`,
`03-vs-research-agentic.md`, `04-consistency-honesty.md`.*

## Verdict: 10/10? **NO — honest overall ≈ 6.5/10.** One axis is a genuine 10.

Zintus is a **real, differentiated product with an uncopyable moat and rare honesty
discipline** — but it is not yet best-in-class on breadth, cross-platform
consistency, or a few table-stakes features. It is a credible **beta+**, not a 10/10
across all surfaces.

## Scorecard (benchmarked + code-verified)

| Axis | Score | vs best | Verdict |
|---|:--:|:--:|---|
| **Moat** (Tokzen savings ledger, no-custody/local-first, capability/quota/privacy intel) | **10/10** | — | Genuinely uncopyable; OpenRouter/assistants/Cursor have none of it |
| **Transparency / route-reason** | **10/10** | — | Per-response "why this provider/model" + measured savings; no competitor surfaces it |
| **Honesty discipline** | **9/10** | — | Null prices not invented, `managed_keys:false`, "coming soon" not fake controls (2 violations found + fixed) |
| Router / model marketplace (vs OpenRouter) | 6/10 | 9 | Catalog 23 routable (vs 400+); no BYOK priority/fallback keys; activity in-memory |
| Chat experience (vs ChatGPT/Claude/Gemini) | 6.5/10 | 9 | image ✅, UX ✅, route-reason ✅; **voice 1**, no artifacts/canvas, web structured-UI unreachable |
| Research (vs Perplexity) | 6/10 | 9 | Real cited pipeline; single-pass, no cross-verify |
| Agentic coding (vs Cursor) | 3/10 | 9 | Good local codebase-RAG; **no agent loop / file edits**; CLI `--tools` prints, doesn't execute |
| **Cross-platform consistency** | **5/10** | 10 | Moat-footer floor uniform (real "one Zintus"); the new flagships are web/desktop-only |

## Reconciliations (corrected against code)
- **Route-reason is REAL** (`engine.ts buildRouteReason`, surfaced Phase 1b + 6) — the research agent's "missing (P0)" is stale; the assistants + OpenRouter agents confirm it. **But it is web-only** (the consistency finding stands: desktop/CLI/mobile don't surface it).
- **Desktop image input now works** (Phase 7) — the FEATURE-MATRIX "desktop refused" line is **stale** and is being truthed-up.
- **Structured output is inverted**: desktop got a request toggle (Phase 7), **web chat still can't request it** — a real web↔desktop inconsistency + an unreachable catalog "JSON" chip.

## Honesty violations — FOUND + FIXED this pass
1. `pricing/page.tsx` referral "Paid out monthly via Stripe" asserted a payout that doesn't exist (`REFERRAL_PAYOUTS_LIVE=false`) → softened to **"Payouts coming soon; referrals tracked from day one."**
2. `Hero.tsx` `npm install -g zintus` (CLI is Bun-only) + `zintus@2.0.0` (real 0.2.0) → fixed to **`bun install -g zintus`** + **`0.2.0`**.
- **Watch (not yet fixed):** `/catalog` lists 55 providers but only 12 are engine-wired; the 43 `add-key` rows have no real adapter route — the badge is honest about integration status but "add your key" implies a route that doesn't exist for most. Recommend a clarifying sub-label.

## What is genuinely 10/10 today
The **moat** (provable savings + no-custody + intelligence) and **route-reason
transparency** — the two things no competitor has. This is the category Zintus owns.

## Path to 10/10 (prioritized, honest)
**Consistency (the biggest 10/10 blocker — codeable):**
1. Web chat **structured-output toggle** (mirror desktop) — closes the inversion.
2. **Route-reason on CLI** (+ tokens/cost/quota in output) and desktop.
3. **Mobile**: tools + image + route-reason + catalog (the serious app lacks the new flagships) — the [HUMAN] rebase track.

**Breadth / table-stakes:**
4. Catalog: more routable models + live latency/throughput/uptime stats.
5. **BYOK priority + fallback keys** (OpenRouter parity).
6. **Voice input** (all three assistants have it; Zintus has none).
7. Durable activity store (30-day) + dashboard; full priced-model coverage.

**Depth (pick a lane):**
8. Either a real **agent loop + apply-diff** (to fight Cursor) or reframe agentic as "private local context layer" (stop over-promising).
9. Research: multi-pass + cross-verify + structurally-bound citations (6→8).

**[HUMAN]/device (unchanged):** in-browser CSP verify; desktop signed native builds; mobile EAS/device + store; legal/store; live billing.

## Progress since this verdict (committed + code-verified — NOT yet re-benchmarked)
Closing the path-to-10 gaps, codeable-first (each committed, suite green):
- **A1** web structured-output toggle → closes the web↔desktop inversion (catalog "JSON" chip now reachable). *Chat-experience structured: 3 → reachable on web.*
- **A2** route-reason on **CLI + desktop** (was web-only) + **removed the fabricated 1,000,000 quota denominator on BOTH** CLI and desktop ("limit unknown" instead). *Consistency: route-reason now web+desktop+CLI; honesty hardened.*
- **B3** durable sqlite activity store (30-day, machine-local) → `/v1/activity` is persistent, not in-memory. *Router/marketplace activity: 5 → durable.*
- **C1** voice input (Web Speech API dictation, honest browser-support + privacy). *Chat-experience voice: 1 → present on web.*
- Fixed a desktop consent bug (image-only first send dropped) found in fresh review.
These are real, committed improvements; **a fresh 4-agent re-benchmark is required before claiming new axis scores** (estimated movement: consistency 5→~7, chat-experience 6.5→~7.5 — mobile parity + B1/B2 remain). Remaining: **B1** catalog breadth (per-model capability-verified — honesty-sensitive), **B2** BYOK priority/fallback keys, **C2** files/PDF, **D** agentic/research, and the mobile [HUMAN] track.

## Bottom line
Zintus has a **10/10 moat and honesty story** wrapped in a **~6.5/10 product** —
strong, differentiated, and honest, but not yet best-in-class on breadth,
consistency, or voice/agentic depth. The path to 10/10 is concrete and mostly
codeable; the moat means it's a real category, not a clone.
