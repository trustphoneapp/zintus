# Zintus — Consolidated [HUMAN] Work (P0–P5)

Everything the autonomous P0→P5 build could NOT do because it needs your
accounts, keys, hardware, or a business decision. Grouped by "do these to ship"
vs "do these to unlock a later phase." Each item says exactly what to run and
how to know it passed.

Code status as of this doc: **main is green** (typecheck 0 errors, full test
suite passing) and is the only branch. Everything below is external work.

---

## A. Ship gate (do first — unlocks a public v0.9)

These four were P0's gate; nothing user-facing is real until they're done.
Full detail + pass criteria: `docs/audit/2026-07-02/p0-human-gate.md`.

1. **Web image e2e smoke** (~10 min) — Gemini key + `bun run dev:gateway` +
   `bun run dev:web`, attach a photo, confirm a real vision answer + no
   `[Image:]` fake. Flips FEATURE-MATRIX #24 to ✅.
2. **CLI research keyed run** (~5 min) — `TAVILY_API_KEY=… zintus research "…"`,
   confirm cited sources. Flips FEATURE-MATRIX #15.
3. ~~npm publish~~ ✅ **DONE 2026-07-02** — `zintus@0.2.0` + 5 `@zintusai/cli-*` platform packages are LIVE on npm; pass check ran (`zintus doctor --json` from a global install, keychain=pass). Remaining optional piece: cut a GitHub release with `apps/cli/dist-bin/*` assets to activate `curl zintus.ai/install \| sh`. Original steps (for future versions): — the CLI now ships as SELF-CONTAINED compiled
   binaries (2026-07-02: `bun build --compile` + embedded keychain addon), so
   end users need no Bun/Node runtime. Name decision (settled
   2026-07-02): main package = **`zintus`** (unscoped name was free); platform
   packages = **`@zintusai/cli-*`** because the `zintus` ORG name was taken
   even though the package name wasn't — create the free `zintusai` org first.
   Steps:
   ```bash
   cd apps/cli && bun run prepare:npm      # builds 5 binaries + stages npm-dist/
   for d in npm-dist/cli-*; do (cd "$d" && npm publish --access public); done
   (cd npm-dist/zintus && npm publish --access public)   # main pkg LAST
   ```
   Pass = `npm i -g zintus && zintus doctor --json` works on a machine with
   only stock Node (verified locally against Node 24 via the simulated
   install). ALSO cut a GitHub release uploading `apps/cli/dist-bin/*` as
   assets (names as-is) — that activates `curl -fsSL zintus.ai/install | sh`
   (`apps/web/public/install`, deployed with the web app).
4. **Relay deploy** (~10 min) — `workers/relay`: create D1 + KV, set secrets,
   `bunx wrangler deploy`. Pass = `zintus cloud login` + a 2-min heartbeat.

After A: tag `v0.9.0`, update FEATURE-MATRIX #15/#24 to ✅.

---

## B. New-provider smokes (P1) — before advertising "22 providers"

The 10 providers added 2026-07-02 (together, sambanova, nvidia, novita,
moonshot, zai, qwen, openai, anthropic, perplexity) are unit-tested through the
OpenAI-compat adapter but **never called live**. For each provider you have a
key for:

```bash
zintus keys set <provider>
zintus --provider <provider> "say hello in one word"
```

Pass = a real completion. Then run the catalog drift check:

```bash
bun run catalog:drift            # keyed providers only; reports stale model ids
```

Known non-smokeable via drift (no `/models` surface): zai, qwen, anthropic,
perplexity — smoke those with a chat call only.

**Nightly drift CI** (`.github/workflows/catalog-drift.yml`) needs repo secrets
added (the workflow lists the exact names) or it just skips every provider.

---

## C. Leaderboard launch (P1 moat) — `docs/LEADERBOARD-DESIGN.md`

- Approve the consent/anonymity design (k≥20, aggregates only). It's a
  public-trust surface — your call, not the model's.
- Register/point `models.zintus.dev` (or pick the URL).
- Build + deploy the relay ingest route (rides the relay from A.4).
- The local export already works: `bun run scripts/leaderboard-export.ts` —
  read its output before enabling any sharing.

---

## D. Agent execution plane (P3) — to actually use sandbox/browser

- **Docker sandbox** (`zintus agent --allow-run --sandbox`): install Docker
  Desktop / a daemon. Pass = a sandboxed `bun test` run completes; the CLI
  preflights `docker info` and errors clearly if absent.
