# Zintus economics v3 — three designs, computed against July-2026 real prices

Inputs: PROVIDER-SURVEY-2026-07.md (verified official prices). Constraints
from owner: net margin ≥50% on the $15 tier and ≥60% on all higher tiers,
AFTER the referral program (30% of net margin, recurring 12 months). All
token math uses 70/30 in/out blended rates — never input-only sticker prices.

Referral load: retained_net = net × (1 − 0.30 × referred_share).
- Design target: blended scenario, 40% of members referred → retained = 0.88×net
  → pre-referral floors: ≥56.8% (Starter), ≥68.2% (higher tiers).
- Hard scenario (100% referred → 0.70×net) reported for stress visibility.

"Worst case" = member exhausts the full monthly grant on the most expensive
model class their tier can reach. "Typical" = 60% grant utilization at a
70% cheap / 20% mid / 10% premium usage blend.

Cost primitives (blended $/1M unless noted): GLM-4.7/4.5-flash FREE ·
Groq 8B 0.059 · gpt-oss-20b 0.14 · glm-4.7-flashx 0.17 · llama-4-scout 0.18 ·
deepseek-v4-flash 0.18 (cache-read 2%!) · mistral-small-4 0.285 ·
minimax-m3 0.57 · gemini-2.5-flash 0.96 · glm-4.7 1.08 · grok-4.3 1.63 ·
glm-5 1.66 · kimi-k2.6 1.87 · gpt-5.4-mini 1.88 · haiku-4.5 2.20 ·
glm-5.2 2.30 · gemini-3.5-flash 3.75 · sonnet-5 6.60 · gpt-5.4 6.25 ·
opus-4.8 11.00 · gpt-5.5 12.50 · fable/mythos-5 22.00 (plans exclude it —
PAYG add-on or BYOK only).
Non-text: image FLUX-schnell $0.003 · CogView-4 $0.01 · gpt-image med ~$0.045 ·
vision input ≈$0.0001–0.0014/image · STT $0.04/hr · search session composed
$0.006–0.013 · Exa deep-reasoning session $0.015 · Perplexity-grade report
$0.30–1.00 · embeddings $0.02/M · sandbox $0.12/hr.

────────────────────────────────────────────────────────────────────────────
## MODEL A — "Flat Credits" (simplest)

One wallet, one public markup: **2.5× on every metered service.** Credits:
1,000 = $1 retail. Wallet sized so even all-frontier exhaustion holds floors.

| Tier | Grant | Worst net | Typical net | Post-referral (40%) worst/typical |
|---|---|---|---|---|
| Starter $15 | 16,000 cr | 57.3% | 74.4% | 50.4% / 65.5% |
| Pro $49 | 38,000 cr | 69.0% | 81.4% | 60.7% / 71.6% |
| Max $99 | 78,000 cr | 68.5% | 81.1% | 60.3% / 71.4% |
| Ultra $199 | 155,000 cr | 68.8% | 81.3% | 60.6% / 71.5% |

Every model open to every paid tier (frontier included — the flat markup
self-limits). Non-text at the same 2.5×: FLUX image 8 cr · search session 30
cr · Exa deep session 40 cr + model tokens · STT 2 cr/10min.

Pros: one sentence to explain; legally cleanest (obviously a value-added
meter, not resale); zero gating code. Cons: cheap models under-monetized
(4× headroom unused → lowest typical margins of the three); "16,000 credits"
lacks the big-number punch of "1M tokens"; frontier margin thin at 2.5×.

────────────────────────────────────────────────────────────────────────────
## MODEL B — "Token Multipliers" (the owner draft, corrected)

Plans sell plan-tokens as drafted (1M / 10M / 50M / 200M). Debit =
actual_tokens × class multiplier (multiplier ≥ 1 so the meter always reads
in the honest direction — the July-5 draft's 0.42×-labeled-3.0× inversion is
abandoned). Tier gating as drafted. Multipliers set from blended real costs:

| Class (blended cost) | k | Examples |
|---|---|---|
| Gift (free upstream) | 0× | GLM-4.7/4.5-flash |
| Cheap (≤$0.20) | 1× | Groq 8B, ds-v4-flash, flashx, scout |
| Mid ($0.20–1.10) | 2× | gemini-2.5-flash, minimax-m3, glm-4.7, mistral-small |
| Value-premium ($1.1–4) | 4× | haiku-4.5, gpt-5.4-mini, kimi-k2.6, glm-5/5.2, grok-4.3, gemini-3.5-flash |
| Premium ($4–7) | 12× | sonnet-5, gpt-5.4, gemini-3.1-pro |
| Frontier ($7–13) | 40× | opus-4.8, gpt-5.5 (Ultra only) |

Access: Starter ≤cheap · Pro ≤value-premium · Max ≤premium · Ultra all.

| Tier | Worst-case burn | Worst net | Typical net | Post-referral worst/typical |
|---|---|---|---|---|
| Starter $15 | 1M on ds-flash | 98.8% | 99.4% | 86.9% / 87.5% |
| Pro $49 | 2.5M on 3.5-flash | 80.9% | 96.3% | 71.2% / 84.7% |
| Max $99 | 4.17M on sonnet-5 | 72.2% | 90.7% | 63.5% / 79.8% |
| Ultra $199 | 5M on gpt-5.5 | 68.6% | 81.6% | 60.4% / 71.8% |

