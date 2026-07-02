# Zintus Business Model — open core, never custody (P5)

The one rule every pricing decision obeys: **monetize the hosting you run,
never the tokens you never see.** OpenRouter takes 5–5.5% of inference it
proxies; Manus rents you an agent in its cloud. Zintus's paid surface is the
*convenience* of the relay (which you host on Cloudflare) — the keys, prompts,
files, and agent all stay on the user's machine. That is the position neither
incumbent can attack without abandoning their own model.

## Free forever (local core, BUSL-1.1)

Everything that runs on the user's hardware:

- The router (22 providers, all strategies, quota ledger, policy.json).
- The gateway + engine, memory system, context compiler, Tokzen compression.
- The agent runtime (`@zintus/agent`) — CLI in-process AND gateway `/v1/agents`,
  including the Docker sandbox and browser tool.
- All four client surfaces (CLI, web, desktop, mobile) talking to a local or
  self-deployed gateway/relay.
- Self-hosting the relay yourself (the worker is in the repo).

No feature that touches keys or prompt content is ever paywalled.

## Paid: Relay Pro (hosted convenience only)

A Zintus-operated relay instance, so the user doesn't run their own Cloudflare
account. What it sells is *operational*, and provably key-blind (the relay only
ever holds a hashed gateway secret + short-lived relay tokens — see
`workers/relay`):

| Tier | Price (indicative) | What it hosts (never tokens) |
|---|---|---|
| **Free relay** | $0 | Single device ↔ home gateway, ephemeral, no history. |
| **Relay Pro** | ~$8/mo | Multi-device, **task history** for `/v1/agents` runs, **scheduled tasks** (`docs/SCHEDULER-DESIGN.md`), push notifications, longer session retention. |
| **Team** | ~$20/user/mo | Shared **policy.json sync**, org member management, audit of who-ran-what (metadata only), priority catalog updates. |

Add-ons that stay key-blind:

- **Memory Sync** (`docs/memory-architecture-review.md`): E2E-encrypted
  cross-device memory replica. Bundled into Pro.
- **Community leaderboard** (`docs/LEADERBOARD-DESIGN.md`): free to read,
  opt-in to contribute; not a paid feature — it's the marketing moat.

## Why this can't be undercut

- **vs OpenRouter:** they'd have to give up the % inference fee to match "$0
  platform fee, your keys." Their $1.3B is built on that fee.
- **vs Manus:** they'd have to give up the cloud sandbox rental to match "runs
  on your machine, reachable from your phone." The relay-to-home model is the
  structural counter.
- **Credibility:** the honesty artifacts (FEATURE-MATRIX, savings-as-estimate,
  the "not yet keyed-smoked" labels) are the trust wedge — publish them.

## Explicit anti-goals (things we will NOT sell)

- Key custody / a hosted inference proxy / any per-token or % fee.
- A proprietary cloud sandbox fleet.
- Multi-writer agent swarms (per the 2026-06-29 agent decision).
- Enterprise SSO/RBAC/SOC2 until the above pulls real demand (that's the
  LiteLLM/Portkey lane the README already cedes).

## [HUMAN] decisions

- Final prices + billing provider (Stripe keys stay yours; billing is for the
  relay subscription, not inference).
- Whether Memory Sync is Pro-bundled or a separate add-on.
- Trademark/entity for the hosted relay offering.
