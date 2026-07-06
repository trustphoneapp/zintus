# API provider pricing survey — 2026-07-05

Five-agent web survey of official pricing pages (each claim carries its source
in the section notes; UNVERIFIED = not confirmable from an official page this
pass). Feeds ECONOMICS-V3 models. All prices USD per 1M tokens (in/out) unless
stated. Blended = 0.7×in + 0.3×out.

## 1. Cost-efficient text LLMs

### Headline table (tool-calling capable, cheapest first, blended $/1M)

| # | Model (provider) | In / Out | Blended |
|---|---|---|---|
| 1 | glm-4.7-flash (Z.AI) | FREE | $0.00 |
| 2 | glm-4.5-flash (Z.AI) | FREE | $0.00 |
| 3 | llama-3.1-8b-instant (Groq) | 0.05 / 0.08 | $0.059 |
| 4 | ministral-3-3b (Mistral) | 0.10 / 0.10 | $0.10 |
| 5 | nova-lite (AWS) | 0.06 / 0.24 | $0.114 |
| 6 | gpt-oss-20b (Fireworks/Groq) | 0.07 / 0.30 | $0.139 |
| 7 | ministral-3-8b (Mistral) | 0.15 / 0.15 | $0.15 |
| 8 | glm-4.7-flashx (Z.AI) | 0.07 / 0.40 | $0.169 |
| 9 | llama-4-scout (Groq) | 0.11 / 0.34 | $0.179 |
| 10 | deepseek-v4-flash | 0.14 / 0.28 | $0.182 (cache-hit in: $0.028) |

### Full per-provider data

**Groq** (groq.com/pricing): 8b-instant 0.05/0.08 · gpt-oss-20b 0.075/0.30
(cache 0.0375) · gpt-oss-120b 0.15/0.60 (cache 0.075) · llama-4-scout
0.11/0.34 · qwen3-32b 0.29/0.59 · llama-3.3-70b 0.59/0.79 · qwen-3.6-27b
0.60/3.00 · kimi-k2-instruct 1.00/3.00 (cache 0.50).

**Cerebras** (cerebras.ai/pricing): gpt-oss-120b 0.25/0.69 (~3000 tok/s);
llama-3.1-405b 6/12. glm-4.7/qwen3-235b/coder-480b rates UNVERIFIED (no
public rate card). Sub plans: Code Pro $50/mo 24M tok/day, Max $200/mo 120M
tok/day — both "sold out."

**DeepSeek** (api-docs.deepseek.com): v4-flash 0.14/0.28 (cache-hit in
0.028) · v4-pro 0.435/0.87 (cache-hit ~0.036, UNVERIFIED exact). 1M context,
384K max out. deepseek-chat/reasoner deprecated 2026-07-24 → map to V4-Flash.

**Z.AI GLM** (docs.z.ai): glm-4.7-flash + glm-4.5-flash FREE ·
4.7-flashx 0.07/0.40 (cache 0.01) · 4-32b 0.10/0.10 · 4.5-air 0.20/1.10 ·
4.7 0.60/2.20 (cache 0.11) · glm-5 1.00/3.20 (cache 0.20) · glm-5-turbo
1.20/4.00 · glm-5.1/5.2 1.40/4.40 (cache 0.26).

**Moonshot Kimi** (platform.kimi.ai): kimi-k2.6 0.95/4.00 (cache-hit in
0.16), 262K ctx · kimi-k2.7-code 0.95/4.00 (cache 0.19, UNVERIFIED).

**Mistral** (mistral.ai/pricing): ministral-3-3b 0.10/0.10 · 3-8b 0.15/0.15 ·
small-4 0.15/0.60 · 3-14b 0.20/0.20 · codestral 0.30/0.90 · devstral-2
0.40/2.00 · large-3 0.50/1.50 · medium-3.5 1.50/7.50 (note inversion:
large < medium). Batch −50%.

**Together** (together.ai/pricing): qwen3.5-9b 0.17/0.25 · qwen3.7-plus
0.32/1.28 · llama-3.3-70b 1.04/1.04 · kimi-k2.6 1.20/4.50 · qwen3.7-max
1.25/3.75 (cache 0.13) · deepseek-v4-pro 1.74/3.48. Llama-4 scout/maverick
delisted from official page (UNVERIFIED third-party: 0.08/0.30, 0.27/0.85).

**Fireworks** (fireworks.ai/pricing): gpt-oss-20b 0.07/0.30 · deepseek-v4-flash
0.14/0.28 · gpt-oss-120b 0.15/0.60 · minimax-m3/m2.7 0.30/1.20 (cache 0.06) ·
qwen3.7-plus 0.40/1.60 · kimi-k2.6 0.95/4.00 · glm-5.1/5.2 1.40/4.40 ·
deepseek-v4-pro 1.74/3.48. Cache −50% default; batch −50%.

