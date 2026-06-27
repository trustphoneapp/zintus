#!/usr/bin/env bash
#
# Disaster-recovery backup of the Cloudflare relay's durable state.
#
#   D1  -> <out>/d1-zintus-relay-<ts>.sql   schema + data (restorable verbatim)
#   KV  -> <out>/kv-<ts>.json               [{key,value}, ...] for bulk re-put
#
# Durable Objects (GATEWAY_SESSION, QUOTA_COUNTER) are intentionally NOT backed
# up: gateway sessions re-establish on reconnect and quota counters are
# per-period (they self-heal on the next window). Only D1 + KV hold
# non-reconstructable state (users, subscriptions, referrals, auth tokens).
#
# Usage:   scripts/relay-backup.sh [<out-dir>]      (default: ./backup)
# Env:     CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID  (read by wrangler)
#          KV_NAMESPACE_ID, D1_DATABASE                 (optional overrides)
# Needs:   bun (for `bunx wrangler`), jq
#
# Run it from anywhere; it cd's into workers/relay so wrangler resolves
# wrangler.toml. An unrehearsed backup is not a backup — pair with
# scripts/relay-restore-drill.sh (the CI workflow runs both).
set -euo pipefail

OUT="${1:-./backup}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
KV_NAMESPACE_ID="${KV_NAMESPACE_ID:-e37d30031cb2409daa2fd5d44003ec0c}"
D1_DATABASE="${D1_DATABASE:-zintus-relay}"

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }

# Resolve to an absolute out-dir, then cd into the relay so wrangler.toml is found.
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
cd "$(dirname "$0")/../workers/relay"

echo "==> D1 export: $D1_DATABASE -> $OUT/d1-${D1_DATABASE}-${TS}.sql"
bunx wrangler d1 export "$D1_DATABASE" --remote \
  --output "$OUT/d1-${D1_DATABASE}-${TS}.sql"

echo "==> KV dump: namespace $KV_NAMESPACE_ID -> $OUT/kv-${TS}.json"
# One wrangler invocation per key — fine for the relay's modest KV; for a large
# namespace switch to the Cloudflare REST bulk API. Emits one {key,value} object
# per line, then jq -s slurps them into an array ([] when the namespace is empty).
bunx wrangler kv key list --namespace-id "$KV_NAMESPACE_ID" \
  | jq -r '.[].name' \
  | while IFS= read -r key; do
      [ -z "$key" ] && continue
      value="$(bunx wrangler kv key get "$key" --namespace-id "$KV_NAMESPACE_ID" 2>/dev/null || true)"
      jq -cn --arg k "$key" --arg v "$value" '{key:$k, value:$v}'
    done \
  | jq -s '.' > "$OUT/kv-${TS}.json"

echo "==> Backup complete:"
ls -la "$OUT"/*"${TS}"* 2>/dev/null || ls -la "$OUT"
