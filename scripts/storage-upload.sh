#!/usr/bin/env bash
# Uploads a Claim or Evidence file to the storage service under its sha256
# hash, and prints the hash: the value to record on-chain.
#
# Usage: scripts/storage-upload.sh <file>
# Set STORAGE_URL to use another storage service (see .env.example).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/storage.sh
source "$root/scripts/lib/storage.sh"

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: $(basename "$0") <file>" >&2
  exit 2
fi
file="$1"

hash="$(sha256_of "$file")"
response="$(mktemp)"
trap 'rm -f "$response"' EXIT

status="$(curl -sS -o "$response" -w '%{http_code}' -X PUT \
  -H 'Content-Type: application/octet-stream' \
  --data-binary "@$file" \
  "$STORAGE_URL/content/$hash")"

case "$status" in
  201) echo "stored $file" >&2 ;;
  200) echo "already stored $file" >&2 ;;
  *)
    echo "error: upload failed with HTTP $status: $(cat "$response")" >&2
    exit 1
    ;;
esac

echo "$hash"