**MiniMax** (platform.minimax.io): m3 0.30/1.20 (≤512K in; >512K: 0.60/2.40;
cache-read 0.06) · m2.7 0.30/1.20 (cache write 0.375).

**Alibaba Qwen intl** (alibabacloud.com Model Studio): qwen-turbo 0.05/0.20
(sunsetting) · qwen3.6-flash 0.25–1.00 / 1.50–4.00 (context-tiered) ·
qwen3.7-plus 0.40–1.20 / 1.60–4.80 (cache ~0.04) · qwen3.7-max 2.50/7.50.
Free: 1M tokens/model for 90 days.

**xAI** (docs.x.ai): grok-build-0.1 1.00/2.00 (256K) · grok-4.3 1.25/2.50
(1M) · grok-4.20 1.25/2.50 (1M). The cheap fast/mini line (grok-4.1-fast
0.20/0.50) appears RETIRED (third-party report, UNVERIFIED).

**Amazon Nova** (aws.amazon.com/bedrock): nova-lite 0.06/0.24 · nova-pro
0.80/3.20 · micro ~0.035/0.14 (UNVERIFIED) · cache-read −75%, batch −50%.

**Baidu ERNIE intl**: no official English pricing page found; all figures
third-party (4.5: 0.55/2.20 · X1: 0.28/1.10) — UNVERIFIED, limited intl API.

**OpenRouter** (openrouter.ai): no inference markup; 5.5% fee on credit
purchases (min $0.80); BYOK 1M req/mo free then 5%; ":free" models 50
req/day (1,000/day after $10 credit) — NOT production-suitable.

ToS/resale: no provider's resale clause was verifiable this pass from
official pages (all UNKNOWN) except OpenRouter (resale is its business
model). Frontier-provider terms in §2.

## 2. Frontier text LLMs

### OpenAI (developers.openai.com/api/docs/pricing)

| Model | In | Out | Cached in | Context |
|---|---|---|---|---|
| gpt-5.5 | 5.00 | 30.00 | 0.50 | 1M/128K |
| gpt-5.4 | 2.50 | 15.00 | 0.25 | 1M/128K |
| gpt-5.4-mini | 0.75 | 4.50 | 0.075 | 400K |
| gpt-5.4-nano | 0.20 | 1.25 | 0.02 | 400K |
| gpt-5.3-codex | 1.75 | 14.00 | 0.175 | 400K |
| gpt-5.5-pro / 5.4-pro | 30.00 | 180.00 | — | 1M |

Batch −50%. o-series: end-of-life (shutdowns 2026-10/12). Caching automatic,
read = 10% of input.

### Anthropic (platform.claude.com pricing)

| Model | In | Out | Cache read | Batch in/out | Context |
|---|---|---|---|---|---|
| Fable 5 / Mythos 5 | 10 | 50 | 1.00 | 5/25 | 1M |
| Opus 4.8/4.7/4.6/4.5 | 5 | 25 | 0.50 | 2.50/12.50 | 1M |
| Sonnet 5 (intro→08-31) | 2 | 10 | 0.20 | 1/5 | 1M |
| Sonnet 5 (std) / 4.6 / 4.5 | 3 | 15 | 0.30 | 1.50/7.50 | 1M |
| Haiku 4.5 | 1 | 5 | 0.10 | 0.50/2.50 | 200K |

Batch −50%; cache write 1.25×(5m)/2×(1h); no long-context premium.

### Google Gemini (ai.google.dev pricing)

| Model | In | Out | Batch in/out |
|---|---|---|---|
| gemini-2.5-flash-lite | 0.10 | 0.40 | 0.05/0.20 |
| gemini-3.1-flash-lite | 0.25 | 1.50 | 0.125/0.75 |
| gemini-2.5-flash | 0.30 | 2.50 | 0.15/1.25 |
| gemini-3-flash-preview | 0.50 | 3.00 | 0.25/1.50 |
| gemini-2.5-pro ≤200K | 1.25 | 10.00 | 0.625/5 |
| gemini-3.5-flash | 1.50 | 9.00 | 0.75/4.50 |
| gemini-3.1-pro-preview ≤200K | 2.00 | 12.00 | 1/6 |
| gemini-3.1-pro-preview >200K | 4.00 | 18.00 | — |

Cache read 10% + storage $/1M-tok/hr. Batch −50%. Live API priced separately.

### Blended 70/30 ladder (ascending, $/1M)

