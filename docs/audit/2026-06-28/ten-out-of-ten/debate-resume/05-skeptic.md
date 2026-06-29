# Agent 5 — RED-TEAM SKEPTIC verdict (2026-06-28)

**Honest OVERALL: 7 / 10.** Single biggest blocker: **every flagship capability is
proven only against fakes/mocks — zero live end-to-end runs — and the product is not
even installable today (`zintus` 404s on npm).** A green test suite is not a shipped
product.

I tried to FALSIFY the loudest claims by reading code. The surprising result for a
"10/10 push": **almost everything I attacked is genuinely real and wired** — the agent
sandbox, MCP bridge, gateway server-side tool loop, research citation binding, and
artifacts are real engineering, not stubs. The project is **not** lying about its score
(its own scorecard says 7.5 and flags the [HUMAN] gates). The honest deductions are
about *proof* and *shippability*, not fabrication.

---

## A. Claims I tried to falsify (file:line)

### 1. "MCP everywhere — all four surfaces use them in chat" — REAL, but never run live
- Web wires it end-to-end: `apps/web/app/(app)/chat/page.tsx:27,112,534` builds the
  `mcp` block from stored servers and sends it; parses `mcp_tool_call`/`mcp_tool_result`
  SSE frames (`apps/web/lib/gateway.ts:871,884`).
- Mobile is genuinely wired too: `apps/mobile/app/index.tsx:32` + `lib/messages.ts:175`
  send the same `mcp` block. (PR claim holds.)
- Gateway server-side loop is real and wired into the actual chat handler:
  `apps/gateway/src/handler.ts:882,893,1025,1120-1124` (connect → expose tools →
  filter MCP calls → `executeMcpToolCall`).
