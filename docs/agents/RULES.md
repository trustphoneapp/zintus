# Zintus Agent Rules

Read this before every session. It's short on purpose.

## How to read these docs
Facts here carry a `file:line` "source of truth." **Trust the code, not the
doc** — if a fact and the code disagree, the code wins and you fix the doc in
the same PR. Numbers that drift (test counts, deploy ids, versions) are
deliberately written as *procedures* ("run X"), not hardcoded values.

## The 6 golden rules
1. **Never push to `main`.** Branch (`feat/…`), open a PR, let CI run.
2. **Never commit red.** `bun run test` → 0 failures · `bun run typecheck` → 0 errors.
3. **Never write a test that can't fail.** If it passes on broken code, it's not a test.
4. **Never assume a signature.** Read the source file before writing code or tests.
5. **Never silence errors.** No empty `catch`, no swallowed rejections.
6. **Never add a dep blindly.** Prefer what's already in `bun.lock`; check what it pulls in.

## Test baseline (procedure, not a number)
The baseline is **whatever `main` currently passes** — it moves as features land.
Before you start, capture it; your PR must not reduce it:
```bash
git stash -u 2>/dev/null; git switch main; bun run test 2>&1 | grep -E "pass|fail"
git switch -; git stash pop 2>/dev/null
```

## Commit format
`type(scope): description` — types: `feat fix test ci docs chore refactor`
- `feat(router): add weighted strategy tie-break`
- `fix(web): /pricing anchor links break navigation`
- `test(tokzen): quota level boundary cases`

## Branch naming
`feat/… · fix/… · test/… · ci/… · docs/…`

## PR rules
- One logical change per PR.
- Body says: **what, why, how verified.**
- **Squash merge.**
- Don't merge until CI is green. (CODEOWNERS is a *map*, not a required reviewer — see `.github/CODEOWNERS`.)

## Definition of "done"
- [ ] `bun run test` — 0 failures, count not below `main`
- [ ] `bun run typecheck` — 0 errors
- [ ] A real test added for the new behavior
- [ ] PR opened (not merged — that's the human's call)
- [ ] No secrets in logs · no `.skip`/`.only` left in tests

## Where the decisions live
- `docs/agents/CORE.md` — routing, compression, quota, crypto
- `docs/agents/OPS.md` — relay, CI, Docker, deploy
- `docs/agents/GATEWAY.md` — the local API server + response shapes
- `docs/agents/WEB.md` — marketing + dashboard
- `docs/agents/MOBILE.md` · `CLI.md` · `DESKTOP.md`
- `docs/PRODUCTION-ARCHITECTURE.md` — full prod audit
- `docs/TESTING.md` — testing strategy
