# Starting an agent session

Paste this at the top of every Claude Code session:

---
Read these first, in order:
1. `docs/agents/RULES.md`
2. The domain doc for this task (see map below)
3. Skim `docs/PRODUCTION-ARCHITECTURE.md`

Then capture the current baseline (it moves as features land):
```bash
bun run test 2>&1 | grep -E "pass|fail"   # this run must not go below it
bun run typecheck                          # must be 0 errors
```

Your task:
[PASTE THE ISSUE HERE]

Rules: read source before writing · run tests after every change ·
one logical change · open a PR, do not merge.
---

## Domain → doc map
| Touching… | Read | Domain |
|---|---|---|
| `packages/{router,tokzen,engine,crypto-e2e,schemas,providers}` | `CORE.md` | CORE |
| `workers/`, `.github/`, `Dockerfile`, `scripts/` | `OPS.md` | OPS |
| `apps/gateway/src` | `GATEWAY.md` | GATEWAY |
| `apps/web` | `WEB.md` | WEB |
| `apps/mobile` | `MOBILE.md` | MOBILE |
| `apps/cli` | `CLI.md` | CLI |
| `apps/desktop` | `DESKTOP.md` | DESKTOP |

(`.github/CODEOWNERS` has the full path map — it's documentation, not an enforced gate.)

## The 3 things agents get wrong most
1. **Trusting a doc over the code.** Every fact here has a `file:line` — re-verify it.
2. **Hardcoding a moving number** (test count, version, deploy id). Use the procedure.
3. **Asserting a status/shape without reading the handler.** Read `handler.ts` / `contracts.test.ts`.
