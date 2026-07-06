# Zintus Pricing — FINAL SPEC (v2, owner-final 2026-07-06)

Implements the owner's definitive Part 1–10 decision (with the three
2026-07-06 corrections: mid burn 2 cr/1K, user display keeps the SOLD
1M/10M/50M/200M numbers, Mistral Large stays Premium). Supersedes v1 of this
file and the three-way analysis in ECONOMICS-V3.md. Cost inputs:
PROVIDER-SURVEY-2026-07.md (official prices, blended 70% in / 30% out).

Implemented in workers/relay @ b1d90ccd (burn/gating/metering),
0bf497da (research sessions). Deployment + remote D1 schema apply +
margin sign-off remain [HUMAN] gated.

## 1 · Plan allowances (user-facing — the numbers members were SOLD)

| Tier | $/mo | Plan tokens shown | Internal credits (NEVER shown) |
|---|---|---|---|
| Starter | 15 | 1,000,000 | 15,000 |
| Pro | 49 | 10,000,000 | 35,000 |
| Max | 99 | 50,000,000 | 60,000 |
| Ultra | 199 | 200,000,000 | 120,000 |

The word "credits" never appears anywhere users can see. Metering runs in
millicredits (1 cr = 1,000 mc; debit = real tokens × burn — integer math).
Display conversion, applied ONLY at the boundary:

    displayed tokens = mc × plan_token_allowance / (credit_grant × 1000)

so 1 credit displays as 66.7 / 285.7 / 833.3 / 1,666.7 tokens on
Starter/Pro/Max/Ultra. Consequence (owner-accepted): the same request debits
different displayed tokens per tier, and cheap-model usage can display below
real token count on lower tiers.

## 2 · Model classes & burn rates (credits per 1K real tokens)

| Class | Burn | Models |
|---|---|---|
| Free | 0 | GLM-4.7-Flash, GLM-4.5-Flash |
| Cheap (T0) | 1 | DeepSeek Flash, Groq 8B, GLM-FlashX, Llama 4 Scout |
| Mid (T0+) | 2 | Gemini Flash, GPT-4o-mini, Mistral Small |
| Premium (T1) | 5 | Claude Haiku, Groq 70B, Mistral Large, MiniMax M3, Kimi |
| Frontier (T2) | 15 | Claude Sonnet, GPT-5.4, GLM-5.2, Grok 4.3 |
| Ultra | 46 | Claude Opus, GPT-5.5 |

Mid = 2 is the owner-final value (the margin-safe alternative was 3; see §7
for the recorded consequence). Mistral Large ships in Premium per owner
decision — [HUMAN] verify its live blended price when its upstream is wired;
at its historic ~$3.20/M a Pro worst-case referred member nets ~31%.

## 3 · Tier gating

Starter: Free+Cheap+Mid · Pro: +Premium · Max: +Frontier · Ultra: +Ultra.
Blocked models return the honest 403:
`"<Model> requires the <Tier> plan or higher. Upgrade at zintus.ai/pricing"`
(code `model_requires_upgrade`) — never a silent downgrade.

## 4 · Flat-fee services (credits; displayed via the §1 conversion)

FLUX image 12 · gpt-image 72 · deep research 150 · STT 3 per 10 min ·
vision input 0 (bundled) · free models 0.
Image/STT debits land WITH their serving endpoints (not yet servable by the
relay; debiting for an unservable service violates the honesty rules).

## 5 · Research sessions (separate monthly counter)

Starter 20 · Pro 50 · Max 100 · Ultra 300 sessions/month, calendar-month
reset (same period contract as the QuotaCounter). Overflow sessions debit the
deep-research flat fee (150 cr) from plan balance; 429 `research_exhausted`
only when both pools are gone. Deep research runs on Exa (~$0.015/session);
basic web search stays Tavily/Serper.

## 6 · Receipts

Every metered response carries `zintus.tokens` (real) and
`zintus.plan_tokens_debited` (displayed, member's tier); streaming exposes
`X-Zintus-Class` + `X-Zintus-Plan-Per-1k`. Balance line reads
"N tokens remaining · resets <date>" from the same display conversion.

## 7 · Referral commission

**20% of gross subscription revenue** (before Stripe fees), recurring 12
months, all tiers: Starter $3.00 · Pro $9.80 · Max $19.80 · Ultra $39.80/mo.
Config in tiers.ts: REFERRAL_RATE 0.20 · REFERRAL_MONTHS 12 ·
REFERRAL_PENETRATION_THRESHOLD 0.60 (drop rate to 0.15 past it — operator
dial, watched monthly, not automated).

### Margin verification (worst case = full grant on the most expensive
reachable class, which is MID at burn 2 — $0.48/1k cr; referred member pays
the full 20%; Stripe 2.9%+30¢)

| Tier | Revenue | Referral | Stripe | COGS | Profit | Margin |
|---|---|---|---|---|---|---|
| Starter | $15 | $3.00 | $0.74 | $7.20 | $4.07 | **27.1%** ⚠ |
| Pro | $49 | $9.80 | $1.72 | $16.80 | $20.68 | 42.2% ✅ |
| Max | $99 | $19.80 | $3.17 | $28.80 | $47.23 | 47.7% ✅ |
| Ultra | $199 | $39.80 | $6.07 | $57.60 | $95.53 | 48.0% ✅ |

Owner-accepted exception: referred-Starter worst case sits below the 40%
target (39.1% at the 40%-referred blend; typical usage ~59%). Every other
cell holds ≥42%; Ultra worst case is comfortably positive. Note Opus/GPT-5.5
at 46× are the CHEAPEST classes per credit ($0.27/1k cr) — frontier whales
are the most profitable worst case, mid-class whales the least.

## 8 · Implementation status

DONE (committed): burn rates + class gating + millicredit metering + per-tier
display (b1d90ccd) · research sessions D1+endpoint (0bf497da) · BYOK
self-report no longer debits plan tokens (was a real pre-launch bug) ·
referral config flags · auth P0 (688f89f5).
PENDING: image/STT serving endpoints (+ their flat-fee debits) · pricing-page
per-model token tables · desktop receipt UI for plan_tokens_debited ·
[HUMAN]: deploy relay → `wrangler d1 execute --remote --file schema.sql` →
margin sign-off → desktop rebuild.
