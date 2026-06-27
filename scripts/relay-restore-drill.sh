#!/usr/bin/env bash
#
# Restore DRILL — prove a D1 backup is actually restorable.
#
# Loads the most recent d1-zintus-relay-*.sql dump into a throwaway SQLite file
# and reports table row counts. Touches NOTHING in production and needs no
# Cloudflare credentials — it only reads a local dump. An unrehearsed backup is
# not a backup; the CI workflow runs this on every backup, and you should run it
# by hand before relying on a restore.
#
# Usage:   scripts/relay-restore-drill.sh [<backup-dir>]   (default: ./backup)
# Needs:   sqlite3
#
# A real production restore is a DIFFERENT command (it writes to the live D1) —
# see docs/DR-RUNBOOK.md § Restore. This script never does that.
set -euo pipefail

OUT="${1:-./backup}"
command -v sqlite3 >/dev/null || { echo "error: sqlite3 is required" >&2; exit 1; }

SQL="$(ls -t "$OUT"/d1-zintus-relay-*.sql 2>/dev/null | head -1 || true)"
if [ -z "$SQL" ]; then
  echo "error: no d1-zintus-relay-*.sql dump found in '$OUT'" >&2
  exit 1
fi

SCRATCH_DIR="$(mktemp -d)"
SCRATCH="$SCRATCH_DIR/restore-drill.db"
trap 'rm -rf "$SCRATCH_DIR"' EXIT

echo "==> Restoring latest dump into a scratch DB (production untouched)"
echo "    dump:    $SQL"
echo "    scratch: $SCRATCH"
# Fails the drill (set -e) if the dump is corrupt / not loadable.
sqlite3 "$SCRATCH" < "$SQL"

echo "==> Tables + row counts:"
total_tables=0
sqlite3 "$SCRATCH" \
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;" \
  | while IFS= read -r t; do
      [ -z "$t" ] && continue
      n="$(sqlite3 "$SCRATCH" "SELECT COUNT(*) FROM \"$t\";")"
      printf '   %-20s %s rows\n' "$t" "$n"
    done

# Assert the dump actually contained a schema (a truncated/empty dump must fail).
total_tables="$(sqlite3 "$SCRATCH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';")"
if [ "${total_tables:-0}" -lt 1 ]; then
  echo "error: restored DB has no tables — the dump is empty or corrupt" >&2
  exit 1
fi

echo "==> Restore drill OK — dump loads cleanly with $total_tables table(s)."
