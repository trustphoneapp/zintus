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
3. **npm publish** (~5 min) — `cd apps/cli && npm publish --access public`
   (dry-run first). Pass = `npx zintus@latest --help` runs. Decide the package
   name if `zintus` is taken.
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
  `browseAllowPrivate: true` per task to reach internal targets. Residual: DNS
  rebinding (a public name resolving to a private IP) needs resolve-then-pin in
  the driver — noted in `browser-tool.ts`, add before exposing browse publicly.
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

- Desktop signing + notarization (Apple Developer / Windows cert).
- Real 1024²-sourced app icons (current ones are small placeholders).
- Store listing assets (screenshots, descriptions) — see `docs/STORE-READINESS.md`.
- Mobile: run the merged serious-app on a device once (union-merged, typechecks
  + unit-tests pass, but hasn't been launched on a simulator/device).

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
