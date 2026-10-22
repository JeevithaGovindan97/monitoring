#!/usr/bin/env bash
# Restore a backup produced by the worker (pg_dump custom format, optionally AES-256 encrypted).
#
#   DATABASE_URL=postgres://user:pass@host:5432/dbname \
#   BACKUP_ENCRYPTION_PASSPHRASE=... \
#   scripts/restore.sh /path/to/monitor-2026-01-01T020000Z.dump[.enc]  [--yes]
#
# DESTRUCTIVE: existing objects in the target database are dropped and replaced.
# Stop the api and worker containers first (see docs/BACKUP_RESTORE.md).
set -euo pipefail

file="${1:-}"; yes="${2:-}"
[[ -n "$file" && -f "$file" ]] || { echo "usage: $0 <backup-file> [--yes]" >&2; exit 2; }
[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL is required" >&2; exit 2; }
command -v pg_restore >/dev/null || { echo "pg_restore not found (install postgresql-client)" >&2; exit 2; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
src="$file"
if [[ "$file" == *.enc ]]; then
  [[ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]] || { echo "BACKUP_ENCRYPTION_PASSPHRASE is required for .enc files" >&2; exit 2; }
  command -v openssl >/dev/null || { echo "openssl not found" >&2; exit 2; }
  src="$tmp/restore.dump"
  openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in "$file" -out "$src" \
    || { echo "Decryption failed (wrong passphrase or corrupt file)" >&2; exit 1; }
fi
pg_restore --list "$src" >/dev/null || { echo "Not a valid pg_dump custom-format archive" >&2; exit 1; }

host="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://[^@]*@##')"
if [[ "$yes" != "--yes" ]]; then
  echo "This will REPLACE the contents of: $host"
  read -r -p "Type 'restore' to continue: " ans
  [[ "$ans" == "restore" ]] || { echo "Aborted."; exit 1; }
fi
pg_restore --clean --if-exists --no-owner --single-transaction --dbname "$DATABASE_URL" "$src"
echo "Restore finished. Start the api and workers, then check System health."
