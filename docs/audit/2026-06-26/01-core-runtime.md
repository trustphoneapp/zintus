# CORE RUNTIME agent report (a3bff9a482da4b416)

## VERDICT: NOT 10/10. Strong honest routing/quota/failover/observability, BUT text-only runtime missing 3 table-stakes (tool calling, multimodal, structured output) + 2 silent-failure honesty gaps. Biggest risk: ZERO tool/function-calling → disqualifying vs ChatGPT/Claude/Gemini/Cursor for agentic.

## P0
- P0-1 No tool/function calling anywhere. RouteRequest/StreamChatOptions/StreamChunk have no tools/tool_choice/tool_calls (types/route.ts, types/stream.ts); no provider sends tools except OpenRouter web_search pseudo-tool (openai-compat.ts:73-88); engine no tool loop. Fix: add tools/tool_choice to request+options, emit tool_calls deltas, role:"tool" turn; OpenAI-compat near-passthrough, Gemini needs functionDeclarations. Risk: schema ripples into cache-key/token-est/memory (all assume string content).
- P0-2 Private Mode silently leaks to "unknown"-training + best-effort training providers, NO signal. trainsOnUserData true only for ===true (data-policies.ts:131-133) → openrouter/deepseek/xai/huggingface (trainsOnData:"unknown", deepseek stored in China) PASS the privacy filter. factory.ts:461-470 keeps training providers when filtering would strand request. No privacyHonored flag in RouteStreamResult/EngineStreamResult. Fix: exclude "unknown" under private + set not-honored result flag surfaces render. Violates no-silent-failure + privacy non-negotiable.

## P1
- P1-1 Default "semantic memory" is keyword-hash not embeddings: OLLAMA_HOST unset (default) → embedBatch returns fallbackEmbedding FNV hash into 256 buckets (embeddings.ts:26-39,88-95); cosine≈token overlap. Marketed as vector/semantic, silent degrade.
- P1-2 Heuristic fact-extraction stores wrong facts: extract.ts:25-40 regex /(?:must|should not|cannot|can't)\s+(.{5,140})/i→constraint. "I can't believe this works"→persistent constraint fact injected into future context (engine.ts getTopFacts), no relevance floor. Deterministic path is DEFAULT.
- P1-3 "capability"/"quality" routing = hardcoded provider opinion not model capability: priority.ts:4-17 CAPABILITY_RANK ranks Groq(10)/Cerebras(9) LAST though both serve Llama-3.3-70B. No data-driven model→capability registry exists.
- P1-4 tokzen ratio scoped to compressed segments only: pipeline.ts:32-44 mergeResults sums transformed segments only; surface showing 1−ratio as whole-request overstates. countTokensFast uses OpenAI gpt-tokenizer for ALL providers (count.ts:2,5) → absolute tokens-saved approximate for Llama/Gemini. (gateway presentation out of scope — VERIFY.)

## P2
- Failed requests still debit daily REQUEST budget (quota-ledger.ts:376-382) despite zero-cost-on-error (tokens correctly zero). Masked by cooldown.
- OTel attempt-span start times synthetic (otel.ts:86-90); latencies real, offsets approx. Export REAL not stub.
- INSERT OR REPLACE INTO memory_chunk_vectors vec0 still at memory-store.ts:542,563 (Linux UNIQUE-constraint risk, unverifiable on macOS).
- No JSON mode/response_format/json_schema anywhere (grep empty).

## MULTIMODAL (role #9)
Today text-only e2e: ChatMessage.content:string (types/route.ts:6), ChatMessageSchema content:z.string(), Gemini parts:[{text}] (gemini.ts:22), openai-compat string messages (:76); cache-key/token-est/memory assume string.
Design: (1) content = string | ContentPart[], ContentPart={type:text}|{type:image,source:{kind,mediaType,data}} — types/route.ts + schemas/index.ts together. (2) NEW providers/capabilities.ts: Record<modelId,{vision,tools,json,contextWindow,audio}>; replace engine.ts:46 window heuristic + priority.ts CAPABILITY_RANK with registry. Among 12 defaults ONLY Gemini gemini-2.5-flash natively vision; xai grok-vision/mistral pixtral/openrouter vision-routes/ollama llava opt-in; groq/cerebras/fireworks/HF Llama + deepseek/cohere text-only. (3) Gemini→inlineData; openai-compat→image_url parts; others reject. (4) Fallback: image present → router filters to vision-capable; forced text-only model → HARD ERROR never silent drop (the FEATURE-MATRIX #24 sin). Touch types/route, schemas/index, providers/capabilities(new), gemini, openai-compat, router/factory(candidate filter), engine(token-est/cache-key).
**docs/multimodal-image-plan.md (cited FEATURE-MATRIX:40,53) DOES NOT EXIST — the "plan" is vapor.**

## LEDGER/QUOTA (role #10)
In-flight reservation CORRECT + race-free: tryReserve (inflight.ts:51-81) synchronous read-decide-increment no await; factory.ts:496 reserves before await. recordUsage(success) (factory:605) before releaseReservation (finally:676) → no undercount (briefly double-counts, conservative). Daily reset UTC-correct (quota-core.ts:30-63). ONE HOLE: output reserved at fixed 1024 (factory.ts:149) or maxTokens; >1024 with no maxTokens under-reserves → concurrent burst overshoots tokensPerMinute cap by (actual−1024)×concurrency before recordUsage corrects. Real for TPM-bound (Cerebras/Mistral/DeepSeek).

## DOC-DRIFT: multimodal-image-plan.md missing; capability/quality presented as context/capability-aware (CHECKLIST:21,FEATURE-MATRIX:22) actually static brand rank; private-mode no not-honored signal; memory hash-fallback presented as semantic (README:327 admits killing a fake semantic cache, same class).

## COMPETITOR GAPS: 1 tool/function calling+MCP (all 4 rivals); 2 vision/multimodal (all 4 even with Gemini key); 3 structured/JSON mode; 4 real per-model capability awareness; 5 structured stream events (tool_calls/citations/usage).

## LIVE SMOKE: openai-compat one key each (openrouter free+429 downgrade, cohere/mistral/deepseek/fireworks/xai/hf/lmstudio) assert stream+real usage chunk+401+429→failover; Gemini SSE+usageMetadata+googleSearch; Groq 70B→8B downgrade+x-ratelimit cooldown; Cerebras+Ollama local; private-mode unknown-only (assert missing signal); concurrent burst N (assert overshoot); cache L1/L2; OTEL endpoint→trace POST.
