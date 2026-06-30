# Artifacts / Canvas

Zintus turns substantial, self-contained blocks of an assistant reply — a full
code file, an HTML page, an SVG, a long document — into **artifacts**: they open
in a dedicated, editable side panel instead of scrolling past inline. This doc
covers the three moving parts: the **tag syntax** the model can emit, the
**identity scheme** that versions an artifact across a conversation, and the
**opt-in flags**.

Detection is pure and DOM-free (`apps/web/lib/artifacts.ts`, unit-tested in
`artifacts.test.ts`). The panel (`ArtifactPanel.tsx`) renders previews in a
sandboxed iframe (`sandbox="allow-scripts"`, **no** `allow-same-origin`).

## Tag syntax (model-declared artifacts)

The model can explicitly mark a deliverable by tagging a fenced block:

````
```artifact id="auth-mw" title="Auth middleware" type="code" lang="ts"
export function authMiddleware() { /* … */ }
```
````

Attributes (all optional except where noted):

| attr    | meaning                                                                    |
| ------- | ------------------------------------------------------------------------- |
| `id`    | **Stable** identity across the conversation. Reuse it to version, not dupe |
| `title` | Display caption + download name. May change between versions               |
| `type`  | `code` \| `html` \| `svg` \| `markdown`. Unknown/omitted ⇒ inferred from body/lang |
| `lang`  | Code language for highlighting + download extension (e.g. `ts`, `py`)      |

Rules:

- Tagged blocks are honoured **first** and **bypass the size heuristic** — an
  8-line tagged config is an artifact.
- Untagged fenced/raw content still falls back to the **size/shape heuristic**
  (code ≥15 non-blank lines or ≥600 chars, full HTML docs, SVGs, long markdown).
- It **degrades gracefully**: a client that doesn't understand the tag renders
  it as an ordinary code block.
