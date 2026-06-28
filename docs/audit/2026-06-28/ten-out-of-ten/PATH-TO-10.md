# Path to 10/10 — sequenced completion plan

From the 10/10 VERDICT (≈6.5/10 today): the moat + transparency + honesty are 10/10;
the gaps are breadth, cross-platform consistency, and a few table-stakes features.
This sequences the close, codeable-first. Each step: scoped + tested + honesty-held.
Device/cert work stays a parallel [HUMAN] track and does NOT gate the codeable steps.

## Tier A — Consistency (the biggest 10/10 lever: "one Zintus")
**A1. Web structured-output toggle** — mirror the desktop JSON toggle in web chat
(send `response_format`). Closes the web↔desktop inversion + makes the catalog
"JSON" chip reachable. [apps/web chat + chat-client] — SMALL.
**A2. Route-reason on CLI + desktop** — the rule's headline truth is web-only today.
CLI: print route_reason + tokens + cost + quota in chat output (also fix the
fabricated 1,000,000 quota denominator). Desktop: surface route_reason as the
assistant top line (it's in the result/meta already). [apps/cli, apps/desktop] — SMALL/MED.

## Tier B — Breadth (OpenRouter parity)
**B1. More routable models** — register additional verified vision/tool/json models
per provider in the capability allowlists + catalog (research-verified, conservative;
honesty: only what's真 routable). Grow 23→ a credible routable set. [packages/providers] — MED.
**B2. BYOK priority + fallback keys** — replace the "coming soon" stub with real
per-provider key ordering (primary + fallback), used by the router. [keychain, router, web cockpit] — MED.
**B3. Durable activity store** — persist usage history (beyond in-memory traces) so
/v1/activity is a real 30-day feed + a web activity page. [gateway/relay + web] — MED.

## Tier C — Table-stakes features
**C1. Voice input** — Web Speech API dictation on web (and mobile later). The one
feature all three assistants have and Zintus has zero of. [apps/web] — MED.
**C2. Files / documents** — parse PDF/doc to text for context (currently text-only
fold-in). [packages/media or a new parser] — MED.

## Tier D — Depth (pick a lane)
**D1. Agentic** — either a real CLI agent loop (execute tools + apply-diff, not just
print) OR reframe "agentic" as "private local context layer" to stop over-promising.
The verdict prefers honesty: at minimum, make CLI `--tools` EXECUTE (parity with web)
or relabel. [apps/cli] — MED/LARGE.
**D2. Research depth** — multi-pass + cross-verify + structurally-bound citations
(6→8 vs Perplexity). [packages/search] — LARGE.

## Parallel [HUMAN]/device track (never blocks the above)
- **Mobile parity**: rebase `feat/mobile-serious-app` onto this line; bring tools +
  image + route-reason + catalog; `expo/fetch` streaming; EAS/device/store builds.
- Desktop signed/notarized native builds; CSP in-browser verify; legal/store deploy;
  live billing + referral payout path.

## Execution order (codeable loop)
A1 → A2 → B1 → B2 → B3 → C1 → C2 → D1, each committed + verified, cross-checked by a
red/blue debate at the end of each tier. Then re-run the 10/10 benchmark to confirm
the score moved. Honesty + free-core + no-custody hold throughout.
