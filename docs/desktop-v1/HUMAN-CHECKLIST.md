# Zintus Desktop v1 — [HUMAN] launch checklist

Everything on `feat/desktop-v1` is code-complete and verified as far as a
machine with no provider keys can verify. The items below are the ONLY things
between this branch and a live v1 — all of them need accounts/keys/money that
only you hold. Ordered: do them top to bottom.

## 1. Membership goes live (relay)

- [ ] **Operator provider keys → Cloudflare secrets** (these serve members'
      chats; never exposed to clients):
      ```
      cd workers/relay
      bunx wrangler secret put MANAGED_KEY_GROQ
      bunx wrangler secret put MANAGED_KEY_CEREBRAS
      bunx wrangler secret put MANAGED_KEY_OPENAI      # optional
      bunx wrangler secret put MANAGED_KEY_DEEPSEEK    # optional
      bunx wrangler secret put MANAGED_KEY_MOONSHOT    # optional
      ```
      Only models whose key is set are listed/served (`/v1/managed/models`
      is honest by construction). Groq alone lights up 2 models; +Cerebras
      adds 70B failover.
- [ ] **Stripe**: create the 4 products/prices (Starter $15 / Growth $49 /
      Scale $99 / Pro $199 monthly), then replace the `price_FILL_FROM_STRIPE`
      placeholders in `workers/relay/src/tiers.ts` → `STRIPE_PRICES`.
      Set secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; point the
      Stripe webhook at `https://relay.zintus.ai/api/billing/webhook`.
      Until this lands, checkout 503s with an honest
      `billing_not_configured` (the desktop shows the message verbatim).
- [ ] **Deploy the relay**: `cd workers/relay && bun run deploy`
      (D1 schema: `bun run db:init` if the prod DB is fresh).
- [ ] **Keyed smoke** (5 min): sign in from the desktop Models page →
      subscribe with a Stripe test card → pick a managed model → send a chat
      → confirm the reply streams and the receipt shows `plan −N tok`, and
      `/api/usage/current` increments.

## 2. Desktop chat smoke (BYOK path)

- [ ] On a machine with at least one provider key (or Ollama running):
      send one chat turn and confirm streaming + the $-receipt. The no-key
      path was verified end-to-end (send → consent → route → honest
      "No providers available" bubble); the keyed happy path needs a key.

## 3. Release signing + distribution (per-OS)

- [ ] **macOS**: Developer ID cert + notarization (`APPLE_CERTIFICATE*`,
      `APPLE_ID`, `APPLE_TEAM_ID` secrets in the repo for
      `release-desktop.yml`).
- [ ] **Windows**: code-signing cert (OV at minimum; EV kills SmartScreen
      warnings fastest). Unsigned builds get blocked — don't ship one.
- [ ] **Linux**: no signing needed; AppImage/deb come out of the same CI run.
- [ ] Tag a release (`git tag desktop-v0.3.0 && git push --tags`) —
      `release-desktop.yml` builds macOS(arm+x64)/Windows/Linux.

## 4. Update feed

- [ ] Host `latest.json` at `https://releases.zintus.ai/desktop/latest.json`:
      ```json
      { "version": "0.3.0", "url": "https://github.com/…/releases/latest", "notes": "…" }
      ```
      The in-app "Check for updates" (Settings) reads exactly this. Silent
      auto-update (tauri-plugin-updater) is deliberately NOT wired — add it
      only together with updater signing keys (see the lib.rs note; an
      unconfigured updater plugin panics packaged builds).

## 5. Small web-side alignments (optional, recommended)

- [ ] `apps/web/app/pricing`: it already sells 1M/10M/50M/200M — now truly
      backed by relay TIERS (this branch aligned them). Flip any
      "coming soon" copy for managed tiers once §1 is done.
- [ ] `https://www.zintus.ai/help` exists (the desktop account menu links to
      it).

## What was verified without you

- 235 relay tests + 117 desktop lib tests green; typecheck clean everywhere;
  production `next build` (12 routes) + `cargo check` + packaged tauri build.
- CDP browser verification per slice: Models directory + Zintus panel + dock,
  light/dark themes, ⌘K palette, composer abilities/pills/estimate, sidebar
  ⋯/pin/account menu, Settings v2, and a real gateway round-trip on /chat.
