#!/usr/bin/env bash
# Online SQLite backup via the .backup API (safe with WAL — do NOT just cp the .db file).
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
BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
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