- Same `` ``` `` caveat as any fence — a body containing a closing fence ends the
  block early.

## Identity scheme (versioning)

One artifact has a **stable identity** and an ordered list of **versions**. When
the same artifact is re-emitted (or you edit it), a new `vN` is appended instead
of spawning a duplicate. Identity is resolved in priority order:

1. **Declared id** (`id="…"` on the tag) — exact match. Best signal; survives
   any title/body change.
2. **Content similarity** for untagged blocks — same `kind` + a Jaccard
   similarity over character bigrams (≥ 0.5) matches the prior version. This
   means a revised body (e.g. a changed first comment) still folds into the same
   artifact, while two genuinely different untitled blocks stay separate.

Identity is **deterministic and content-derived** — no `Date.now()`, no random
ids. `artifactIdentity()` (the old `kind + normalized(title)` key) is retained
as a `@deprecated` shim for backward compatibility; folding uses the scheme
above.

## Opt-in flags

Everything above is **off by default** — no behaviour change for callers/users
who don't opt in.

- **"Canvas" toggle** in the chat composer writes `localStorage["zintus:artifact-mode"]`
  (off by default), read by `artifactModeEnabled()` in `chat/page.tsx`.
- **Full flag chain (wired end-to-end):** `streamChat({ artifactMode })` →
  `streamGatewayChat` body `artifact_mode` → `ChatCompletionRequestSchema` →
  `apps/gateway/src/handler.ts` (both engine call-sites) → `EngineRouteRequest.artifactMode`
  → `compileContext({ artifactMode })`. When on, the engine appends the
  artifact-authoring instructions to the system prompt (unit-tested).
- **Re-feed** (canvas round-trip): when the toggle is on, the user's *latest*
  artifact version (including local edits) is prepended to the **sent** user
  content as a `user`-role `artifact`-tagged block (the visible bubble stays the
  plain text), so "make the button bigger" edits the version you're looking at —
  not the model's original draft.

## Provenance + cost-per-version (router-native)

Each model-produced version carries `model` / `provider` / `costUsd` from that
turn's `ChatMeta`, threaded through `extractConversationArtifacts`. The panel
shows a per-version badge ("⚡ deepseek-v4-flash · $0.00012") and a cumulative
"total $… · N model versions" chip (`artifactTotalCost`, user edits are free).
This cross-provider cost line is something a single-vendor canvas structurally
won't surface — it's the differentiator the artifact layer previously discarded.

## Inline diff ("Changes")

`lineDiff(before, after)` is a pure, dependency-free LCS line diff (with a coarse
fallback above ~2000×2000 lines); `diffStats` gives the `+N −M` header. The panel's
"Changes" button shows the selected version against the previous one with
add/del/same line styling — the review gate before accepting an edit.

## Re-bake on another model (router-native)

The panel's re-bake bar rebuilds the current artifact on a different provider.
`estimateRebakeCostUsd(content, inputUsdPerMTok)` shows a **"+$X est."** up front
(token count × the target's input rate × an in/out factor) — labelled *est.*
because the true cost is known only after the call. Clicking **Re-bake**
pre-loads the composer with the target model forced + the current version
re-fed + the instruction, and the user confirms with ⏎ — explicit consent before
the spend (the research's hard requirement). The result lands as a new version,
so both the original and the re-bake are kept. Single-vendor canvases can't do
this: no rival model to re-bake on, and no incentive to show the cost delta.

## Consent + per-artifact quota (safety primitive)

`lib/artifact-quota.ts` is the gate the two deferred features need before they can
let model-authored / automated code spend the user's BYOK tokens (cheap-routed
edits, the in-artifact `postMessage` LLM bridge). Pure + unit-tested; it decides
and records, never spends:

- `ArtifactBudget` — a hard `capUsd` + `spentUsd` within a rolling rate window.
- `decideSpend(budget, consent, estUsd, opts)` → `over-cap` / `rate-limited` /
  `no-consent`, or `{ allow, needsConfirm }`. Order: cap → rate → consent; an
  expired window resets the call count; granted consent still confirms above the
  user's auto-approve threshold; a user-initiated, already-confirmed action can
  waive `requireConsent`.
- `applySpend` — post-call ledger update (rolls the window; real cost may differ
  from the estimate).

This contains the prompt-injection / key-drain surface those features open: a
hostile artifact can't spend without consent, can't exceed the cap, and can't
hammer the router.

**Live wiring:** re-bake now goes through `decideSpend` before it runs — the
per-artifact cap + rate are enforced and the estimate is recorded. Budgets and
consent persist per-thread in the store (`artifactBudgets` / `artifactConsents`).

## In-artifact LLM bridge (`window.zintus.complete`)

`lib/artifact-bridge.ts` is the no-custody version of Claude's
`window.claude.complete`: an artifact can ask the router to complete a prompt,
but the BYOK key never enters the frame — the host makes the call and posts the
result back. Pieces (all pure + tested):

- `bridgeShim()` — the `<script>` injected into the artifact `srcDoc` giving it
  `window.zintus.complete(prompt) → Promise<string>` over `postMessage` (no key,
  no network, no origin).
- `isBridgeRequest` / `bridgeReply` — the wire protocol.
- `authorizeBridgeCall(...)` — host-side gate. Because the frame is opaque-origin
  (no `allow-same-origin`), `event.origin` is `"null"` and useless, so it
  authenticates by **source identity** (`event.source === iframe.contentWindow`),
  then gates through `decideSpend` with `requireConsent: true`.

**Not enabled.** The module is the security-reviewed core; attaching the listener
to a live frame and routing to the gateway is a runtime token-spend surface that
stays **off** until explicitly turned on with a consent modal. Nothing spends
through it yet.

## Persistence

User edits live in the conversation store (`apps/web/lib/app-store.ts`),
per-thread, persisted with the threads (key `zintus-chat-threads`). They survive
reload and thread switches. Incognito threads are never written to disk.
