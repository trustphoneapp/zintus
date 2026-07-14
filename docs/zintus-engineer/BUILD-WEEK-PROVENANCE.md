# Zintus Engineer Build Week provenance

Status: active evidence record

Recorded: 2026-07-14 (America/New_York)

Official eligibility boundary: 2026-07-13 09:00:00 America/Los_Angeles

## Clean event workspace

| Field | Value |
|---|---|
| Worktree | `/Users/yashwanthsurabhi/Projects/zintus-wt-build-week` |
| Branch | `codex/zintus-engineer-build-week` |
| Initial Engineer head | `213e4d0ab9710dd08386a1e2ffad6ea302ceaac5` |
| Status at creation | clean |
| Excluded work | unrelated dirty mobile/root edits in the original worktree |

The event worktree was created directly from the latest audited Engineer commit. It
does not copy or stage the unrelated edits in the original `feat/mobile-ios-polish`
worktree.

## Eligibility boundary

The last ancestor of the initial Engineer head before the official event boundary is:

| Baseline SHA | Commit time | Subject |
|---|---|---|
| `a29a71e8f2f6c7961f54722cb1799f8cee113fa4` | 2026-07-06T23:44:45-04:00 | `feat(mobile): S6 Ionicons for interactive glyphs + JetBrains Mono via expo-font` |

The eligible Engineer series between that baseline and the initial event worktree head
is:

| SHA | Commit time | Subject | Codex task/session |
|---|---|---|---|
| `2f1ad1436e5ca60d6dac662f96ae398eb9daa307` | 2026-07-14T02:33:55-04:00 | `feat(engineer): build phase 1 workflow foundation` | `019f5f44-493f-7b40-8526-947c578ea820` |
| `8182cd89ffdc5b325b376d966e02ca45f6d56e0a` | 2026-07-14T07:57:18-04:00 | `feat(engineer): add phase 2 execution runtime` | `019f5f44-493f-7b40-8526-947c578ea820` |
| `b60a985990f95ab4a07e7441d05548623b50f7b9` | 2026-07-14T10:38:21-04:00 | `feat(engineer): add phase 3 verification and review` | `019f5f44-493f-7b40-8526-947c578ea820` |
| `1eaa7dd658503ccd7b24265b8af01bfdf5b57301` | 2026-07-14T10:58:21-04:00 | `feat(engineer): add phase 4 human control and publication` | `019f5f44-493f-7b40-8526-947c578ea820` |
| `d09da2e550f25fb413bfc611cf077ed0671f4483` | 2026-07-14T11:06:32-04:00 | `feat(engineer): add phase 5 workflow experience` | `019f5f44-493f-7b40-8526-947c578ea820` |
| `cbebc63b228458a30a511765a23d653de918834e` | 2026-07-14T11:13:11-04:00 | `feat(engineer): complete phase 6 hardening and demo` | `019f5f44-493f-7b40-8526-947c578ea820` |
| `2c82dbe4b8ca3dffb64d537a1172bf0fe612e3b9` | 2026-07-14T11:34:12-04:00 | `fix(engineer): harden release authority boundaries` | `019f5f44-493f-7b40-8526-947c578ea820` |
| `213e4d0ab9710dd08386a1e2ffad6ea302ceaac5` | 2026-07-14T11:42:48-04:00 | `fix(engineer): add bounded repair and recovery paths` | `019f5f44-493f-7b40-8526-947c578ea820` |

Measured eligible delta through the initial head: **85 files, 12,321 insertions, 4
deletions**.

## Codex task evidence

| Field | Value |
|---|---|
| Candidate majority-build Codex task | `019f5f44-493f-7b40-8526-947c578ea820` |
| Title | `Build phase 1` |
| Original workspace | `/Users/yashwanthsurabhi/Projects/zintus` |
| Initial prompt | `build this feature in phases start with phase 1 today in loop` |
| Preservation state | pinned in Codex on 2026-07-14; persisted ID rechecked after the TERRA finding |
| Thread metadata source | `/Users/yashwanthsurabhi/.codex/state_5.sqlite` |
| Rollout evidence | `/Users/yashwanthsurabhi/.codex/sessions/2026/07/14/rollout-2026-07-14T02-15-38-019f5f44-493f-7b40-8526-947c578ea820.jsonl` |
| Pin evidence | `/Users/yashwanthsurabhi/.codex/.codex-global-state.json` contains this ID in `pinned-thread-ids` |
| `/feedback` confirmation | pending final submission verification; never fabricate this receipt |

This task contains the phase implementation history, the research/master-plan work,
the independent TERRA/LUNA reviews and the continuing two-task implementation loop.
The Codex task ID is recorded now so the majority-build task cannot be selected
retroactively on submission day. The final `/feedback` action must verify that this
same task resolves and must store the returned confirmation/session identifier.

## Reproduction commands

```bash
git -C /Users/yashwanthsurabhi/Projects/zintus-wt-build-week status --short
git -C /Users/yashwanthsurabhi/Projects/zintus-wt-build-week branch --show-current
git -C /Users/yashwanthsurabhi/Projects/zintus-wt-build-week \
  log --reverse --date=iso-strict --pretty=format:'%H|%cI|%s' \
  a29a71e8f2f6c7961f54722cb1799f8cee113fa4..213e4d0ab9710dd08386a1e2ffad6ea302ceaac5
git -C /Users/yashwanthsurabhi/Projects/zintus-wt-build-week \
  diff --shortstat \
  a29a71e8f2f6c7961f54722cb1799f8cee113fa4..213e4d0ab9710dd08386a1e2ffad6ea302ceaac5
```

## Update rule

Append each later Build Week commit, its task ID, acceptance evidence and audit verdict
to this file. Never rewrite the baseline or remove a failed audit; corrections append
new evidence.
