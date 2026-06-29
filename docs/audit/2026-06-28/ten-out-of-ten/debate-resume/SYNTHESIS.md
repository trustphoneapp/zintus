# 5-Agent Brutal Debate — Resume Synthesis (2026-06-28)

Branch `feat/zintus-10-10`. Five agents re-judged the project against the literal
10/10 bar, reading **current code** (not commit messages or the older audit docs).
Baseline at debate time: typecheck exit 0, tests exit 0, ~1383–1413 pass / 0 fail.

## Scores (honest, vs named competitors)

| Axis | Score | Note |
|---|:--:|---|
| Moat (Tokzen savings / no-custody) | 10 | uncopyable; unchanged |
| Transparency (route-reason all 4 surfaces) | 10 | no competitor has it |
| Honesty discipline | 9 | held off 10 by the catalog over-claim |
| Consistency ("one Zintus") | 8 | route-reason/tools/MCP/structured span web+desktop+CLI+mobile |
| Router vs OpenRouter | 7 | latency measured but hidden; 37 routable « 400+ |
| Assistant vs ChatGPT/Claude/Gemini | 7 | artifacts is a viewer; mobile has no multimodal |
| Research vs Perplexity | 6 | no conflict detection; `extractClaims` built but unwired |
| Agentic vs Cursor | 5 | sandbox real; no run/verify step ("deliberately NO shell") |

**Honest overall ≈ 7/10.** Gap to 10 is mostly *evidence + a few honesty drifts*,
not fabricated features. Detail per agent: `01-router.md` … `05-skeptic.md`.

## Corroborated must-fixes (codeable, highest priority)

1. **Catalog over-claim** (agents 1,4,5) — `apps/web/data/providers.ts` advertises
   ~55–60 providers / ~100 models incl. Anthropic/OpenAI/"GPT-5.5" with "Add your
   key" badges, but `ProviderId` is a closed 12-member union and only 12 route
   (`packages/router/src/factory.ts`). ~47 rows imply a route that doesn't exist.
   Fix: relabel non-routable rows "Planned"/"Not yet routable" (no "Add your key").
2. **Install 404** (agent 5) — `bun install -g zintus` 404s (`zintus` unpublished).
   Fix the Hero copy to honest beta/coming-soon until [HUMAN] publishes to npm.
3. **Green-by-fake seams** (agent 5) — MCP/research/agent tested only against fakes.
   Add ≥1 real-loop integration test per flagship (real stdio MCP server; local
   echo-LLM provider emitting a genuine tool_call).
4. **Docs drift** (agents 4,5) — FEATURE-MATRIX stale-pessimistic (keyring #19 +
   Private Mode "unknown leak" are fixed in code); RELEASE-HARDENING §6 over-claims
   CLI structured output; scorecard citations point at the wrong `chat/page.tsx`
   path; PR still says "10/10". Reconcile docs ↔ code.

## Per-axis codeable levers (ranked)

- **Router:** expose measured p95 latency (+derive throughput/uptime from
  `usage_log`) in `/v1/models`; wire durable activity store into `/usage` UI
  (currently in-memory last-5); accept OpenRouter-style
  `provider:{order,sort,allow_fallbacks}` body; grow routable breadth via
  `openai-compat` adapters (conservative/honest).
- **Assistant:** make artifacts iterative (edit→revise→version); CLI
  `response_format` request (closes the over-claim by building it); cross-surface
  multimodal wiring (desktop PDF+voice).
- **Research:** wire `extractClaims` into gateway deps; per-claim support/entailment
  check + a `conflict` event.
- **Agentic (largest):** add a `run_command`/verify step behind a tight allowlist
  sandbox — the defining Cursor loop; biggest single lever, needs careful security.
- **Consistency:** mobile artifacts (pure code); mobile image/voice are device-gated.

## [HUMAN] / device / business launch gates (deferred to end — real blockers)

CSP browser-verify · desktop signing/notarization (mac/win/linux clean-device) ·
mobile EAS + native image/voice modules + on-device run · publish `zintus` to npm ·
one keyed live run of each flagship (agent / MCP-vs-real-server / research+web /
image→vision) · legal (privacy live, account-delete deploy, encryption-export
sign-off, consent disclosure) · app-store submission · live billing + referral
payouts. Full ledger in `04-consistency-human.md`.

## Build order (codeable-first)
Wave 1 honesty (1,2,4) → Wave 2 credibility (3) → Wave 3 router → Wave 4 assistant +
research → Wave 5 agentic run/verify. Verify (typecheck+test) + commit each; keep
the suite green; honesty + free-core + no-custody hold throughout.
