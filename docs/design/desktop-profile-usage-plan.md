# Desktop Profile / Per-Model Usage — Plan (2026-07-14)

Brief: build "something near" the Codex profile page (reference screenshot:
avatar + handle + plan badge, stat strip, token-activity heatmap, activity
insights, most-used plugins) in the Zintus desktop app — but SIMPLER, not a
copy, centered on **each used model and its tokens**. Fable plan; grounded in
a 103-agent adversarially-verified research pass (all findings 3-0 unless
noted).

## What the research established

- **Two-tier pattern.** Codex profiles are an identity/social surface
  (streaks, lifetime tokens, peak day, share cards, feature insights — and
  notably NO per-model breakdown). Operator dashboards (OpenRouter Activity,
  Cursor, Anthropic Console, OpenAI API dashboard) converge on a small core:
  per-model table (tokens in/out + cost), a daily trend chart, time-window
  filters, grouping by model, export.
- **Tokens are the unit of account, not requests** (Cursor's June-2025
  pricing crisis forced the switch); cache-token columns only matter when the
  meter actually distinguishes them (ours doesn't — so in/out/total suffices).
- **Two elements are proven load-bearing, not decorative** (Cursor
  post-mortem): an explicit included-vs-metered POOL SPLIT, and
  LIMIT-PROXIMITY indication ("you are projected to reach your limit…").
  These map 1:1 onto our two data sources (plan tokens vs BYOK ledger).
- **Revealed preference floor:** what unpaid developers build for themselves
  (opencode-usage, openrouter-costs-visualizer) is exactly a per-day-per-model
  table (Input / Output / Total / Cost) + two charts (by-model, over-time).
  Nothing gamified survives (medium confidence — two tools).
- OpenRouter already solves our mixed-billing display problem: fold BYOK
  estimated spend and plan-token spend into ONE headline, split below.
- Direct "users find X decorative" commentary did not survive verification —
  the omit-list below rests on the revealed-preference evidence, not vibes.

## What we already have (audited — most of this page is wiring, not building)

- Desktop `lib/spend.ts`: per-DAY ledger keyed `${providerId}·${model}` with
  in/out tokens, requests, savedUsd — localStorage, already feeding
  `app/usage/page.tsx` (485 lines: per-provider → per-model rows, day-window
  picker). The per-model token table EXISTS.
- Desktop account state: email/initials/tier via cloud store (billing status,
  TIER_LABEL) — same identity block the web sidebar uses.
- Relay: `usage_log` (user_id, provider, model, input/output/total tokens,
  created_at) + `/api/usage/current` (period used vs limit + period_end) +
  `/api/usage/history` (30-day daily sums). Missing ONLY a per-model grouping.
- Gemini managed turns now report real usage (STREAM_USAGE fix, 2026-07-14) —
  membership per-model numbers are exact for all current upstreams except the
  ~est-flagged fallback rows.

## The page (Profile, desktop `app/profile` — linked from the account menu)

Eight elements, ordered top to bottom; everything from existing tokens/idiom
(charcoal + indigo, hairlines, no glows):

1. **Identity row** — initials avatar, email, TierBadge, member-since.
   No share card, no handle editing (out of scope).
2. **Stat strip (4 quiet stats)** — Lifetime tokens (ledger + relay sum),
   Peak day, Models used (count), Saved vs paid APIs (we already compute
   savedUsd — this stat is OURS, Codex can't show it; it replaces streaks as
   the identity hook).
3. **Plan meter** (members only) — plan tokens used / limit, % bar, reset
   date, projection note when >70% pace ("on pace to hit your limit ~Jul 24").
   The Cursor-proven element; data = /api/usage/current.
4. **Pool split** — one line: "Membership (plan tokens) N · BYOK (your keys)
   M" — the second Cursor-proven element; two data sources shown as two pools,
   never merged into a fake single meter.
5. **Per-model table** (the heart) — Model | Route (Membership/BYOK·provider)
   | In | Out | Total | Est. cost-or-debit, sorted by total desc. BYOK rows
   from the local ledger; membership rows from the new relay endpoint; both
   honest about origin (BYOK numbers live only on this device — say so in a
   footnote, local-first is a feature).
6. **Daily activity bar chart** — last 30 days, one bar/day of total tokens
   (SVG bars, no chart dep — matches the machined system). NOT a
   GitHub-heatmap-with-toggles; a plain bar row is the simplified read of it.
7. **Window picker** — Today / 7d / 30d / All, one control filtering table +
   chart (OpenRouter's fixed-windows pattern; ledger already supports days-N).
8. **Export CSV** — one button dumping the per-model window rows (every
   operator surface has it; costs ~20 lines).

**Deliberately omitted, with reasons:** streaks + share cards (identity
gamification for a social surface we don't have; "Saved $" is the better
brag), percentiles, plugin/feature insights (no plugin ecosystem), heatmap
mode toggles (daily bars carry the same signal at our volume), rate-limit
ITPM charts (console-operator concern), cache-token columns (we don't meter
cache classes — adding them would be fake precision).

## Backend work (small)

- **New relay endpoint** `GET /api/usage/models?days=30`:
  `SELECT provider, model, SUM(input_tokens) in, SUM(output_tokens) out,
  SUM(total_tokens) total, COUNT(*) requests FROM usage_log WHERE user_id=?
  AND created_at >= unixepoch()-?*86400 GROUP BY provider, model ORDER BY
  total DESC` + session gate, mirroring /api/usage/history. Plus tests.
- Desktop `lib/billing.ts`: `fetchUsageByModel(days)`.
- No schema change (usage_log already has everything) → no D1 migration.

## Slices & assignment (model rule)

- S1 relay endpoint + tests — **Sonnet** (one query + one route, pattern
  exists).
- S2 profile page UI (identity/stats/meter/split/table/chart/picker/export)
  — **Opus** (new surface, two data sources, projection logic).
- S3 account-menu entry + route wiring + gates/screenshots — Sonnet.
- Fable: spec review + verification (scripted screenshots at 3 widths, gate
  discipline, honest-copy audit — especially the BYOK-is-device-local
  footnote and ~est-flagged rows shown as "~estimated").

Definition of done: page renders with BOTH pools live for a Pro member and
gracefully with ledger-only for signed-out/local users (plan meter and
membership rows simply absent — no upsell theater on a stats page); typecheck/
tests/build green; user verifies on localhost before any commit.
