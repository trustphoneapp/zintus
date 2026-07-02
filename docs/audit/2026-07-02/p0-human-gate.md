# P0 Human Gate — the ~30 minutes only you can do

Everything mergeable is merged (main is the only branch; full gate green:
typecheck 0 errors, whole suite passing). These four items need your keys /
accounts. Do them in order; each has a pass criterion — check it off only when
the criterion is met.

## 1. Web image e2e smoke (~10 min) — flips FEATURE-MATRIX #24 🟡→✅

```bash
cd ~/projects/zintus
# Gateway with a Gemini (vision-capable) key present:
zintus keys set gemini   # if not already stored
bun run dev:gateway      # :8788
# In a second terminal:
bun run dev:web          # :3000
```

In the browser: chat → attach a real photo (not a screenshot of text) → ask
"what's in this image?".

**PASS =** the reply describes the actual image content; the response footer
attributes a vision-capable model; DevTools network tab shows the image block in
the POST body (base64, EXIF-stripped) and **no** `[Image:]` placeholder text.
**FAIL modes to watch:** silent text-only fallback (answer ignores the image) or
a 422 `unsupported_capability` with Gemini keyed — both mean file a bug, not ✅.

Then the negative case: force a non-vision provider (e.g. `provider: groq`
with a text-only model) and confirm the **structured 422 + provider
suggestions**, not a fake answer.

## 2. CLI research first keyed run (~5 min) — flips FEATURE-MATRIX #15 🟡→✅

```bash
export TAVILY_API_KEY=...   # or SERPER_API_KEY
zintus research "what changed in bun 1.3" --depth quick
```

**PASS =** completes with cited sources; `--json` variant emits parseable JSON.
Known gap (pre-accepted): no idle watchdog — if an upstream stalls, Ctrl-C is
the recovery. Don't count a stall as a pass.

## 3. npm publish (~5 min)

The CLI package is `zintus@0.2.0`, `bin` wired, `prepublishOnly` builds.

```bash
npm login                          # your npm account
cd ~/projects/zintus/apps/cli
npm publish --access public --dry-run   # inspect the file list first
npm publish --access public
npx zintus@latest --help                # PASS = runs from the registry
```

If the `zintus` name is taken on npm, decide the scope (`@zintus/cli` or a
rename) — that's a naming decision only you can make.

## 4. Relay deploy (~10 min, first time)

`workers/relay` (name `zintus-relay`, DO + D1 + KV). One-time setup comments
are already in `wrangler.toml`:

```bash
cd ~/projects/zintus/workers/relay
bunx wrangler d1 create zintus-relay
bunx wrangler d1 execute zintus-relay --file=schema.sql --remote
bunx wrangler kv namespace create ZINTUS_KV
# paste the printed ids into wrangler.toml, set the custom-domain route,
# set secrets (Resend, Google OAuth) per docs/DEPLOY.md, then:
bunx wrangler deploy
```

**PASS =** `zintus cloud login` completes against the deployed relay and
`zintus serve --cloud` shows a connected session that survives 2+ minutes
(heartbeat working).

---

After all four: update `docs/FEATURE-MATRIX.md` rows #15/#24 to ✅ (cite this
file + date), tag `v0.9.0`, and P0 is closed — P1 (provider manifest → 30+
providers) starts unblocked.
