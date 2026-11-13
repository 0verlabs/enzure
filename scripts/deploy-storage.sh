#!/usr/bin/env bash
# Deploys the storage service (typescript/apps/storage) to Cloudflare.
#
# Credentials come from the environment: CLOUDFLARE_API_TOKEN and, if the
# token can reach more than one account, CLOUDFLARE_ACCOUNT_ID. Values in the
# repository's .env are used when they aren't already set. Without a token,
# cf falls back to a `cf auth login` session.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$root/.env" ]; then
  for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
    if [ -z "${!name:-}" ]; then
      value="$(sed -n "s/^${name}=//p" "$root/.env" | tail -n 1)"
      if [ -n "$value" ]; then
        export "$name=$value"
      fi
    fi
  done
fi

cd "$root/typescript"
vp install --frozen-lockfile
cd apps/storage
vp exec cf deploy "$@"
