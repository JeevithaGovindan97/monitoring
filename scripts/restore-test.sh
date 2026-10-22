#!/usr/bin/env bash
# Prove a backup is restorable WITHOUT touching production: restore it into a throw-away database
# and compare row counts of key tables.
#
#   ADMIN_DATABASE_URL=postgres://user:pass@host:5432/postgres \
#   BACKUP_ENCRYPTION_PASSPHRASE=... scripts/restore-test.sh /path/to/backup.dump[.enc]
set -euo pipefail
file="${1:-}"
[[ -n "$file" && -f "$file" ]] || { echo "usage: $0 <backup-file>" >&2; exit 2; }
[[ -n "${ADMIN_DATABASE_URL:-}" ]] || { echo "ADMIN_DATABASE_URL (a role allowed to CREATE DATABASE) is required" >&2; exit 2; }

name="restore_test_$(date +%s)"
base="${ADMIN_DATABASE_URL%/*}"
cleanup() { psql "$ADMIN_DATABASE_URL" -qc "DROP DATABASE IF EXISTS $name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
psql "$ADMIN_DATABASE_URL" -qc "CREATE DATABASE $name"
DATABASE_URL="$base/$name" "$(dirname "$0")/restore.sh" "$file" --yes
echo "--- row counts in restored copy ---"
psql "$base/$name" -Atc "select 'users', count(*) from users union all select 'websites', count(*) from websites union all select 'website_checks', count(*) from website_checks union all select 'incidents', count(*) from incidents union all select 'audit_logs', count(*) from audit_logs"
echo "OK: backup restored into temporary database $name (dropped on exit)."
