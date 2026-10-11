#!/bin/sh
# Offline backup/restore of the authoritative WAC policy blob.
#
# Requires an authenticated Netlify CLI: run `netlify login` once, or export
# NETLIFY_AUTH_TOKEN. The CLI reads and writes Netlify Blobs directly, so no
# Blobs credentials are embedded in the application.
#
# Usage:
#   scripts/wac-backup.sh backup  [store] [outfile]
#   scripts/wac-backup.sh restore [store] <file>
#
# `store` defaults to `acl`; the `policy` blob holds the authoritative policy.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  wac-backup.sh backup  [store] [outfile]   Export the `policy` blob to a file
  wac-backup.sh restore [store] <file>      Write a snapshot file back to `policy`

Arguments:
  store     Netlify Blobs store name (default: acl)
  outfile   Destination file (default: wac-policy-<timestamp>.json)
  file      Snapshot file to restore (required)

Requires an authenticated Netlify CLI (`netlify login` or NETLIFY_AUTH_TOKEN).
EOF
}

subcommand="${1:-}"
shift || true

case "$subcommand" in
  backup)
    store="${1:-acl}"
    outfile="${2:-wac-policy-$(date +%Y%m%dT%H%M%S).json}"
    netlify blobs:get "${store:-acl}" policy > "${outfile:-wac-policy-$(date +%Y%m%dT%H%M%S).json}"
    echo "wrote ${outfile}"
    ;;
  restore)
    store="${1:-acl}"
    file="${2:-}"
    if [ -z "$file" ]; then
      echo "error: restore requires a snapshot file" >&2
      usage >&2
      exit 1
    fi
    if [ ! -f "$file" ]; then
      echo "error: snapshot file not found: ${file}" >&2
      exit 1
    fi
    netlify blobs:set "${store:-acl}" policy "$(cat "$file")"
    echo "restored policy in store '${store}' from ${file}"
    ;;
  -h | --help | help | "")
    usage
    ;;
  *)
    echo "error: unknown subcommand: ${subcommand}" >&2
    usage >&2
    exit 1
    ;;
esac
