# Tokzen

Token-efficient LLM context compression. TypeScript-native, provider-agnostic, deterministic-first.

## Installation

```bash
bun add tokzen
# or
npm install tokzen
```

## Three integration modes

### 1. SDK — wrap your messages before any provider call

```typescript
import { compress } from "tokzen"

const result = await compress(
  { messages, systemPrompt },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    tokenBudget: 8000,
  }
)
// pass result.messages to your Anthropic/OpenAI client
```

### 2. Proxy — OpenAI-compatible transparent proxy

```bash
TOKZEN_PROVIDER=anthropic TOKZEN_API_KEY=sk-ant-... bun run src/proxy/server.ts
# Proxy listens on :8787
# Point your OpenAI client to http://localhost:8787
```

### 3. MCP — Claude-native tool integration

```bash
tokzen mcp install
```

Exposes `compress`, `retrieve`, and `stats` as MCP tools.

## Standalone compressors

```typescript
import { compressJSON, compressCode, compressLog, compressDiff, compressProse } from "tokzen"

const { content, ratio } = compressJSON(largeToolOutput)
const result = await compressCode(sourceFile)
const logs = compressLog(applicationLogs)
```

## Compressor reference

| Content type | Algorithm | Expected savings |
|---|---|---|
| JSON (uniform arrays) | TOON encoding + statistical sampling | 40–95% |
| JSON (mixed objects) | Key abbreviation + UUID aliasing + strip-empty | 60–80% |
| Code | AST signature extraction (web-tree-sitter) | 40–70% |
| Logs | Drain template mining + level filter + stack compression | 85–94% |
| Diffs | Context reduction to 2 lines + hunk budget enforcement | 60–80% |
| Prose (deterministic) | TF-IDF + TextRank extractive compression | 30–50% |
| Prose (ML, opt-in) | LLMLingua-2 extractive compression | 50–70% |

## Provider cache reference

| Provider | Min tokens for cache | Cache discount |
|---|---|---|
| Anthropic Claude 3.x | 1,024 tokens | ~90% off input |
| Anthropic Claude Sonnet 4.x | 2,048 tokens | ~90% off input |
| OpenAI (automatic) | 1,024 tokens | ~50% off input |
| Gemini Flash 2.5 | 1,024 tokens | ~75% off input |
| Gemini Pro 2.5 | 4,096 tokens | ~75% off input |

Tokzen's `CacheAligner` automatically stabilizes system prompt prefixes and injects `cache_control` annotations for Anthropic/Gemini when the static prefix exceeds the provider minimum.

## Quota-aware compression (BUSL-1.1)

```typescript
import { QuotaController, dialCompress } from "tokzen"

const controller = new QuotaController()
controller.recordResponseHeaders(responseHeaders)

const result = await dialCompress(input, {
  ...ctx,
  quotaRemaining: controller.getQuotaRemaining(),
})
```

| Level | quotaRemaining | Compression applied |
|---|---|---|
| 1 | > 50% | CacheAligner only |
| 2 | 30–50% | + JSON / log / diff |
| 3 | 15–30% | + code + CCR for history |
| 4 | < 15% | + prose + aggressive CCR |

## CCR — Compressed Content Retrieval

When content is dropped during compression, Tokzen stores the original in a local SQLite store (at `~/.tokzen/ccr.db`) and injects a `tokzen_retrieve` tool into your tool list. The LLM can call `tokzen_retrieve(hash)` to get the full content on demand.

```typescript
import { createCCRStore, retrieve } from "tokzen"

const store = createCCRStore()
const hash = store.store(largeContent, "json")
const original = retrieve(hash)            // full content
const relevant = retrieve(hash, "error")  // BM25-filtered subset
```

## Eval benchmark results

Run `bun run src/evals/runner.ts --tier 2` after installing to get live results for your content.

| Benchmark | Threshold | Notes |
|---|---|---|
| GSM8K (math) | Δ ≤ 0.0% | Math precision must be exact |
| TruthfulQA | Δ ≥ -3.0% | Compression sometimes improves by removing noise |
| SQuAD v2 | ≥ 97% accuracy | At ≤ 20% compression ratio |
| BFCL (tool calls) | ≥ 97% accuracy | At ≤ 35% compression ratio |
| CCR Needle Retention | 100% | Lossless retrieval via tokzen_retrieve |

## Comparison

| Feature | Tokzen | Headroom | LeanCTX | LLMLingua |
|---|---|---|---|---|
| TypeScript-native | ✓ | — | — | — |
| No Python deps | ✓ | — | ✓ | — |
| Quota-aware dial | ✓ | — | — | — |
| Provider-agnostic | ✓ | OpenAI | ✓ | — |
| Reversible CCR | ✓ | — | — | — |
| Deterministic core | ✓ | ✓ | ✓ | — |
| ML prose (opt-in) | ✓ | — | — | ✓ |
| MCP server | ✓ | — | — | — |
| OpenAI-compat proxy | ✓ | — | — | — |

## License

- **MIT** — all files in `src/` except `src/quota/` and `src/ml/`
- **BUSL-1.1** — `src/quota/` and `src/ml/` (free for personal non-commercial use; converts to MIT on 2028-01-01)