- **Browser tool**: `npm i -D playwright && npx playwright install chromium`
  on the gateway host, then start an agent task with `browse: true`. Without
  Playwright the tool is honestly absent (by design) — no action needed if you
  don't want it. **SSRF-hardened** (2026-07-02): the tool blocks
  private/loopback/link-local/cloud-metadata hosts by default; set
  `browseAllowPrivate: true` per task to reach internal targets. The DNS-
  rebinding residual is CLOSED (2026-07-02): resolve-then-pin (every A/AAAA
  record vetted, fail-closed, vetted IP pinned via Chromium host-resolver-rules)
  + a per-request route guard covering redirects/subresources. Remaining
  accepted residual (documented in `browser-tool.ts`): a redirect target's
  guard lookup and Chromium's connect are two DNS queries.
- **Web Agent toggles** (2026-07-02): the `/agent` page now exposes Docker
  sandbox + browser-tool toggles (sandbox gated on "allow verify commands").
  They only take effect if Docker/Playwright are installed on the host.
- **Resume after restart** (2026-07-02): a gateway that dies mid-task now
  recovers the run as `interrupted` on startup (per-round checkpoints in
  `~/.zintus/agents`) and `POST /v1/agents/:id/resume` continues it from the
  last checkpoint. No human action — noted so you know the "no in-flight
  resume" gap in the audit is now closed.
- **Scheduler** (`docs/SCHEDULER-DESIGN.md`): the D1 schedules table +
  `scheduled()` cron handler + `cloud.ts` run_agent handler are unbuilt; they
  ride the relay deploy. Decide cadence UI (cron string vs presets).

---

## E. Builder + deliverables (P4)

- **Scaffolder deploy**: `zintus scaffold worker-api my-api --deploy cloudflare`
  emits `wrangler.toml`; deploying is `wrangler login && npm run deploy` with
  your account. Same for `--deploy vercel|fly`.
- **Desktop export on a packaged build**: web export works; the desktop
  Blob+`a.download` path is **unverified in the Tauri webview** (may need an
  fs/dialog plugin). Test on a packaged build; wire a plugin if it fails.
- **Voice STT** (deferred feature): add `expo-speech-recognition` to a
  mobile **dev/preview build** (not Expo Go) and verify on a device. The app
  already degrades gracefully ("dictation unavailable") until then.

---

## F. Store / distribution (pre-existing P0 debt)

- **Desktop is now SELF-CONTAINED (2026-07-02)**: the packaged app bundles the
  compiled `zintus` CLI as a Tauri sidecar and starts `zintus serve` itself
  (port-preflight so it never double-starts next to a user-run gateway; kills
  its own child on quit; the gateway parent-watches the app pid and self-exits
  on crash/force-quit). **First packaged build ever ran on 2026-07-02**
  (unsigned `Zintus.app` + `Zintus_0.2.0_aarch64.dmg` on the dev Mac): launch →
  gateway `/health` ok in ~3s → SIGTERM and SIGKILL both leave no orphan.
  The packaged smoke on a CLEAN machine (Gatekeeper path) still needs signing.
- Desktop signing + notarization (Apple Developer / Windows cert).
- Desktop app icons + store assets — see `docs/STORE-READINESS.md`.
- **Mobile (Android + iOS) is now store-shaped** (2026-07-02): real branded
  icon, minimal Android permissions + denylist, iOS privacy manifest,
  contextual notification opt-in, `eas.json` submit block. The full runbook is
  `apps/mobile/STORE-SUBMISSION.md`. Remaining human steps there:
  `eas init` (set `extra.eas.projectId`), preview builds + **one real-device
  smoke** (also proves the doctor "duplicate deps" artifact is harmless),
  store metadata + privacy-policy URL (needs the web `/privacy` deployed),
  production builds + `eas submit`, and the App Privacy / Data-safety
  questionnaires (answer per the no-collection BYOK model the iOS privacy
  manifest already encodes).

---

## G. Business decisions (P5) — `docs/BUSINESS-MODEL.md`

- Final Relay Pro / Team prices + Stripe account (billing is for the relay
  subscription, never inference).
- Whether Memory Sync is Pro-bundled or a separate add-on.
- Trademark/entity for the hosted relay.
- The legal DRAFT privacy/terms pages are `noindex` pending counsel — finalize
  and remove the robots block (`apps/web/app/privacy|terms`).

---

## What the model already shipped (no human needed)

P1 provider manifest (12→22) + capability contract matrix + drift script.
P2 agent runtime extracted to `@zintus/agent`, gateway `/v1/agents` SSE + HTTP
approval gate + web Agent page. P3 Docker-sandbox spawner + browser tool
(graceful absence) + scheduler design. P4 scaffolder + CLI command. P5
business-model + leaderboard + memory-sync + scheduler design docs. All merged
to main, full gate green, on every commit.