deepseek-v4-flash 0.18 · 2.5-flash-lite 0.19 · gpt-5.4-nano 0.52 ·
deepseek-v4-pro 0.57 · 3.1-flash-lite 0.63 · 2.5-flash 0.96 · 3-flash-prev
1.25 · gpt-5.4-mini 1.88 · haiku-4.5 2.20 · 3.5-flash 3.75 · 2.5-pro 3.88 ·
sonnet-5-intro 4.40 · 3.1-pro ≤200K 5.00 · gpt-5.3-codex 5.43 · gpt-5.4 6.25 ·
sonnet-5/4.6 6.60 · opus-4.8 11.00 · gpt-5.5 12.50 · fable/mythos-5 22.00 ·
5.5-pro 75.00.

### Resale/pooled-key terms (the legal gate)

- **Anthropic**: Commercial Terms §A.1 explicitly permits powering "products
  and services Customer makes available to its own customers and end users";
  §D.4 bans plain resale without express approval. → Zintus-as-product OK.
- **OpenAI**: Services Agreement bans reselling account/API-key access, but
  Customer Applications serving end users are the contemplated pattern. → OK
  as a differentiated app.
- **Google**: Gemini API terms are the strictest — no sublicensing/"API-
  equivalent client," "not for consumer use" framing on AI-Studio keys;
  serious multi-tenant volume belongs on **Vertex AI terms** instead.
- Rule of thumb baked into all three: a differentiated application = fine; a
  thin metered pass-through of raw model access = prohibited.

## 3. Vision LLMs, image generation, speech-to-text

### 3A. Vision (image INPUT) — billed as input tokens everywhere

| Model | In / Out $/1M | Cost per 1024² image |
|---|---|---|
| Alibaba qwen3-vl-flash | 0.05 / 0.40 | ~$0.00007 (token rule UNVERIFIED) |
| Z.AI glm-4.6v-flashx | 0.04 / 0.40 | ~$0.00006 (rule UNVERIFIED) |
| Google gemini-2.5-flash-lite | 0.10 / 0.40 | ~$0.0001 |
| Google gemini-2.5-flash | 0.30 / 2.50 | ~$0.0003 |
| Z.AI glm-4.6v | 0.30 / 0.90 | ~$0.0004 |
| Alibaba qwen3-vl-plus | 0.20 / 1.60 | ~$0.0003 |
| OpenAI gpt-5.4-nano | 0.20 / 1.25 | ~$0.0002–0.0006 |
| Anthropic Haiku 4.5 | 1.00 / 5.00 | $0.00137 (VERIFIED: 1 tok/28×28px → 1369 tok) |
| Google gemini-3.1-pro-preview | 2.00 / 12.00 | ~$0.002 |
| Anthropic Sonnet 4.6/5 | 3.00 / 15.00 (intro 2/10 thru 08-31) | $0.0041 |
| Anthropic Opus 4.8 | 5.00 / 25.00 | $0.0068 |

Notes: Groq/Together no longer publicly price Llama-vision (thinned out);
budget vision tier is now Qwen3-VL + GLM-4.6V. Pick: **qwen3-vl-flash**,
fallback **gemini-2.5-flash-lite**.

### 3B. Image generation (per image)

| Option | Price |
|---|---|
| FLUX.1 schnell (Replicate/Together) | **$0.003** |
| Z.AI CogView-4 / GLM-Image | $0.01 / $0.015 |
| xAI grok-imagine | $0.02 ($0.05 quality) |
| fal.ai Qwen-Image | $0.02/MP |
| Ideogram 3.0 Turbo · Stability Core · Together FLUX.2 pro | $0.03 |
| Google Nano Banana (2.5-flash-image) | $0.039 · Nano Banana 2: $0.067 |
| OpenAI gpt-image-2 | $0.005–0.006 low / $0.04–0.05 med / $0.17–0.21 high |
| BFL FLUX.2 klein/pro/flex/max | $0.014 / $0.03 / $0.05 / $0.07 per MP |
| Ideogram 3.0 Quality $0.09 · Recraft V3 raster $0.04 / vector $0.08 |

Cheapest good-quality: FLUX.1 schnell ~$0.003/image.

### 3C. Speech-to-text ($/hour)

| Option | $/hr |
|---|---|
| **Groq Whisper large-v3-turbo** | **$0.04** |
| Together Whisper v3 | $0.09 |
| Groq Whisper large-v3 | $0.111 |
| Z.AI GLM-ASR | ~$0.14 |
| AssemblyAI Universal-2 | $0.15 |
| OpenAI 4o-mini-transcribe | $0.18 |
| Deepgram Nova-3 | ~$0.29–0.55 (unit ambiguity, re-check) |
| Gladia | $0.61–0.75 |

Pick: Groq whisper-large-v3-turbo $0.04/hr.

## 4. Search & deep research

### Per-provider (accessed 2026-07-05)