- **Falsification:** the loop is only ever exercised against a **FakeClient / fake
  resolver** — `apps/gateway/src/mcp-bridge.test.ts:22` ("A fake MCPClient … no real
  connection"). No test spawns a real stdio/SSE MCP server. The browser/desktop/mobile
  can't host MCP at all (type-only import) and rely on the local gateway. **Never been
  run against a real MCP server.**

### 2. "`zintus agent` — sandboxed coding agent, 26 security tests" — REAL code, NEVER executed live
- The sandbox is genuinely robust: `apps/cli/src/lib/agent-tools.ts:79` `resolveWithinRoot`
  (lexical + symlink-realpath containment), NUL-byte reject `:84`, mutation budget `:238`,
  confirm gate `:245`, unique-match `apply_edit` `:474`. Loop is bounded `:565`.
- Fully wired into the command: `apps/cli/src/commands/agent.ts:169,180-202`
  (`createAppEngine` → `engine.routeAndStream({tools})`).
- **Falsification:** it has never driven a real model. The route handler needs a keyed
  LLM; the scorecard itself admits "live model run = [HUMAN]" (`FINAL-SCORECARD.md:117`).
  So "26 security tests" cover the **sandbox**, not an agent that has ever edited a file
  under model control. Tested ≠ run.

### 3. "Deeper research — cross-verification + structurally-bound citations" — REAL logic, fakes only
- `bindCitations` (`packages/search/src/deep-research.ts:259`) is genuinely structural:
  it parses `[n]` markers, resolves them to concrete sources, and labels
  corroborated/single-source/uncited by **distinct domain count** `:271-277`. Verification
  derives sub-queries from weakly-backed claims `:300`. This is not prompt-theater.
- **Falsification (two layers):** (a) the `[n]` markers themselves are emitted by the
  LLM — the binding *trusts* that `[3]` belongs to that claim; a hallucinated marker
  binds to a real source and is labelled "corroborated." The structure is sound; the
  claim→marker truth is still model-trust. (b) The whole pipeline is tested with
  "deterministic fakes — no live LLM or network" (`deep-research.test.ts:19`). **Never
  run with a real web search or model.** Answer quality is unproven.

### 4. "Artifacts/canvas (web + desktop)" — REAL & wired, CSP not browser-verified
- Wired: `chat/page.tsx:7,279` (`extractArtifacts`) → `ArtifactPanel`. Rendered in a
  `sandbox="allow-scripts"` iframe with NO `allow-same-origin`
  (`apps/web/app/_components/ArtifactPanel.tsx:172`). Reasonable posture.
- **Falsification:** the CSP `frame-src`/iframe interaction is **NOT browser-verified**
  against `next build && next start` (FEATURE-MATRIX §Capability, "NOT yet
  browser-verified"). A recent commit (`69c0741`) was a *fix* to CSP `frame-src` for the
  artifact preview — i.e. it was broken in-browser as recently as the prior PRs.

### 5. "Install: `bun install -g zintus` / zintus@0.2.0" — FALSE in practice
- Hero advertises the command (`FINAL-SCORECARD.md:92`). `npm view zintus` → **404 Not
  Found**. The package is unpublished. **A first-10-minute reviewer copying the homepage
  install command gets nothing.** The "honesty fix" replaced one wrong command (`npm`)
  with another non-working one.

### 6. "~1,400 tests pass (0 fail) across 112 files" — TRUE (and undercounts files)
- I ran the full suite: **~1,413 pass / 0 fail across ~146 files** (30+214+791+49+18+306+5).
  The number is honest; the "112 files" undercounts. Suite is genuinely green. **But see
  the green-by-fake caveat: the integration boundary of every headline feature is mocked.**

### 7. "Structured output + tools across web/desktop/CLI/mobile" — REAL plumbing, BUILT-IN only
- Real, but the web/desktop tool set is **built-in only** (calculator/datetime/random);
  no user-defined-tool UI (FEATURE-MATRIX:124). Honestly captioned.

### 8. "BYOK priority + fallback; durable sqlite activity" — REAL
- These check out as the scorecard describes (`factory.ts` keysFor/walk; `activity-store.ts`
  sqlite+WAL). No falsification.

### 9. "Catalog 37 verified-routable" — HONEST, still « 400+
- SEEDS ≈ 37–41 (`packages/providers/src/catalog.ts:139`). Far below OpenRouter's 400+,
  but the docs say so plainly. No over-claim.

---

## B. Where the project misleads ITSELF (doc rot, both directions)

The docs are unreliable as ground truth — **trust only the code**:

- **FEATURE-MATRIX.md is stale-PESSIMISTIC.** It flags as broken three things that are
  **fixed in code**: desktop keyring #19 (now `invoke("keyring_get")`, service renamed
  `com.zintus.desktop`→`"zintus"` to match the gateway, `src-tauri/src/lib.rs:12,68-71`);
  Private Mode "unknown leak" (router now uses `mayTrainOnUserData` incl. unknown,
  `packages/router/src/factory.ts:588`, with a `privacyHonored` signal `:939`).
- **PR-feat-zintus-10-10.md is stale-OPTIMISTIC** vs its own 7.5 scorecard — title
  "Zintus 10/10", leads with MCP/agent/artifacts as if shipped-and-proven, buries the
  "never run live" reality in "Not in scope."
- **Scorecard citation drift:** A1 cites `chat/page.tsx:221/229/487/1192`, but the live
  file is `apps/web/app/(app)/chat/page.tsx` (62 KB) — the cited path doesn't exist.
  Post-refactor line numbers across the scorecard are unreliable.
- The "two uncopyable 10s" (moat + transparency) are **product-thesis assertions**, not
  proven-in-production facts: referral payouts and managed-key billing are both gated
  OFF, so the business model that the moat implies has moved exactly $0. A local ledger
  is real; an "uncopyable moat" is a bet.

---

## C. What a skeptical reviewer hits in the first 10 minutes

- **CLI:** `bun install -g zintus` → 404. Dead on arrival until published.
- **Agent/MCP/research:** impressive code, but a keyless user gets nothing live; a keyed
  user is the FIRST person ever to run these paths end-to-end (no prior live execution).
- **Web artifacts/PDF/voice:** unverified under the production CSP; recent CSP commits
  suggest in-browser breakage was live very recently.
- **Desktop:** export still unverified in the Tauri webview; no native menu.

---

## D. Fixes

### (a) CODEABLE (no device/cert/biz dependency)
1. **Add one REAL integration test per headline path** behind an opt-in CI lane: spawn a
   tiny real stdio MCP server the test actually connects to (kills the "fake resolver"
   gap), and add a local echo-"LLM" provider that emits a genuine `tool_call` so the
   agent + gateway loops run a real route→execute→feed-back cycle with no external key.
   Converts green-by-fake → green-by-real-loop. Highest-value fix.
2. **Reconcile docs to code:** update FEATURE-MATRIX (#19, Private Mode are fixed), fix
   scorecard citations to `(app)/chat/page.tsx`, and drop the "10/10" framing from the PR
   title to match the honest 7.5/7.
3. **Fix the install lie:** either publish `zintus@0.2.0` to npm, or change the Hero copy
   to the real install path so the homepage doesn't advertise a 404.

### (b) [HUMAN] / device / business — TRUE launch blockers
- **Publish `zintus` to npm** (advertised install fails today).
- **One keyed live run of each flagship path** — agent edit loop, MCP against a real
  server, deep research with web search, image→vision. **Currently zero.**
- In-browser CSP verify (PDF + artifact iframe) on `next build && next start`.
- Live billing + referral payouts (gated off → revenue model unproven).
- Mobile image + voice native modules; EAS/signed builds; signed/notarized desktop.
- Legal / app-store submission.

---

## E. Bottom line

The engineering and self-honesty are genuinely above-average — I could not find a single
**fabricated** feature; the stubs the other agents might fear aren't there. But "10/10
product" means shippable-and-proven, and Zintus's flagship features have **never been run
live** (proven only against mocks), and its headline install command **404s today**. That
is a 7, not a 7.5 and nowhere near a 10. The gap to 10 is not more code — it's *evidence*:
publish the package and produce one real live run of each flagship path.
