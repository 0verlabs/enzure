#!/usr/bin/env bash
# Downloads a Claim or Evidence item from the storage service by its sha256
# hash and checks that the bytes match the hash. Writes to <output>, or to
# standard output when no output file is given. Nothing is written if the
# bytes don't match.
#
# Usage: scripts/storage-download.sh <hash> [output]
# Set STORAGE_URL to use another storage service (see .env.example).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/storage.sh
source "$root/scripts/lib/storage.sh"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $(basename "$0") <hash> [output]" >&2
  exit 2
fi
hash="$1"
output="${2:-}"

if ! [[ "$hash" =~ ^[0-9a-f]{64}$ ]]; then
  echo "error: '$hash' is not a sha256 hash (64 lowercase hex characters)" >&2
  exit 2
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

status="$(curl -sS -o "$body" -w '%{http_code}' "$STORAGE_URL/content/$hash")"
if [ "$status" != "200" ]; then
  echo "error: download failed with HTTP $status: $(cat "$body")" >&2
  exit 1
fi

actual="$(sha256_of "$body")"
if [ "$actual" != "$hash" ]; then
  echo "error: content does not match its hash: expected $hash, got $actual" >&2
  exit 1
fi

if [ -n "$output" ]; then
  cp "$body" "$output"
  echo "verified $hash, wrote $output" >&2
else
  cat "$body"
  echo "verified $hash" >&2
fi