Full-burn servable actual tokens: Ultra = 5M frontier tokens or 16.7M
sonnet-class or 100M mid or 200M cheap — market-competitive vs Claude Max
$200 while never breaching floors.
Non-text priced in plan tokens at Pro's token value: FLUX image 3k tok ·
search session 10k · Exa deep session 15k + model tokens · report-grade
research 250k · STT 1.5k/10min.

Pros: sells the big token numbers; monster margins at typical usage; closest
to the existing relay code (multiplier field exists). Cons: 12×/40×
multipliers need careful UX or they read as a gotcha; the same "1M tokens"
buys 15× different value on Starter vs Ultra (inherent to the draft);
per-tier gating + per-class multipliers = most moving parts.

────────────────────────────────────────────────────────────────────────────
## MODEL C — "Balanced Hybrid" ★ RECOMMENDED

Poe-style transparent credit ledger inside, Anthropic-style multiplier
marketing outside, Perplexity-style separate agent/research pool feel,
T3-style rolling window. Credits: 1,000 = $1 retail. Class markups (public,
like today's PUBLIC_MARKUP): **gift 0 · cheap 4× · mid 3× · premium 2.5× ·
frontier 2×** — cheap models fund the platform, frontier stays sellable.

Grants & access: Starter 15,000 cr (≤mid) · Pro 35,000 cr (≤premium) ·
Max 60,000 cr (all) · Ultra 120,000 cr (all). Marketing: "Max = 4× Starter,
Ultra = 8× Starter" (vs Pro it's only 1.7×/3.4× — never anchor to Pro).
Overflow: buy credits at retail (never below cost+15%).
Pacing: rolling 4-hour bar on Starter/Pro instead of hard rpm walls.

| Tier | Worst net | Typical net | Post-referral (40%) worst/typical | Hard-100% worst |
|---|---|---|---|---|
| Starter $15 | 66.7% | 81.8% | 58.7% / 72.0% | 46.7% |
| Pro $49 | 71.4% | 87.0% | 62.9% / 76.6% | 50.0% |
| Max $99 | 69.7% | 89.0% | 61.3% / 78.3% | 48.8% |
| Ultra $199 | 69.8% | 89.0% | 61.4% / 78.4% | 48.9% |

Per-service credit prices (cost × class markup):
- Text /1M actual: GLM-flash 0 · Groq 8B 240 · ds-v4-flash 730 · 2.5-flash
  2,900 · haiku 5,500 · sonnet-5 16,500 · opus-4.8 22,000 · gpt-5.5 25,000.
- Vision input: +0–4 cr/image (cheap VLMs effectively free — bundle it).
- Images: FLUX-schnell 12 cr · CogView-4 40 cr · gpt-image-med 120 cr.
- Search: basic session 40 cr (Serper+Jina composed) · Exa full-text search
  30 cr/req-bundle · **deep research 150 cr** (Exa deep-reasoning) + model
  tokens · report-grade (Perplexity sonar-deep) 1,500–3,000 cr.
- STT: 3 cr / 10 min (Groq whisper-turbo). Agent sandbox: 500 cr/hr (E2B).
- Agent loops: charge cached-input at cache rates ×markup — DeepSeek's 2%
  cache read makes long agent sessions nearly free to serve; pass half of
  that through as visible savings on the receipt.
- Embeddings/memory: bundled free (cost noise, retention feature).

Free tier: GLM-flash chat with daily cap (abuse fence), BYOK unlimited.
Fable/Mythos-class ($22 blended): excluded from plans; PAYG add-on at 2× or
BYOK.

Pros: every floor met with room; cheap usage massively profitable (funds
referrals); frontier available without Ultra-whale loss; receipts stay
honest ("−12 cr · would cost 30 cr on Sonnet"); mechanics proven by Poe/
Perplexity/T3. Cons: two visible units (credits + marketing multiplier);
class table to maintain (already exists in @zintus/burn).

────────────────────────────────────────────────────────────────────────────
## Comparison & verdict

| Criterion | A Flat | B Multipliers | C Hybrid |
|---|---|---|---|
| Meets 50/60% post-referral floors (40% referred) | ✅ barely | ✅ | ✅ comfortably |
| Survives 100%-referred stress | ❌ Starter 40% | ✅ mostly | ⚠ ~47–50% |
| Typical-blend profitability | lowest | highest | high |
| Marketing story | weak | big token numbers | multiplier rungs + honest ledger |
| Meter honesty optics | best | riskiest (40×) | good |
| Implementation distance from current relay | medium | **shortest** | medium |
| Legal posture (differentiated app, not resale) | best | good | good |

**Verdict: ship Model C**; keep B's tier-gating idea (it's inside C via
class access) and A's flat-markup principle for the overflow store. If the
referral program regularly exceeds ~60% of new members, either drop the
commission to 25% or exclude Starter from recurring commissions (one-time
bounty instead) — that's the only configuration where C's floors bend.

Implementation deltas from current code: credits ledger on QuotaCounter
(P3 of burn-metering, already planned) · class markup table already in
@zintus/burn (adjust values) · per-tier class access field on MANAGED_MODELS ·
per-service meters (images/search/research/STT) — each is a metered relay
endpoint like /v1/managed/chat. Stream-disconnect metering test remains a
pre-launch blocker.