| Provider | Price | Free tier | Includes |
|---|---|---|---|
| Serper.dev | ~$0.30–1.00/1k queries | 2,500 q | Google SERP snippets only |
| Jina Reader/Search | token-metered (~$0.02/M UNVERIFIED); search ≈10k tok/req | 10M tok | full page content |
| Firecrawl | $0.83–3.20/1k credits; scrape 1cr/page, search 2cr/10 results | 1k cr/mo | full markdown |
| Brave | Search $5/1k; Answers $4/1k + $5/M tok | $5/mo credits | snippets / synthesized |
| Tavily | $0.008/credit; search 1cr, advanced 2cr, extract 1cr/5 URLs; native research mini 4–110cr, pro 15–250cr | 1k cr/mo | full content |
| Exa | search **$7/1k incl. full text**; contents $1/1k; deep $12/1k; **deep-reasoning $15/1k**; agents $0.012–1.00/req | 20k req/mo claim | full text + agentic |
| Perplexity Sonar | sonar $1/$1 tok + $5–12/1k req; sonar-pro $3/$15 + $6–14/1k; **deep-research** $2/$8 tok + $3 reasoning + $2 citation + $5/1k internal searches | none | cited synthesized answers/reports |
| SerpAPI | $9.17–25/1k | 250/mo | parsed SERP |
| Google CSE | $5/1k — **closed to new customers, EOL 2027-01-01** | 100/day | snippets |
| Azure Bing Grounding | $14/1k + model tokens, agent lock-in | none | grounded snippets |
| You.com | sales-gated | 100 q/day MCP | n/a |

### Effective session costs

Standard session (6 searches + 4 extractions): Jina ~$0.002 (UNVERIFIED) ·
Serper $0.006–0.018 (no extraction) · **Firecrawl ~$0.013** · Perplexity
sonar ~$0.030 · Brave $0.030 · Exa $0.046 · Tavily basic $0.054.

Deep session (25 searches + 15 extractions or native): Jina ~$0.002–0.007 ·
**Exa deep-reasoning $0.015 native** · Tavily research-mini $0.03–0.88 ·
Firecrawl $0.054 · Exa composed $0.19 · Tavily composed $0.22 · Perplexity
sonar-deep-research ~$0.30–1.00 (finished cited report).

### Sourcing recommendation

Cheap tier: **Serper + Jina Reader** (order-of-magnitude cheapest composed)
or Firecrawl single-vendor. Premium tier: **Exa** (search includes full text;
native deep-reasoning $0.015/session is the bargain of the entire survey).
Perplexity deep-research only where a finished long-form cited report is the
product. Avoid: Google CSE (EOL), Azure grounding (lock-in + $14/1k).

## 5. Agent infra + consumer-market calibration

### Caching / batch (agent workloads)

| Provider | Cache read | Cache write | Batch |
|---|---|---|---|
| OpenAI | 10% of input | free/automatic | −50% |
| Anthropic | 10% | 125% (5m) / 200% (1h) | −50% |
| Gemini | 10% + storage $/1M-tok/hr | — | −50% |
| DeepSeek | **2%** (v4-flash) | free/automatic | — |
| Groq | 50% | free | −50% |

### Embeddings/rerank (RAG memory): OpenAI 3-small $0.02/1M · Voyage lite
$0.02 (200M free) · Jina ~$0.02 · Mistral $0.10 · rerank ≈ $1–2.50/1k queries.
Sandboxes: E2B ~$0.12/hr · Modal ~$0.31/hr · Anthropic code-exec $0.05/hr
(1,550 free hrs/mo).

### Consumer market rungs (calibration)

| Rung | Products | Notes |
|---|---|---|
| $8 | ChatGPT Go, T3 Chat | single-model-lite / capped multi-model |
| $20 | ChatGPT Plus, Claude Pro, Perplexity Pro, Gemini Pro, Poe, Kagi $25 | the crowded cluster |
| $100 | ChatGPT Pro entry, Claude Max 5×, Google Ultra entry | "5×" rung |
| $200 | ChatGPT Pro 20×, Claude Max 20×, Perplexity Max, Poe top | "20×" rung |

Positioning: **$15 undercuts the whole $20 cluster with a multi-model story
the $8 rung lacks — genuinely open slot.** $49 is a dead zone (nothing
between $25 and $100) → needs countable differentiators (agent runs,
research sessions), not a bare multiplier. $99/$199 map cleanly onto the
established 5×/20× rungs.

Mechanics worth copying: **Poe's transparent per-model points ledger** (maps
1:1 onto our burn/credit architecture), **Perplexity's separate agent-credit
pool** (chat feels unmetered; agents countable), **T3's 4-hour rolling usage
bar** (kills end-of-month cap anxiety), and Anthropic/OpenAI **5×/20×
multiplier marketing** for the top rungs.
OpenRouter fee benchmark: 5.5% on credits — the ceiling for "pass-through"
pricing perception.
