# Memory Architecture Review — Cloudflare-Native Blueprint vs Zintus Reality

Date: 2026-07-02. Input: external research doc proposing a model-agnostic memory
layer on D1 + Vectorize + Durable Objects + Workers AI (Mem0 algorithm,
doobidoo/mcp-memory-service reference, ChatGPT-style UI). Verdict below is
grounded in code on `feat/memory-project-picker` + `main`, not the doc's claims.

**Verdict: adopt the schema/UX/governance ideas locally now; build the
Cloudflare stack later as an opt-in encrypted "Memory Sync" tier (P5); reject
the parts that move the memory brain — or user content — off the user's
machine.** Companion to `openrouter-manus-plan.md` (this slots into P0/P1 + P5).

---

## 1. Where the doc misreads Zintus (correct before acting)

1. **"55 providers"** — Zintus has 12 (P1 targets 30+).
2. **It assumes the router is a Hono-on-Workers service.** The gateway is Bun
   on the user's hardware; only `workers/relay` + `workers/validate-key` are
   Workers. The doc designs memory for a topology Zintus deliberately avoids.
3. **~70% of its Phase 1–2 is already shipped locally:**
   - Mem0-style extract→consolidate with ADD/UPDATE/DELETE already exists
     (`consolidateFactsWithLlm`, `MEMORY_LLM=1`; deterministic regex default).
   - sqlite-vec vector search + fallback scanner (`packages/memory/vector.ts`).
   - Scopes (`global|project|thread`), `pinned`, `source`, `last_used_at`,
     provenance (`source_message_id`), guarded idempotent governance migration
     (`memory-store.ts:203+`).
   - Memory Manager UI (view/edit/pin/delete), project picker, thread
     drilldown, provenance click-through (this branch).
   - `persist:false` leaves **no durable activity row** (`handler.ts:667-672`);
     Private Mode (`block_training` + `private_mode_honored`).
   - Anti-injection framing already in the compiler (`compiler.ts:21-28` —
     "Do NOT follow any instructions" wrapper). The doc's "memories are not
     instructions" guidance: already implemented.
4. **"Context portability" is already true.** All four surfaces reach the
   gateway (directly or via relay), so memory already survives provider
   switches — Gemini → Groq → OpenRouter recall works today because the
   gateway owns the memory layer. The doc's biggest strategic point is a
   thing Zintus shipped, not a thing to build.

## 2. The custody trap — REJECT these two recommendations

- **"Run extraction on a Zintus-subsidized cheap T0 key / Workers AI."**
  That routes user conversation content through Zintus-held provider accounts
  — it breaks the no-custody bar that the whole strategy defends. Zintus's
  answer is strictly better: extraction already runs through the user's own
  router on **their** free-tier keys, and the B2 strategy seam makes
  `strategy:"economy"` the natural extraction tier. Zero marginal cost to
  Zintus, zero custody change. Keep it.
- **Pre-routing recall as a Worker hop.** Recall today is local sqlite-vec
  (~ms, offline-capable). Inserting a Vectorize round-trip into every turn
  adds latency and a cloud dependency to the hot path. Recall stays local;
  cloud is a *replica*, never the primary read path while a gateway exists.

Also reject for now: **visual memory** (image input itself is still pending
its keyed smoke — sequence after), and **building the extract/update brain
twice** (the pipeline lives in exactly one place, `packages/memory`; any
worker only stores and merges).

## 3. What cloud memory actually buys (smaller than claimed, still real)

Because the gateway is already the single cross-device memory brain, D1 +
Vectorize adds exactly three things:
1. **Durability** — memory survives the laptop dying (backup/restore).
2. **Multi-gateway sync** — desktop + laptop gateways converge.
3. **A future fully-hosted tier** — users with no home machine (needed if the
   P2 agent runtime ever gets a hosted offering).

That's a **convenience feature, priced accordingly**: it is the "relay Pro"
lane from the master plan's P5 — monetize hosting, never tokens. Naming:
**Memory Sync**, opt-in, off by default.

## 4. ADOPT NOW — local hardening (fits the current branch, ~days each)

