# Relay Disaster-Recovery & Rollback Runbook

How the Cloudflare **relay** control-plane is backed up, how to restore it, and
how to roll back a bad deploy. Closes the 2026-06-26 audit P0 ("no backup /
restore drill") and P1 ("no rollback runbook").

> Scope: the relay is the only stateful Zintus surface. The BYOK gateway is
> stateless (local SQLite the user owns) and the web app is stateless (Vercel).
> So DR == **D1 + KV** of `zintus-relay`.

## What is (and isn't) backed up

| Store | Backed up? | Why |
|---|---|---|
| **D1 `zintus-relay`** | ✅ daily | Non-reconstructable: `zintus_users`, `subscriptions`, `referrals`, `referral_codes`, `auth_tokens`, `user_sessions`, `usage_log` |
| **KV namespace** | ✅ daily | `referral_code:*` maps + rate-limit counters |
| **DO `GATEWAY_SESSION`** | ❌ | Ephemeral — re-establishes on the next gateway reconnect |
| **DO `QUOTA_COUNTER`** | ❌ | Per-period counter — self-heals on the next quota window |

## Schedule & storage

- **Workflow:** [`.github/workflows/backup-relay.yml`](../.github/workflows/backup-relay.yml)
  runs daily at **04:17 UTC** (and on-demand via *Run workflow*).
- Each run: D1 export (`scripts/relay-backup.sh`) → KV dump → **restore drill**
  (`scripts/relay-restore-drill.sh`, loads the fresh dump into a scratch SQLite
  and asserts tables/rows) → uploads a `relay-backup-<run_id>` **artifact
  (90-day retention)**.
- **[HUMAN] one-time secrets** (Settings → Secrets and variables → Actions):
  `CLOUDFLARE_API_TOKEN` (scoped `D1:Read` + `Workers KV Storage:Read`) and
  `CLOUDFLARE_ACCOUNT_ID`. Without them the job no-ops with a warning.
- **Retention note:** 90-day GitHub artifacts are the floor. For longer/RPO-critical
  retention, add an R2 (or S3) upload step and/or enable **Cloudflare D1 Time
  Travel** (point-in-time restore up to 30 days) as a second, platform-native line
  of defense.

## Manual backup

```bash
export CLOUDFLARE_API_TOKEN=...   CLOUDFLARE_ACCOUNT_ID=...
bash scripts/relay-backup.sh ./backup
# -> ./backup/d1-zintus-relay-<ts>.sql  +  ./backup/kv-<ts>.json
```

## Restore drill (safe — run monthly)

```bash
bash scripts/relay-restore-drill.sh ./backup
```

Loads the newest D1 dump into a throwaway SQLite file and prints row counts.
**Production is never touched** and no Cloudflare creds are needed. CI runs this
on every backup; do it by hand before you ever trust a restore.

## Restore (production — destructive; deliberate, not automated)

> ⚠️ This writes to the live D1. Confirm the dump first with the drill above.
> Prefer **D1 Time Travel** for accidental-write recovery; use a dump restore for
> a full rebuild / new-account migration.

```bash
cd workers/relay
# 1. (Full rebuild only) recreate the DB if it's gone:
#      bunx wrangler d1 create zintus-relay   # paste the new id into wrangler.toml
# 2. Restore schema + data from the chosen dump:
bunx wrangler d1 execute zintus-relay --remote --file ../../backup/d1-zintus-relay-<ts>.sql
# 3. Restore KV (bulk put expects [{key,value}], which kv-<ts>.json already is):
bunx wrangler kv bulk put ../../backup/kv-<ts>.json --namespace-id e37d30031cb2409daa2fd5d44003ec0c
# 4. Verify:
curl -fsS https://relay.zintus.ai/health | jq .
```

Cloudflare **D1 Time Travel** (no dump needed, ≤30 days):

```bash
bunx wrangler d1 time-travel info zintus-relay
bunx wrangler d1 time-travel restore zintus-relay --timestamp <ISO-8601>
```

## Rollback a bad relay deploy

`wrangler deploy` keeps prior versions; roll back without a rebuild:

```bash
cd workers/relay
bunx wrangler deployments list                 # find the last-good version id
bunx wrangler rollback [<version-id>]           # omit id to roll back one
curl -fsS https://relay.zintus.ai/health | jq .  # confirm "ok": true
```

If a bad **migration** shipped (schema change), a code rollback alone won't undo
it — restore D1 from the pre-deploy backup (above) or Time-Travel to just before
the deploy, then roll the code back.

## Targets (proposed SLO)

- Relay `/health` availability **99.9%**; error rate **< 1%**; p95 **< 2 s**
  (already enforced in CI by the k6 load smoke).
- **RPO ≤ 24 h** (daily backup) — tighten to hours by adding more-frequent
  D1 exports or relying on Time Travel for sub-day recovery.
- **RTO:** D1 restore + KV bulk-put + deploy verify is minutes for a known dump.
