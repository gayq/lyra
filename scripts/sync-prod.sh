#!/usr/bin/env bash

set -euo pipefail

readonly negative_suffix='... /ᐠ - ˕ -マ'
readonly positive_suffix='!! (˵◝ ⩊  ◜˵マ'

fail() {
  printf '%s%s\n' "$1" "$negative_suffix" >&2
  exit 1
}

succeed() {
  printf '%s%s\n' "$1" "$positive_suffix"
}

usage() {
  printf '%s\n' 'usage: git sync-prod [--dry-run]'
  printf '%s\n' '  --dry-run  preview changes without modifying production'
}

if (( $# > 1 )); then
  fail 'too many arguments'
fi

dry_run=0
case "${1:-}" in
  '') ;;
  --dry-run) dry_run=1 ;;
  --help|-h)
    usage
    exit 0
    ;;
  *) fail 'unknown option' ;;
esac

command -v rsync >/dev/null 2>&1 || fail 'rsync is required'

source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)" ||
  fail 'source repository could not be resolved'
ignore_file="$source_root/.syncignore"
destination="${LYRA_PROD_DIR:-}"

if [[ -z "$destination" ]]; then
  destination="$(git -C "$source_root" config --local --get sync.prod-dir 2>/dev/null || true)"
fi

[[ -f "$ignore_file" ]] || fail 'sync exclusions could not be found'
[[ -n "$destination" ]] || fail 'production repository was not configured'
[[ -d "$destination" && -e "$destination/.git" ]] ||
  fail 'production repository was not found'

destination_root="$(cd -- "$destination" && pwd -P)" ||
  fail 'production repository could not be resolved'

[[ "$source_root" != "$destination_root" ]] ||
  fail 'source and production repositories must be different'

case "$destination_root/" in
  "$source_root/"*) fail 'repositories cannot be nested' ;;
esac

case "$source_root/" in
  "$destination_root/"*) fail 'repositories cannot be nested' ;;
esac

rsync_args=(
  -a
  --delete
  --itemize-changes
  "--exclude-from=$ignore_file"
)

if (( dry_run )); then
  rsync_args+=(--dry-run)
fi

if ! rsync "${rsync_args[@]}" -- "$source_root/" "$destination_root/" 2>/dev/null; then
  fail 'production sync failed'
fi

if (( dry_run )); then
  succeed 'sync preview complete'
else
  succeed 'production sync complete'
fi
