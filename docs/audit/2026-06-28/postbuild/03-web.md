# POST-BUILD VERIFICATION — apps/web (2026-06-28)

Independent, read-only re-verify of the relanded nonce CSP + new SSE tool-call
parsing on top of `docs/audit/2026-06-28/03-web.md` (web was ~9/10). Source read
only; **NOT browser-verified** — items needing a real browser are flagged [HUMAN].

Scope: `apps/web/lib/gateway.ts` (`streamGatewayChat`), `apps/web/proxy.ts`,
`next.config.ts`, `app/layout.tsx`, `ThemeProvider.tsx`.

---

## 1. SSE tool_calls accumulation — **OK** (correct, crash-safe)

`gateway.ts:583-652`.

- **Index keying — OK.** `Map<number,…>` keyed on `tc.index ?? 0`
  (`:620-628`); fragments for the same call merge, multiple parallel calls stay
  separate. Final emit sorts by index (`:635-636`) — deterministic order.
- **Fragment merge — OK.** `id: tc.id ?? existing.id`, `name: …name ?? existing.name`,
  `args: existing.args + (tc.function?.arguments ?? "")` (`:622-627`). Matches both
  the whole-object Zintus shape and OpenAI's first-delta-has-name / later-deltas-are-args
  fragmentation. `??` (nullish) correctly preserves an earlier id/name when a later
  fragment omits it.
- **Malformed-arg guard — OK.** `JSON.parse` wrapped in try/catch → `{}` on failure
  (`:638-645`); empty/garbled args never throw. Stream-level `chunk.error.message`
  still throws (`:590-592`) as intended.
- **No crash path.** Empty arg string → `{}` (`:640`); missing id → synthesized
  `call_<name>_<index>` (`:648`); `toolCalls` omitted entirely when empty (`:662`).
- **Tools/tool_choice request fields — OK.** Sent as `tools`/`tool_choice`
  (`:527-528`); typed `ToolDefinition[]`/`ToolChoice`. **`response_format` does NOT
  exist anywhere in apps/web** (grep clean) — the scope's "response_format request
  fields" are not present; not a defect, just absent.
- **Low-risk edge (INEFFICIENT/RISK-minor):** an explicit empty-string `function.name`
  fragment would overwrite a prior real name (`""` is non-nullish). Not emitted by
  OpenAI/Zintus adapters in practice; cosmetic at worst.

## 2. CSP correctness — **OK**, one deploy-hygiene **RISK**

- **`'unsafe-eval'` absent in prod — OK / guaranteed by construction.**
  `proxy.ts:53-61`: `IS_DEV ? "'unsafe-eval'" : ""` then `.filter(Boolean)`.
  `IS_DEV = NODE_ENV !== "production"` (`:22`). `next start` sets
  `NODE_ENV=production`, so the term is the empty string and is filtered out. Prod
  script-src = `'self' 'nonce-…' 'strict-dynamic' https:`. Confirmed by source; the
  in-file comment correctly warns to verify against `next build && next start`, not
  `next dev` — **[HUMAN]** confirm the served prod header.
- **Double-CSP-header — OK in current source.** `next.config.ts` `securityHeaders`
  (`:14-26`) carries **no** CSP; CSP has exactly one home (proxy response header,
  `:118`). Request-side `content-security-policy` (`:113`) is only Next's nonce
  channel, not a second enforced policy. No intersection-break.
  - **RISK (deploy hygiene, not source):** the checked-out build artifact
    `apps/web/.next/routes-manifest.json:42` is **stale** — it still bakes the OLD
    static CSP (`script-src 'self' 'unsafe-inline'`) from a pre-reland `next.config`.
    It is git-ignored and `vercel.json` runs `bun run build`, so a real deploy
    rebuilds and the stale CSP disappears. Shipping `.next` WITHOUT a rebuild would
    re-introduce a second `unsafe-inline` CSP. Low real-world risk; flagged so nobody
    deploys a prebuilt `.next`.
- **Static-route nonce staleness — needs [HUMAN].** `layout.tsx:80` reads
  `headers().get("x-nonce")`, opting the tree into dynamic render so the live nonce
  is stamped (not a build-time value); `ThemeProvider`/next-themes receive it
  (`:90`, `ThemeProvider.tsx:13-20`). Next also auto-forces dynamic when a CSP nonce
  is present on the request. Source is correct; **cannot confirm without a browser**
  that every framework `<script>` (incl. any statically-prerendered route) carries
  the per-request nonce and that no `'strict-dynamic'` violation is logged.
- **Report-Only flag — OK.** `CSP_REPORT_ONLY=true` → `…-Report-Only` response name
  (`:88-90`); request still forwards the enforcing name so Next reads the nonce
  (`:113`, comment `:105-110`). Single env flip, no code revert. Correct.

## 3. Dead/fake UI — **OK** (none introduced)

These files add no UI. Honesty note (not a defect): the parsed `toolCalls` return is
**not yet consumed anywhere** — grep finds `toolCalls` only in `gateway.ts`;
`chat-client.ts:58-74` neither passes `tools`/`toolChoice` nor reads `result.toolCalls`.
So this is forward-plumbing, not a button claiming a capability the backend can't
honor. No dead button, no fake render.

## 4. Code-efficiency — **OK / minor**

- `output += delta; onChunk(output)` (`:614-618`) re-sends the cumulative string each
  chunk — pre-existing contract, acceptable.
- tool-call assembly is O(fragments) map writes + one O(n log n) sort over a tiny set
  (`:635-636`) — fine.
- No redundant parses or copies of note.

## 5. Explicitly NOT browser-verified — **[HUMAN]**

1. Prod served header truly lacks `'unsafe-eval'` and equals
   `script-src 'self' 'nonce-…' 'strict-dynamic' https:` under `next build && next start`.
2. Per-request nonce is stamped on framework + next-themes inline scripts on EVERY
   route (incl. prerendered) with **zero** `'strict-dynamic'`/nonce CSP violations in
   the console; no theme FOUC.
3. Exactly ONE CSP response header reaches the browser (no `next.config` duplicate),
   and `CSP_REPORT_ONLY` toggles the header name as expected.
4. End-to-end tool-call round trip is unobservable today (no UI consumer) — defer.

## Coverage gap
No unit test exercises `streamGatewayChat` tool_calls accumulation (no
`apps/web/lib/gateway*.test.ts`; grep for `streamGatewayChat` in tests is empty). The
index-merge / malformed-arg / multi-call paths are unverified by the suite despite
being new, branch-heavy logic. Recommend a small parser unit test.

## Verdict
The tool_calls SSE accumulation is correct and crash-safe; the relanded CSP is
sound in source with `'unsafe-eval'` provably dev-only and a single CSP home. Two
caveats: a stale git-ignored `.next` artifact that must not be deployed un-rebuilt
(RISK), and three CSP behaviors that are correct-by-reading but genuinely require a
browser to confirm. New tool-call plumbing is currently UI-unwired (honest, not dead)
and untested. Holds ~9/10; no honesty regressions.