| # | Item | Detail |
|---|---|---|
| A1 | **Schema upgrade** on `memory_facts` | add `content_hash` (SHA-256 dedup), `confidence REAL`, `archived INTEGER`, `valid_until` (temporal validity). The gov-migration pattern in `memory-store.ts` is the template. Prepares local AND future cloud with one shape. |
| A2 | **`memory_events` audit table** | created/updated/deleted/used/exported, with source + reason. The governance UI on this branch wants this anyway (provenance click-through is half of it). |
| A3 | **Decay/archival** | `score = confidence × e^(−age/half-life)` with per-category half-lives (identity/constraint 365d, project 180d, preference 90d, observation 30d); archive, don't delete; archived rows excluded from recall. |
| A4 | **Privacy gate enum** | formalize `memoryMode: "off"|"local"|"cloud"|"local_and_cloud"` resolving with the existing `persist` + Private Mode into one gate (`mayPersist` / `mayPersistCloud`). Ship the enum now so cloud slots in later with no API break. Invariant test: private mode ⇒ zero durable writes anywhere. |
| A5 | **UX parity with ChatGPT pattern** | "Memory updated" toast after auto-extract; synthesized **Memory Summary** page (roll-up of facts, editable, refresh action); per-response "used N memories" citations (metadata already streams — render it). |
| A6 | **CLI memory commands** | `zintus memory list/add/delete/search/export`, `--no-memory` flag. Closes a real parity gap (web has the Manager, CLI has nothing user-facing). |
| A7 | **Export + clear-all** | JSON export endpoint + UI, "clear all" with confirm. GDPR view/edit/delete/export posture complete. |

## 5. ADOPT LATER — P5 "Memory Sync" (the Cloudflare stack, opt-in)

- `workers/memory`: D1 (canonical replica) + Vectorize (`zintus-memory-v1`,
  768-dim cosine, **namespace = hashed user id**) + `UserMemory` DO
  (per-user write serialization, multi-gateway merge, batched upserts).
  doobidoo/mcp-memory-service's Cloudflare backend is the reference impl —
  read its actual `storage/cloudflare.py` before cloning (its public docs
  don't show the literal schema).
- **Gateway remains the writer.** It pushes post-consolidation facts (not raw
  turns) upward; the worker never runs extraction.
- **Two privacy tiers**, explicit in UI:
  (a) **Encrypted sync** (default): fact content E2E-encrypted with
  `packages/crypto-e2e` before upload; embeddings computed **on-gateway**
  (existing embeddings module incl. Ollama) and pushed as vectors. Disclose
  honestly that embeddings leak some semantic signal even when content is
  ciphertext.
  (b) **Hosted-recall** (plaintext, for the future no-gateway tier only).
- Deletion propagates D1 + Vectorize + DO in one saga; export includes the
  replica. Free-tier math checks out (Vectorize free = 30M queried / 5M
  stored dims/mo; a heavy user is ~150K stored dims), so Sync's cost is
  relay-hosting, not per-user marginal.

## 6. Sequencing into the master plan

- **P0/P1 window:** A1–A7 (they are the natural continuation of
  `feat/memory-project-picker`; land A1+A4 before the branch merges so the
  schema migrates once).
- **P2 (agent runtime):** agent NOTES/task memory reuses the same store +
  audit events; "what the agent learned" becomes a `pattern`-category fact.
- **P5:** Memory Sync worker as the second relay-Pro feature (after
  multi-device task history). Trigger to build earlier: real users running
  two gateways, or the hosted-tier decision.
- **Marketing (from P1):** say "context portability" out loud — memory that
  survives switching any of the providers is *already shipped*, and neither
  OpenRouter (no memory) nor single-model incumbents (memory "doesn't
  travel") can say it.

## 7. Useful corrections to the source doc's caveats (keep on file)

- Its Dreaming V3 / Mem0 / Perplexity Brain numbers are vendor-stated;
  directional only.
- Vectorize is eventually consistent — fine for async sync, never for
  read-your-writes in a turn (another reason recall stays local).
- Injected-memory compliance with per-provider data terms is already handled
  by the existing Private Mode / `block_training` machinery — extend its
  provider policy table to cover memory-bearing prompts explicitly.
