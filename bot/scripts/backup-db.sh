#!/usr/bin/env bash
# Online SQLite backup via the .backup API (safe with WAL — do NOT just cp the .db file).
#
# Writes into the same rotation the running bot uses (data/backups, filenames
# salawat-<UTC stamp>.db) and prunes to the same depth, so a manual run before a
# risky change simply joins the rolling set rather than living somewhere else.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load DB_PATH from .env if present (does not override an already-exported DB_PATH).
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a
  # Only pull DB_PATH= lines to avoid sourcing secrets into unrelated vars unnecessarily.
  # shellcheck disable=SC2046
  eval "$(grep -E '^DB_PATH=' .env | sed 's/\r$//' || true)"
  set +a
fi

DB_PATH="${DB_PATH:-./data/salawat.db}"
# Default mirrors getBackupDir() in src/db/backup.ts: a "backups" directory
# alongside the live database file.
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$DB_PATH")/backups}"
# Mirrors BACKUP_KEEP in src/db/backup.ts.
BACKUP_KEEP="${BACKUP_KEEP:-7}"
mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "Database not found at $DB_PATH — nothing to back up." >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 CLI is required (brew install sqlite / apt install sqlite3)." >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$BACKUP_DIR/salawat-$stamp.db"

sqlite3 "$DB_PATH" ".backup '$dest'"
echo "Backup written to $dest"

# Prune to the newest $BACKUP_KEEP. Matching only the rotated filenames leaves
# anything else in the directory alone.
mapfile -t stale < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'salawat-*.db' -print |
    sort -r |
    tail -n "+$((BACKUP_KEEP + 1))"
)
for old in "${stale[@]}"; do
  rm -f -- "$old"
  echo "Pruned old backup $(basename "$old")"
done
