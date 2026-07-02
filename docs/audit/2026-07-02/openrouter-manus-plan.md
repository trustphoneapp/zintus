# Zintus E2E Audit + "Next OpenRouter × Manus" Architecture Plan

Date: 2026-07-02. Ground truth: code on `main` + unmerged branches, verified by
reading the repo (not prior docs' claims). External facts: OpenRouter public
docs/press (May 2026: ~8M users, ~100T tokens/mo, $113M Series B @ ~$1.3B;
5.5% credit fee, 5% BYOK fee after 1M req/mo) and Manus public feature pages
(sandboxed browser+terminal+fs, Browser Operator, "My Computer" desktop,
Web App Builder with DB/Stripe/SEO, multi-hour Planner/Executor/Verifier runs).

---

## 1. E2E audit — what Zintus actually is today

~75K LOC non-test TS, 172 test files, 5 surfaces (CLI, web/Next.js 16,
desktop/Tauri, mobile/Expo, gateway/Bun) + 2 Cloudflare workers (relay,
validate-key), 17 packages.

### Grades by plane

| Plane | Grade | Evidence |
|---|---|---|
| **Routing** | **A−** | 12 providers, model groups (same-model cross-provider failover), fastest/economy/capability/weighted/quality strategies, hot-reload `policy.json`, quota ledger (daily + rolling RPM/TPM + in-flight reservation), cooldown/half-open probes, virtual keys, per-model savings estimator. This is genuinely OpenRouter-class *mechanically*. |
| **Agent (CLI)** | **B+** | Single-writer bounded ReAct loop hardened per the 2026-06-29 decision: B1 tokzen context eviction/compaction (wired, `apps/cli` dep), B2 per-call strategy seam (`agent.ts:72-84`), B3 verify→revise gate, B4 edit ladder (`agent-tools.ts:1146+`, unified-diff applier), B5 NOTES.md, B6 repo-map. Deferred: explorer subagent, parallel tool exec, tree-sitter map. |
| **Memory/context** | **A−** | Facts + vectors (sqlite-vec), LLM consolidation, provenance, project scoping, Memory Manager UI (current branch), context-compiler with token budgets, tokzen compression. Differentiated — neither OpenRouter nor most gateways have this. |
| **Tools/exec** | **B** | Tool calling merged; web tool execution merged; artifacts canvas merged; MCP client + gateway MCP bridge; deep research (`/v1/research` SSE). No sandbox, no browser automation, no scheduled/background runs. |
| **Surfaces parity** | **B−** | FEATURE-MATRIX honest and mostly ✅ on web/desktop/CLI. Mobile rich app is UNMERGED (`feat/mobile-serious-app` +7). Voice = ❌ everywhere real. Desktop export unverified in Tauri webview; no native menu; Find is a stub. |
| **Cloud/relay** | **B+** | Outbound-only WebSocket relay (DO hibernation), no inbound ports, secret hashing, magic-link + Google OAuth, CLI `cloud login` / `serve --cloud`. The Claude-Remote-Control security model — rare and valuable. |
| **Prod-readiness** | **B** | Docker non-root, auth-gated status, OTel, DR runbook, OpenAPI, legal docs. Open: [HUMAN] gates below. |

### Debt & gates (blockers before any new lane)

1. **Unmerged branches:** `feat/mobile-serious-app` (+7, the whole serious mobile
   app), `feat/zintus-10-10` (+1), `feat/web-chat-design`,
   `feat/memory-project-picker` (current, memory governance UI),
   `fix/voice-mic-permission`, `ci/bun-install-retry`.
2. **[HUMAN] keyed smokes:** multimodal image e2e (browser→Gemini), CLI
   `zintus research` first keyed run, desktop export on a packaged build.
3. **[HUMAN] distribution:** npm publish (CLI), relay deploy, desktop
   signing/notarization, store assets, real 1024² icon art.
4. Voice STT (deferred), mobile image input (deferred).

---

## 2. Zintus vs OpenRouter — honest comparison

| Dimension | OpenRouter (mid-2026) | Zintus | Verdict |
|---|---|---|---|
| Providers / models | 60+ providers, 400+ models | 12 providers, ~40 models | Their biggest visible lead; mostly *catalog work*, not architecture |
| Routing mechanics | fallbacks, provider prefs, price/latency sort | model groups, 5 strategies, quota-aware economy, policy.json | **Parity, arguably ahead** on quota-awareness |
| Key model | Hosted custody; credits +5.5%; BYOK +5% fee after 1M req | Local-only BYOK, OS keychain, zero fee, no custody | Opposite poles — this is the wedge |
| Billing/marketplace | Core business; pay-per-token resale | None ($-saved estimator instead) | They monetize; we don't (yet) |
| Data moat | Rankings/leaderboards from 100T tokens/mo | Local telemetry only | Their real moat; can't copy, can invert (see §4) |
| End-user product | Thin chatroom; it's an API company | Full chat apps on 4 surfaces + memory + projects + artifacts | **We're ahead** — they don't want this lane |
| Agent | None | Hardened CLI coding agent + tools + research | **We're ahead** |
| Local/self-host | No | Docker one-liner, local-first | **We're ahead** |
| Scale/trust | 8M users, $1.3B | 0 users | The actual gap |

**Read:** Zintus already matches OpenRouter's *router* and beats it on
*product surface*. It loses on catalog breadth, network-effect data, and
distribution. Becoming "the next OpenRouter" by copying them (custody +
resale + % fee) would burn the one positioning they can't attack:
**no-custody, no-fee, self-owned**.

## 3. Zintus vs Manus

| Capability | Manus | Zintus | Gap |
|---|---|---|---|
| Autonomous multi-step agent | Planner/Executor/Verifier, multi-hour | Bounded ReAct + verify→revise (CLI only) | Promote agent out of CLI; longer-horizon loop |
| Sandboxed terminal + fs | Cloud Linux sandbox | `run_command` allowlist on host; Tauri pty exists | Need a real sandbox (container) |
| Browser automation | Browser Operator (your session) + cloud Chromium | web-tools fetch/search only | Biggest missing piece |
| Desktop w/ local access | "My Computer" (Mar 2026) | Tauri app + pty + keychain already shipped | Closest surface to parity |
| App/website builder | Web App Builder (DB, Stripe, SEO) | Artifacts canvas (HTML/preview) | Extend artifacts → scaffold+deploy |
| Deliverables (files/decks/PDF) | Yes | Artifacts + export (partial) | Medium |
| Runs while you're away | Cloud-native | Relay exists (remote control of home gateway!) | Wire agent ↔ relay = "Manus without their cloud" |

---

## 4. Thesis: the self-owned agent platform

OpenRouter routes your tokens and takes a cut. Manus rents you an agent inside
*their* cloud. **Zintus = both planes, on hardware you own: your keys, your
free tiers, your files, your agent — reachable from anywhere via the
outbound-only relay.** Every major asset for this thesis already exists in the
repo; nothing requires abandoning the no-custody bar.

One-line positioning: *"The agent platform you own. OpenRouter-class routing +
Manus-class autonomy, running on your machine, $0 platform fee."*

### Target architecture (planes)

```
Surfaces:   CLI ── Web ── Desktop ── Mobile        (thin clients, parity via FEATURE-MATRIX)
                       │
Access:     Cloudflare relay (outbound-only WS)    ← remote agent control, scheduled kicks
                       │
Runtime:    Gateway (Bun) ─ @zintus/agent runtime  ← NEW: agent loop extracted from CLI
                       │        ├ task queue + checkpoints (resumable, multi-hour)
                       │        ├ verifier gate (deterministic)
                       │        └ tool bus: fs / pty / browser / MCP / search / artifacts
Exec:       Sandbox    ─ container (Docker) or Tauri-pty w/ policy; Playwright browser
Intelligence: Engine → Router (strategies, model groups, quota) → 12→30 providers
State:      keychain · quota.db · memory.db · tokzen CCR · policy.json  (all local)
```

### The inverted data moat

OpenRouter's rankings come from spying 100T tokens/mo. Zintus can ship
**opt-in, anonymized, local-first telemetry** (per-model p95, failure rates,
quota-refill behavior, agent task success) aggregated into a public
`models.zintus.dev` leaderboard — the only rankings sourced from *free-tier,
BYOK, agentic* workloads. Differentiated data OpenRouter structurally can't
collect (their users don't run agents through them locally).

---

## 5. The complete plan

### P0 — Consolidate (week 1): stop the branch bleed
- Merge, in order: `feat/zintus-10-10` → `feat/memory-project-picker` →
  `feat/web-chat-design` → `fix/*` → **`feat/mobile-serious-app`** (rebase, it's 5 days stale).
- Run the two keyed [HUMAN] smokes (image e2e, `zintus research`). 30 min of human time; unblocks two 🟡→✅.
- Tag `v0.9`, publish CLI to npm, deploy relay. Distribution debt compounds; everything in §P2+ is invisible without it.

### P1 — Routing plane to OpenRouter-class breadth (weeks 2–4)
- **Catalog engine, not hand-written adapters:** most of the 12 providers are
  already OpenAI-compat (`openai-compat.ts`). Build a declarative provider
  manifest (base URL, auth header, model list endpoint, quirks) → adding a
  provider becomes a JSON entry + VCR test. Target 30+ providers incl.
  Anthropic/OpenAI/Azure/Bedrock/Together/Novita/SambaNova as **paid-BYOK**
  tiers (economy strategy already prices them).
- **Model catalog auto-sync:** nightly job pulls provider `/models` + pricing;
  stale-model bugs disappear; web Models page becomes a live catalog.
- **`/v1` drop-in guarantee:** contract-test against the OpenAI SDK matrix
  (already have `contracts.test.ts` — extend to tool-calling + vision + JSON
  mode per provider). "Point any OpenAI SDK at localhost:8788" is the adoption funnel.
- **Public leaderboard** (§4 inverted moat), opt-in flag in `policy.json`.

### P2 — Agent runtime extraction (weeks 4–8) ← the pivotal move
- New `packages/agent`: lift `runAgentToolLoop` + B1–B6 out of `apps/cli` into
  a surface-agnostic runtime hosted **in the gateway**. CLI becomes a client of
  it (keep in-process mode for offline).
- Gateway API: `POST /v1/agents` (task), `GET /v1/agents/:id/events` (SSE),
  checkpoint/resume (revive the removed checkpoint store — *now* it has a
  client, so it's no longer YAGNI).
- **Task queue + budgets:** multi-hour tasks with per-task token/tool/$-equiv
  budgets, deterministic verifier gate, pause-on-confirm for mutating ops
  (consent gate pattern already exists on 3 surfaces).
- All four surfaces get "Agent mode" by wiring their existing chat UIs to the
  events stream. Mobile via relay = **kick off a coding task from your phone,
  runs on your Mac, no cloud sandbox rental** — the headline demo.

### P3 — Execution plane: Manus parity where it's cheap (weeks 8–12)
- **Sandbox:** agent `run_command` escalates from allowlist → optional Docker
  sandbox (`zintus agent --sandbox`) reusing the existing Dockerfile base.
- **Browser tool:** Playwright-driven headless Chromium as an agent tool
  (navigate/read/click/extract, screenshot → multimodal path already shipped).
  Desktop "use my real browser session" (Browser-Operator analog) via CDP
  attach — desktop already has the native-shell privileges.
- **Desktop = "My Computer":** pty plugin + keychain + fs already in Tauri;
  expose them as agent tools behind the consent gate. This is weeks, not months.
- **Scheduler:** relay cron → wake home gateway → run saved agent task →
  push result to mobile (relay already does status push).

### P4 — Builder + deliverables (weeks 12–16)
- Artifacts canvas → **project scaffolder**: agent templates (Next.js site,
  Expo app, API) + one-command deploy adapters (Cloudflare/Vercel/Fly). DB +
  payments as template wiring (D1/SQLite, Stripe keys stay user-owned — no
  custody creep).
- Deliverable exports: artifacts → files/PDF/deck (media package exists);
  fix desktop export on packaged build (known gap).
- Voice STT (mobile first — the deferred item) once agent mode lands, since
  "talk a task to your phone, agent runs it at home" is the killer combo.

### P5 — Business model without breaking the bar (parallel, from P1)
- **Open core:** everything local stays free/BUSL. Paid = hosted convenience
  that never touches keys or prompts: relay Pro (multi-device, task history,
  scheduling, **Memory Sync** — see `memory-architecture-review.md`, same dir),
  team policy sync, priority catalog updates. This monetizes the
  *relay* (which you host) not the *tokens* (which you never see) — the exact
  inverse of OpenRouter's 5%.
- Keep publishing the honesty artifacts (FEATURE-MATRIX, savings-as-estimate)
  as marketing — it's the credibility wedge against both incumbents.

### Sequencing logic
P0 is pure debt. P1 is cheap breadth that makes every later demo look serious.
P2 is the strategic pivot — everything Manus-shaped depends on the agent
living in the gateway, not the CLI. P3/P4 stack tools onto that runtime.
Never reorder P2 after P3/P4.

### What to explicitly NOT do
- No key custody, no token resale, no % fee — that's OpenRouter's castle; attacking it head-on requires their capital.
- No proprietary cloud sandbox fleet — that's Manus's castle; the relay-to-home-machine model is the counter, not a clone.
- No multi-writer agent swarms (per the 06-29 decision — evidence still holds).
- No enterprise SSO/RBAC/SOC2 lane until the above ships and pulls demand.
