# Zintus Post-Build Verdict — 2026-06-28 (tools + structured + vision + CSP)

*Branch `feat/tool-calling` (uncommitted working tree on top of `6bcd097`). After
the 2026-06-26/28 audits, the two headline capability gaps — **tool/function
calling** and **structured/JSON output** — plus a **cross-provider image mapper**
and the **relanded nonce CSP** were built. A 12-agent verify fleet then re-audited
the result against the 10/10 bar; this verdict reconciles its findings and records
the fixes applied.*

**Ground truth:** `bun run typecheck` clean (all packages incl. web/desktop/mobile);
full `bun run test` exit 0, **0 failures, 985 pass** (955 bun + 30 vitest), up from
the 919 pre-build baseline.

---

## 1. What was built (all verified in code + tests)
- **Tool/function calling**, full stack: types (tool blocks, `StreamChunk.toolCall`,
  parallel `RouteStreamResult.toolCalls` channel) → capability registry
  (`supportsTools`/`TOOL_MODELS`) → providers (OpenAI `tool_calls` accumulation +
  message mapping; Gemini `functionCall`/`functionResponse` + id↔name) → router
  gate (hard-error, never silent-downgrade) + model-fanout filter → engine
  (forward + cache-skip) → gateway (OpenAI-shape SSE + 422) → web SSE accumulation
  + CLI `--tools`.
- **Structured/JSON output**: 3-state `structuredOutput` capability (only Gemini
  guarantees `json_schema`), router strict-schema gate + per-provider resolution,
  provider-native `response_format`/`responseSchema`, Ajv validate +
  extract-JSON + repair-instruction, engine buffer→validate→repair loop, gateway
  `parsed`/`structured_output` meta + 422.
- **Cross-provider image mapper**: `openai-compat` now emits `image_url` parts; two
  OpenRouter vision models registered (capability-honest, gemini-default invariant
  intact).
- **CSP nonce reland**: per-request nonce, prod `script-src 'self' 'nonce'
  'strict-dynamic' https:`, fail-closed dev-only `'unsafe-eval'`, Report-Only flag.

## 2. The 12-agent verify fleet (read-only) → 16 fixes applied
Reports: `postbuild/01..12`. The fleet found what the green suite missed; the
"debate" was reconciled against the code and fixed by 3 partitioned fix-agents +
the orchestrator. **Critical/high fixes:**

1. **Multi-turn tool loop was broken over HTTP** (the headline). The gateway edge
   schema (`schemas`) lacked `tool_call`/`tool_result` blocks and the `tool` role,
   so a continuation turn carrying a `tool_result` 400'd. FIXED: added the block
   schemas + `tool` role; `parseMessages` normalizes an OpenAI `{role:"tool"}`
   message → a user-turn `tool_result` block.
2. **Tokzen destroyed tool blocks** (`textOf`-flattened + replaced messages). FIXED:
   skip Tokzen for tool turns (`wantsTools || hasToolTurns`), as for images.
3. **Structured honesty bug** — `served_level`/`guaranteed` were recomputed from raw
   provider capability, mislabeling a `json_object`→Gemini turn as
   `guaranteed:true`. FIXED: router returns `resolvedStructuredLevel`; engine labels
   from it (`guaranteed = json_schema && valid`).
4. **Repair broke Gemini role-alternation** (consecutive user turns). FIXED: repair
   appends assistant-then-user.
5. **Vision silent failover** — an explicit OpenRouter vision model could fail over
   onto a non-vision free model and re-send images. FIXED: per-model re-filter
   mirroring the tools path.
6. **OpenAI `strict` schema hard-400** on optional fields. FIXED: strict-schema
   normalizer (`additionalProperties:false` + all-required, recursive).
7. **Cache-read replay** dropping tool/structured payloads. FIXED: bypass cache read
   for tool/structured requests.
8. **prompt-level coercion** added; **Gemini `normalizeSchema` over-strip** widened;
   **finish_reason** tool-calls relabel; **`done`-twice** fixed; **CSP fail-closed**;
   **router `redact.ts`** JWT/UUID drift closed; **Ajv cache** bounded; **`loadTools`**
   hardened; **image+tool** drop guard; web-SSE-accumulation + edge-schema tests added.

## 3. Honest 10/10 assessment
- **Tool calling + structured output are now REAL and tested on Web + CLI + gateway
  (BYOK)** — capability-honest (hard-error, never silent-downgrade), multi-turn loop
  works over HTTP, args/results kept out of Tokzen/relay/logs. This closes the
  "biggest gap vs every competitor" from the audit.
- **Multimodal** extends beyond Gemini (OpenRouter vision) honestly.
- **Still NOT 10/10**, by these remaining items (capability/distribution, not bugs):

## 4. Remaining open items
- **[HUMAN] CSP**: relanded but **NOT browser-verified** — must verify against
  `next build && next start` (checklist in `08-review-csp.md`). Not claimed done.
- **Desktop/mobile**: no tool/image **UI** (gateway/CLI only); deferred to the UI
  design phase. Mobile still its own track (80/7), streaming/cleartext/EAS [HUMAN].
- **Desktop** keyring still needs a per-OS Rust build to certify; CLI still Bun-only.
- **Known limitations** (logged, not bugs): tools⊕structured combo drops tool calls
  (rare); strict-422 emitted on the JSON path (streaming computes `valid` correctly);
  Gemini synth tool-call ids reset per stream; `sanitizeForLogs` available but not
  yet wired at a sink (no active leak found).
- **Provider `structuredOutput` levels** are conservative best-effort — re-verify
  before promoting any provider to `json_schema`.

## 5. Verdict
Web (BYOK) + CLI + the local gateway are now a **credible beta+ with tools and
structured output** — the headline capability gaps are closed, verified, and honest.
Desktop, mobile, stores, paid/custody, and in-browser CSP remain gated/[HUMAN].
Not 10/10 across all surfaces; materially closer than the 2026-06-28 baseline.
