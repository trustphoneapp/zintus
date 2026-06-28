# Phase 0 — Verified Truth Matrix + P0–P3 (Zintus 10/10)

Synthesized from a 6-agent from-disk audit (`phase0/core.md`, `gateway-relay.md`, `web.md`,
`desktop.md`, `mobile.md`, `cli.md`), branch `feat/zintus-10-10`. Benchmark = **OpenRouter**,
not ChatGPT. Legend: ✅ real (code+path) · 🟡 partial · ❌ missing · 🔒 needs human/device/cert
· `–` n/a. Mobile = the serious app on `feat/mobile-serious-app` unless noted (basic app on this
branch). **No marketing claim may exceed this matrix.**

| Capability | Core | Gateway | Relay | Web | Desktop | iOS | Android | CLI |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| chat + streaming | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡¹ | 🟡¹ | ✅ |
| markdown | – | – | – | ✅ | ✅ | ✅ | ✅ | 🟡 term |
| image input | ✅ | ✅ | – | ✅ | ❌ refused | ❌ | ❌ | ✅ `--image` |
| file input | ❌ | ❌ | – | 🟡 text | 🟡 text | ❌ | ❌ | 🟡 |
| voice input | ❌ | ❌ | – | ❌ | ❌ | 🟡 stub | 🟡 stub | – |
| tool calling | ✅ | ✅ | – | ✅ built-in | ✅ built-in | ❌ | ❌ | ✅ `--tools` |
| structured output | ✅ | ✅ | – | ❌ no req UI | 🟡 display | ❌ | ❌ | ❌ |
| deep research | ✅ | ✅ | – | ✅ | ✅ | ✅ | ✅ | 🟡 |
| compare | – | ✅ | – | ✅ | ❌ | ❌ | ❌ | ❌ |
| projects | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ |
| provider keys / BYOK | ✅ | ✅ | – | 🟡 basic | 🔒 build | ✅ | ✅ | ✅ |
| local runtime | ✅ | ✅ | – | 🟡 | ✅ | – | – | 🟡 |
| routing strategies | ✅ | ✅ | – | ✅ | ✅ | 🟡 | 🟡 | ✅ |
| **route reason** | ❌² | 🟡 | – | 🟡 below | 🟡 | ✅ footer | ✅ footer | ❌ |
| quota display | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡³ |
| compression savings | ✅⁴ | ✅ | – | ✅ | ✅ | ✅ | ✅ | 🟡 est |
| usage / activity | 🟡 | 🟡 traces | ✅ data | 🟡 last-5 | ❌ | ❌ | ❌ | ❌ |
| **model catalog** | ❌⁵ | ❌ stub | – | ❌ | ❌ | ❌ | ❌ | ❌ |
| pricing catalog | 🟡⁵ | 🟡 | – | ❌ | ❌ | ❌ | ❌ | ❌ |
| OpenAI-compat API | – | ✅ | – | – | – | – | – | – |
| API docs / activity / key API | – | 🟡 openapi / ❌ /v1/activity / ❌ /v1/key | – | ❌ | – | – | – | – |
| account / auth | – | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ cloud |
| security (no-custody) | ✅ | ✅ | ✅ proven | ✅ | 🔒 build | ✅ | ✅ | ✅ |
| observability | ✅ otel | ✅ | 🟡 | 🟡 | 🟡 | ❌ | ❌ | – |
| billing / paid overflow | – | 🟡 gated | 🟡 gated⁶ | 🟡 gated | 🟡 | ❌ | ❌ | ❌ |
| referral / marketplace | – | – | 🟡 unpayable⁷ | 🟡 gated | ❌ | ❌ | ❌ | ❌ |

¹ mobile streaming uses `getReader()` (no RN polyfill) — overstated until `expo/fetch`.
² the router emits winner + raw attempt trace only, **no human route-reason** (`factory.ts:858`).
³ CLI quota uses a **fabricated 1,000,000 denominator** (`router.ts:21`) — honesty bug.
⁴ Tokzen compression runs at the **gateway** (`compress()`), not core engine/router; "savings" has two
flavors (compression-token savings via `X-Zintus-*` headers vs free-vs-paid ledger) — keep them distinct.
⁵ catalog is **provider-keyed, one default model each** (~13 priced pairs / 12 providers); per-model data
exists only as gating allowlists (`VISION_MODELS`/`TOOL_MODELS`/`JSON_SCHEMA_MODELS`). Not enumerable.
⁶ every paid tier is `managed_keys:true` → checkout **503s** under `MANAGED_KEYS_AVAILABLE=false`.
⁷ referral earnings tracked but **no payout path**.

## False / overstated claims (fix in PR1)
- `/v1/models` presented as an "API" but is a 12-row provider stub (no metadata).
- CLI README leads with `npm install -g zintus` but the binary **can't run under Node** (`bun:sqlite`).
- CLI quota denominator is fabricated (1,000,000).
- Mobile "streaming chat" overstated until `expo/fetch` lands.
- Web "JSON" capability chip is **unreachable** (no structured-output request path).
- `estimateCostUsd` silently returns 0 for routable OpenRouter `:free` failover models.
- Registry framed as "single source of truth" while only covering default models.
- Referral "earnings" with no payout path.

**Honesty wins (keep):** no-custody proven; paid/referral honestly gated ("Coming soon"); vault quota shows "—"; desktop image honestly refused; CLI cloud tri-state.

## Priority (brutal)
**P0 — blocks truth / the OpenRouter-grade core:**
1. **Model-keyed catalog** (capabilities + pricing per-model) + rich **`/v1/models`** — the load-bearing prerequisite for the whole catalog vision. [Phase 1]
2. **Route-reason generation** in the router (a human "why this provider/model") + surface on every platform — required by the consistency rule. [Phase 1, core]
3. **Paid without custody:** add **BYOK-only coordination tiers** decoupled from `managed_keys` so subscription checkout doesn't 503. [Phase 4]
4. **CLI Node packaging** (`bun --compile` binary or Node build) + remove the fake quota denominator + fix the npm README claim. [CLI]
5. **Mobile streaming** `getReader()`→`expo/fetch` + promote/rebase the serious app. [Phase 7, codeable]

**P1 — blocks serious product UX:**
- Models Catalog UI (web→desktop→mobile→CLI `zintus models`). [Phase 2]
- Provider Control Center / BYOK cockpit (prioritized+fallback keys, why-unavailable, best-next-action). [Phase 3]
- Activity/usage history page + **`/v1/activity`** + **`/v1/key`**. [Phase 5]
- Reachable **structured-output request UI** (web/desktop/mobile — today display-only/unreachable).
- Chat UI hierarchy cleanup (route-reason top, export→header, compact menus). [Phase 6]
- CLI/all: surface route-reason + tokens + cost in output.

**P2 — parity / polish:** file input (document blocks), voice input, mobile compare, mobile tool/structured display, desktop native file dialog (🔒 build).

**P3 — growth (gated, last):** referral payout path, node/compute marketplace, custodial managed-keys + credits ledger.

## Notes
- **Device/cert track (🔒, parallel, non-blocking):** desktop native builds + signing/notarization + keyring round-trip; mobile EAS `projectId`/`owner`, Android cleartext, on-device streaming verify; CSP browser-verify; browser/device screenshots.
- **Consistency:** web + iOS + Android share the moat footer concept already (mobile serious app has it); web/desktop must adopt the same route-reason + savings surfacing once route-reason exists in core.
